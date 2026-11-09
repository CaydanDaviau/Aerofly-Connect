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

// clearance delivery
await call("PUT", "/api/flightplan", { callsign: "CLR1", departure_airport: "SBBR", departure_runway: "29L", arrival_airport: "SBGR" }, "cl1");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "cl1");
await new Promise(r => setTimeout(r, 2100));
let [, c1] = await rq("cl1", { type: "clearance" });
const sqm = /squawk (\d{4})/.exec(c1.messages && c1.messages[0].text);
ok("clearance text", c1.mode === "auto" && /^Cleared to SBGR as filed, departure runway 29L, squawk [0-7]{4}$/.test(c1.messages[0].text));
const cltr = JSON.parse((await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).slice(4)).aircraft.find(a => a.callsign === "CLR1");
ok("squawk assigned", sqm && cltr.assigned_squawk === sqm[1]);
await new Promise(r => setTimeout(r, 2100));
let [, c2] = await rq("cl1", { type: "clearance", lang: "pt" });
ok("same squawk, pt", c2.messages[0].text === `Autorizado para SBGR conforme o plano, pista de saída 29L, código ${sqm[1]}`);
await call("PUT", "/api/flightplan", { callsign: "CLR2" }, "cl2");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "cl2");
let [, c3] = await rq("cl2", { type: "clearance" });
ok("no arrival, no runway", /^Cleared as filed, squawk [0-7]{4}$/.test(c3.messages[0].text) && !c3.messages[0].text.includes(sqm[1]));
await call("PUT", "/api/atc/tower", { name: "SBBR", latitude: -15.871, longitude: -47.919 }, "ctl");
await new Promise(r => setTimeout(r, 2100));
let [, c4] = await rq("cl2", { type: "clearance" });
ok("tower takes clearance request", c4.mode === "controller" && c4.messages === undefined);
await call("DELETE", "/api/atc/tower?name=SBBR", null, "ctl");

