import worker, { Hub } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f() };
let hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r) => hub.fetch(r) }) } };
const call = async (method, path, body, key = "abc") => {
  const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: key ? { "X-API-Key": key } : {} }), env);
  return `${r.status} ${await r.text()}`;
};
console.log(await call("GET", "/api/health", null, null));
console.log(await call("PUT", "/api/position", { latitude: 47.4, longitude: 8.5, altitude_ft: 5000, callsign: "T1" }));
console.log(await call("PUT", "/api/flightplan", { departure_airport: "LSZH" }));
console.log((await call("GET", "/api/traffic?lat=47&lon=8&radius_miles=100")).slice(0, 160));
console.log(await call("GET", "/api/traffic", null, null));
console.log(await call("DELETE", "/api/position"));
console.log(await call("GET", "/api/health", null, null));
console.log(await call("GET", "/api/stats", null, null));
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "secretkey");
const r = await worker.fetch(new Request("https://x/api/debug?key=secretkey"), env); console.log(r.status, (await r.text()).slice(0, 140));
const r2 = await worker.fetch(new Request("https://x/api/debug"), env); console.log(r2.status);

// restart simulation: plan must survive
await call("PUT", "/api/flightplan", { departure_airport: "SBBR" }, "pk");
hub = new Hub(ctx);
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "pk");
const r3 = await worker.fetch(new Request("https://x/api/debug?key=pk"), env); console.log("after restart:", (await r3.text()).includes("SBBR"));
await call("PUT", "/api/flightplan", { callsign: "PEDRO1", departure_airport: "SBBR", cruise_altitude: 35000 }, "cs");
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "cs");
console.log("callsign test:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"callsign":"PEDRO1"'));

// squawk assignment
const tr = JSON.parse((await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50", null, "cs")).slice(4));
const target = tr.aircraft.find(a => a.callsign === "PEDRO1").icao_address;
console.log("assign:", await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "2314" }, "atc"));
console.log("bad:", (await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "7700" }, "atc")).slice(0, 3));
console.log("auto:", await call("PUT", "/api/atc/squawk", { icao_address: target }, "atc"));
await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "2314" }, "atc");
console.log("in traffic:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"assigned_squawk":"2314"'));
hub = new Hub(ctx);
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "cs");
console.log("after restart:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"assigned_squawk":"2314"'));
console.log("unknown:", (await call("PUT", "/api/atc/squawk", { icao_address: "FFFFFF", squawk: "2000" }, "atc")).slice(0, 3));
for (const [k, cs] of [["t1", "ATC-SBBR"], ["t2", "twr sbbr"], ["t3", "TWR_SBGL"], ["t4", "ATCSBBR"], ["t5", "PEDRO1"]]) {
  await call("PUT", "/api/flightplan", { callsign: cs }, k);
  await call("PUT", "/api/position", { latitude: 5, longitude: 5 }, k);
}
const nt = JSON.parse((await call("GET", "/api/traffic?lat=5&lon=5&radius_miles=10")).slice(4));
console.log("callsigns:", nt.aircraft.map(a => a.callsign).join(" "));

// tower fields for controllers who use a TWR- callsign (the app refuses ATC_)
await call("PUT", "/api/flightplan", { callsign: "TWR-SBGL" }, "twrpilot");
await call("PUT", "/api/position", { latitude: -15.8, longitude: -47.9, airplane_model: "B777", airplane_livery: "Delta" }, "twrpilot");
await call("PUT", "/api/flightplan", { callsign: "PEDRO9" }, "plain");
await call("PUT", "/api/position", { latitude: -15.8, longitude: -47.9, airplane_model: "B738", airplane_livery: "Gol" }, "plain");
const cl = JSON.parse((await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).slice(4)).aircraft;
const show = n => { const a = cl.find(x => x.callsign === n); return a ? `${n}: model=${JSON.stringify(a.airplane_model)} livery=${JSON.stringify(a.airplane_livery)}` : n + " missing"; };
console.log(show("ATC_SBGL")); console.log(show("PEDRO9"));

// virtual towers
console.log("tower put:", await call("PUT", "/api/atc/tower", { name: "sbbr", latitude: -15.871, longitude: -47.919 }, "ctl"));
console.log("tower bad:", (await call("PUT", "/api/atc/tower", { name: "x", latitude: 999, longitude: 0 }, "ctl")).slice(0, 3));
let tw = JSON.parse((await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).slice(4)).aircraft.find(a => a.callsign === "ATC_SBBR");
console.log("tower in traffic:", !!tw, tw && tw.virtual_tower, "model=" + (tw && tw.airplane_model), "livery=" + (tw && tw.airplane_livery));
console.log("tower far away hidden:", !(await call("GET", "/api/traffic?lat=40&lon=10&radius_miles=50")).includes("ATC_SBBR"));
hub = new Hub(ctx); await new Promise(r => setTimeout(r, 0));   // mock does not block like the real DO
console.log("tower survives restart:", (await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).includes("ATC_SBBR"));
console.log("tower delete:", await call("DELETE", "/api/atc/tower?name=sbbr", null, "ctl"));
console.log("tower gone:", !(await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).includes("ATC_SBBR"));

// ATC messages (stage 3)
const ok = (name, v) => console.log("msg " + name + ":", v ? "PASS" : "FAIL");
await call("PUT", "/api/flightplan", { callsign: "MSG1" }, "mp");
await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "mp");
await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "other");
const mtr = JSON.parse((await call("GET", "/api/traffic?lat=10&lon=10&radius_miles=50")).slice(4)).aircraft;
const micao = mtr.find(a => a.callsign === "MSG1").icao_address;
const sent = JSON.parse((await call("PUT", "/api/atc/message", { icao_address: micao, text: "Descend FL100" }, "ctl")).slice(4));
ok("send", sent.success && sent.id);
ok("unknown aircraft 404", (await call("PUT", "/api/atc/message", { icao_address: "FFFFFF", text: "x" }, "ctl")).startsWith("404"));
ok("empty 400", (await call("PUT", "/api/atc/message", { icao_address: micao, text: "  " }, "ctl")).startsWith("400"));
const status = async () => JSON.parse((await call("GET", "/api/traffic?lat=10&lon=10&radius_miles=50")).slice(4)).atc_messages.find(m => m.id === sent.id).status;
ok("status sent", await status() === "sent");
const otherResp = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "other")).slice(4));
ok("other pilot gets nothing", otherResp.messages.length === 0);
const p1 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "mp")).slice(4));
ok("pilot gets message", p1.messages.length === 1 && p1.messages[0].text === "Descend FL100" && p1.messages[0].id === sent.id);
ok("status delivered", await status() === "delivered");
const p2 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "mp")).slice(4));
ok("not delivered twice", p2.messages.length === 0);
ok("other pilot cannot reply", (await call("PUT", "/api/messages/reply", { id: sent.id, reply: "wilco" }, "other")).startsWith("404"));
ok("bad reply 400", (await call("PUT", "/api/messages/reply", { id: sent.id, reply: "maybe" }, "mp")).startsWith("400"));
ok("wilco", (await call("PUT", "/api/messages/reply", { id: sent.id, reply: "wilco" }, "mp")).startsWith("200") && await status() === "wilco");
// squawk assignment also creates a message
await call("PUT", "/api/atc/squawk", { icao_address: micao, squawk: "4321" }, "ctl");
const p3 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "mp")).slice(4));
ok("squawk message", p3.messages.length === 1 && p3.messages[0].text === "Squawk 4321" && p3.messages[0].kind === "squawk");
ok("squawk not urgent", p3.messages[0].urgent === false);
// urgent flag
await call("PUT", "/api/atc/message", { icao_address: micao, text: "Traffic!", urgent: true }, "ctl");
const p4 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10 }, "mp")).slice(4));
ok("urgent flag delivered", p4.messages.length === 1 && p4.messages[0].urgent === true);
const trf = JSON.parse((await call("GET", "/api/traffic?lat=10&lon=10&radius_miles=50")).slice(4)).atc_messages;
ok("urgent in traffic", trf.some(m => m.text === "Traffic!" && m.urgent === true) && trf.find(m => m.id === sent.id).urgent === false);