// ---- TA / crash / online count ----
{
  const up = (k, o) => call("PUT", "/api/position", o, k);
  const P = (lat, lon, hdg, gs, alt, vs = 0, extra = {}) => ({ latitude: lat, longitude: lon, heading_true: hdg, ground_speed: gs, altitude_ft: alt, vertical_speed_ft_min: vs, ...extra });
  const alerts = r => JSON.parse(r.slice(4)).traffic_alerts;
  // head-on, 6 nm apart on the same latitude, 250 kt each (closing 500 kt = 60 s... tau 43 s -> inside 40 s at 5 nm)
  await up("ta2", P(10, 20.0833, 270, 250, 10000));            // 5 nm east of ta1, flying west
  let r = await up("ta1", P(10, 20, 90, 250, 10000));          // flying east
  let al = alerts(r);
  console.log("TA head-on:", al.length === 1 && al[0].clock === 12 && al[0].rel_alt_ft === 0 ? "PASS" : "FAIL " + r);
  r = await up("ta1", P(10, 20, 90, 250, 10000));
  console.log("TA cooldown:", alerts(r).length === 0 ? "PASS" : "FAIL " + r);
  // vertical separation 3000 ft: no alert
  await up("ta4", P(11, 20.0833, 270, 250, 13000));
  r = await up("ta3", P(11, 20, 90, 250, 10000));
  console.log("TA vertical:", alerts(r).length === 0 ? "PASS" : "FAIL " + r);
  // formation (same heading/speed, 0.1 nm apart): no alert
  await up("ta6", P(12, 20.002, 90, 250, 10000));
  r = await up("ta5", P(12, 20, 90, 250, 10000));
  console.log("TA formation:", alerts(r).length === 0 ? "PASS" : "FAIL " + r);
  // diverging: no alert
  await up("ta8", P(13, 20.01, 90, 250, 10000));
  r = await up("ta7", P(13, 20, 270, 250, 10000));
  console.log("TA diverging:", alerts(r).length === 0 ? "PASS" : "FAIL " + r);
  // relaxed near an airport: 0.3 nm miss-distance converging in 30 s alerts only when not terminal
  await up("ta10", P(14.003, 20.0833, 270, 250, 10000));        // passes 0.18 nm north of ta9
  r = await up("ta9", P(14, 20, 90, 250, 10000));
  console.log("TA 40s window (5 nm, 0.18 nm miss):", alerts(r).length === 1 ? "PASS" : "FAIL " + r);
  await up("ta12", P(15.003, 20.0833, 270, 250, 10000, 0, { terminal: true }));
  r = await up("ta11", P(15, 20, 90, 250, 10000, 0, { terminal: true }));
  console.log("TA relaxed (terminal, tau 43 s > 20 s):", alerts(r).length === 0 ? "PASS" : "FAIL " + r);
  // clock + above + climbing: other plane 2 o'clock, 400 ft above, climbing
  await up("ta14", P(16.02, 20.0384, 225, 250, 10400, 800));
  r = await up("ta13", P(16, 20, 90, 250, 10000));
  al = alerts(r);
  console.log("TA clock/alt/trend:", al.length === 1 && al[0].clock === 11 && al[0].rel_alt_ft === 400 && al[0].vs_trend === 1 ? "PASS " + JSON.stringify(al[0]) : "FAIL " + r);

  // hard landing: 423 + removed from traffic + X listed + stays blocked
  await call("PUT", "/api/flightplan", { callsign: "CRASH1" }, "cr1");
  await up("cr1", P(-15.87, -47.92, 90, 5, 3400));
  r = await up("cr1", P(-15.87, -47.92, 90, 5, 3400, 0, { landing_fpm: -1800 }));
  console.log("crash 423:", r.startsWith("423") && r.includes('"crashed":true') && r.includes('"remaining_s":300') ? "PASS" : "FAIL " + r);
  r = await up("cr1", P(-15.87, -47.92, 90, 5, 3400));
  console.log("crash stays blocked:", r.startsWith("423") ? "PASS" : "FAIL " + r);
  console.log("crash flightplan blocked:", (await call("PUT", "/api/flightplan", { callsign: "CRASH1" }, "cr1")).startsWith("423") ? "PASS" : "FAIL");
  const tr2 = JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50")).slice(4));
  console.log("crash X listed, plane gone:", tr2.crashes.length === 1 && tr2.crashes[0].callsign === "CRASH1" && !tr2.aircraft.some(a => a.callsign === "CRASH1") ? "PASS" : "FAIL");
  // survives restart; soft landing is fine
  hub = new Hub(ctx); await new Promise(r => setTimeout(r, 0));   // the mock ctx does not block while the constructor loads storage
  r = await up("cr1", P(-15.87, -47.92, 90, 5, 3400));
  console.log("crash survives restart:", r.startsWith("423") ? "PASS" : "FAIL " + r);
  r = await up("soft1", P(-15.87, -47.92, 90, 5, 3400, 0, { landing_fpm: -300 }));
  console.log("soft landing ok:", r.startsWith("200") ? "PASS" : "FAIL " + r);
  // timeout over: allowed again
  store.set("crash:cr1", { ...store.get("crash:cr1"), until: Date.now() - 1 }); hub = new Hub(ctx); await new Promise(r => setTimeout(r, 0));
  r = await up("cr1", P(-15.87, -47.92, 90, 5, 3400));
  console.log("after timeout ok:", r.startsWith("200") ? "PASS" : "FAIL " + r);
  const h = JSON.parse((await call("GET", "/api/health", null, null)).slice(4));
  console.log("health pilots:", typeof h.pilots === "number" && h.pilots > 0 ? "PASS " + JSON.stringify(h) : "FAIL");
}

// traffic in the position reply (opt-in)
{
  await call("PUT", "/api/position", { latitude: 10, longitude: 10, altitude_ft: 3000 }, "tp2");
  const a = JSON.parse((await call("PUT", "/api/position?traffic=1", { latitude: 10.1, longitude: 10.1, altitude_ft: 3000 }, "tp1")).slice(4));
  const b = JSON.parse((await call("PUT", "/api/position", { latitude: 10.1, longitude: 10.1, altitude_ft: 3000 }, "tp1")).slice(4));
  console.log("position reply traffic:", Array.isArray(a.aircraft) && a.aircraft.length >= 2 && a.aircraft.some(x => x.self) && Array.isArray(a.crashes) && b.aircraft === undefined ? "PASS" : "FAIL");
}