// auto-ATC requests
await call("PUT", "/api/flightplan", { callsign: "REQ1", departure_airport: "SBBR", departure_runway: "29L", arrival_airport: "SBGR", arrival_runway: "9R" }, "rq1");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "rq1");
await call("PUT", "/api/flightplan", { callsign: "REQ2", departure_airport: "SBBR", departure_runway: "29L" }, "rq2");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "rq2");
const rq = async (k, b) => { const r = await call("PUT", "/api/atc/request", b, k); return [r.slice(0, 3), r.length > 4 ? JSON.parse(r.slice(4)) : {}]; };
ok("req bad type 400", (await rq("rq1", { type: "fly" }))[0] === "400");
ok("req no flight 404", (await rq("nobody", { type: "taxi" }))[0] === "404");
let [, t1] = await rq("rq1", { type: "taxi" });
ok("taxi text", t1.mode === "auto" && t1.messages[0].text === "Taxi to runway 29L, hold short");
await new Promise(r => setTimeout(r, 2100));
let [, t2] = await rq("rq1", { type: "takeoff", lang: "pt" });
ok("takeoff pt", t2.messages[0].text === "Pista 29L, autorizado a decolar");
ok("rate limit 429", (await rq("rq1", { type: "taxi" }))[0] === "429");
await new Promise(r => setTimeout(r, 2100));
let [, t3] = await rq("rq2", { type: "takeoff" });
ok("runway busy", t3.messages[0].text === "Hold position, runway 29L occupied");
ok("auto message not redelivered", JSON.parse((await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "rq1")).slice(4)).messages.length === 0);
// runway from request body, 9R normalised to 09R, plan has arrival_runway so plan wins
await new Promise(r => setTimeout(r, 2100));
let [, t4] = await rq("rq1", { type: "land" });
ok("land uses plan runway", t4.messages[0].text === "Runway 09R, cleared to land");
await call("PUT", "/api/flightplan", { callsign: "REQ3" }, "rq3");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "rq3");
let [, t5] = await rq("rq3", { type: "takeoff", runway: "11r" });
ok("runway from body", t5.messages[0].text === "Runway 11R, cleared for takeoff");
let [, t6] = await rq("rq3", { type: "taxi", runway: "99" }).catch(() => [0, {}]);
// human tower wins
await call("PUT", "/api/atc/tower", { name: "SBBR", latitude: -15.871, longitude: -47.919 }, "ctl");
await new Promise(r => setTimeout(r, 2100));
let [, t7] = await rq("rq3", { type: "taxi" });
ok("tower takes request", t7.mode === "controller");
const rqm = JSON.parse((await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).slice(4)).atc_messages.find(m => m.id === t7.id);
ok("request visible to controller, not delivered", rqm && rqm.kind === "request" && rqm.status === "request" && JSON.parse((await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "rq3")).slice(4)).messages.length === 0);
await call("DELETE", "/api/atc/tower?name=SBBR", null, "ctl");
