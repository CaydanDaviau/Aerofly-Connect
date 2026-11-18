import worker, { Hub } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f() };
let hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
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
await call("PUT", "/api/atc/tower", { name: "SBTT_TWR", latitude: 1, longitude: 2, holder: "th", owner: "th" }, "th");
console.log("assign:", await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "2314", holder: "th" }, "atc"));
console.log("bad:", (await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "7700", holder: "th" }, "atc")).slice(0, 3));
console.log("auto:", await call("PUT", "/api/atc/squawk", { icao_address: target, holder: "th" }, "atc"));
await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "2314", holder: "th" }, "atc");
console.log("in traffic:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"assigned_squawk":"2314"'));
hub = new Hub(ctx);
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "cs");
console.log("after restart:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"assigned_squawk":"2314"'));
console.log("unknown:", (await call("PUT", "/api/atc/squawk", { icao_address: "FFFFFF", squawk: "2000", holder: "th" }, "atc")).slice(0, 3));
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
await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", holder: "ctl-holder", latitude: -15.87, longitude: -47.92 }, "ctl");
const ok = (name, v) => console.log("msg " + name + ":", v ? "PASS" : "FAIL");
await call("PUT", "/api/flightplan", { callsign: "MSG1" }, "mp");
await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "mp");
await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "other");
const mtr = JSON.parse((await call("GET", "/api/traffic?lat=10&lon=10&radius_miles=50")).slice(4)).aircraft;
const micao = mtr.find(a => a.callsign === "MSG1").icao_address;
const sent = JSON.parse((await call("PUT", "/api/atc/message", { icao_address: micao, text: "Descend FL100", holder: "ctl-holder" }, "ctl")).slice(4));
ok("send", sent.success && sent.id);
ok("unknown aircraft 404", (await call("PUT", "/api/atc/message", { icao_address: "FFFFFF", text: "x", holder: "ctl-holder" }, "ctl")).startsWith("404"));
ok("empty 400", (await call("PUT", "/api/atc/message", { icao_address: micao, text: "  ", holder: "ctl-holder" }, "ctl")).startsWith("400"));
const status = async () => JSON.parse((await call("GET", "/api/traffic?lat=10&lon=10&radius_miles=50")).slice(4)).atc_messages.find(m => m.id === sent.id).status;
ok("status sent", await status() === "sent");
const otherResp = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "other")).slice(4));
ok("other pilot gets nothing", otherResp.messages.length === 0);
const p1 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "mp")).slice(4));
ok("pilot gets message", p1.messages.length === 1 && p1.messages[0].text === "Descend FL100" && p1.messages[0].id === sent.id);
ok("status delivered", await status() === "delivered");
const p2 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "mp")).slice(4));
ok("not delivered twice", p2.messages.length === 0);
ok("other pilot cannot reply", (await call("PUT", "/api/messages/reply", { id: sent.id, reply: "wilco" }, "other")).startsWith("404"));
ok("bad reply 400", (await call("PUT", "/api/messages/reply", { id: sent.id, reply: "maybe" }, "mp")).startsWith("400"));
ok("wilco", (await call("PUT", "/api/messages/reply", { id: sent.id, reply: "wilco" }, "mp")).startsWith("200") && await status() === "wilco");
// squawk assignment also creates a message
await call("PUT", "/api/atc/squawk", { icao_address: micao, squawk: "4321", holder: "th" }, "ctl");
const p3 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "mp")).slice(4));
ok("squawk message", p3.messages.length === 1 && p3.messages[0].text === "Squawk 4321" && p3.messages[0].kind === "squawk");
ok("squawk not urgent", p3.messages[0].urgent === false);
// urgent flag
await call("PUT", "/api/atc/message", { icao_address: micao, text: "Traffic!", urgent: true, holder: "ctl-holder" }, "ctl");
const p4 = JSON.parse((await call("PUT", "/api/position", { latitude: 10, longitude: 10, freq: "122.800" }, "mp")).slice(4));
ok("urgent flag delivered", p4.messages.length === 1 && p4.messages[0].urgent === true);
const trf = JSON.parse((await call("GET", "/api/traffic?lat=10&lon=10&radius_miles=50")).slice(4)).atc_messages;
ok("urgent in traffic", trf.some(m => m.text === "Traffic!" && m.urgent === true) && trf.find(m => m.id === sent.id).urgent === false);

// auto-ATC requests
await call("DELETE", "/api/atc/tower?name=SBBR_TWR&holder=ctl-holder", null, "ctl");
await call("PUT", "/api/flightplan", { callsign: "REQ1", departure_airport: "SBBR", departure_runway: "29L", arrival_airport: "SBGR", arrival_runway: "9R" }, "rq1");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "rq1");
await call("PUT", "/api/flightplan", { callsign: "REQ2", departure_airport: "SBBR", departure_runway: "29L" }, "rq2");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "rq2");
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
ok("runway busy", t3.messages[0].text === "Hold position, runway 29L occupied, number 2");
ok("auto message not redelivered", JSON.parse((await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "rq1")).slice(4)).messages.length === 0);
// runway from request body, 9R normalised to 09R, plan has arrival_runway so plan wins
await new Promise(r => setTimeout(r, 2100));
let [, t4] = await rq("rq1", { type: "land" });
ok("land uses plan runway", t4.messages[0].text === "Runway 09R, cleared to land");
await call("PUT", "/api/flightplan", { callsign: "REQ3" }, "rq3");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "rq3");
let [, t5] = await rq("rq3", { type: "takeoff", runway: "11r" });
ok("runway from body", t5.messages[0].text === "Runway 11R, cleared for takeoff");
let [, t6] = await rq("rq3", { type: "taxi", runway: "99" }).catch(() => [0, {}]);
// human tower wins
await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.871, longitude: -47.919 }, "ctl");
await new Promise(r => setTimeout(r, 2100));
let [, t7] = await rq("rq3", { type: "taxi" });
ok("tower takes request", t7.mode === "controller");
const rqm = JSON.parse((await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).slice(4)).atc_messages.find(m => m.id === t7.id);
ok("request visible to controller, not delivered", rqm && rqm.kind === "request" && rqm.status === "request" && JSON.parse((await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "rq3")).slice(4)).messages.length === 0);
await call("DELETE", "/api/atc/tower?name=SBBR_TWR", null, "ctl");

// clearance delivery
await call("PUT", "/api/flightplan", { callsign: "CLR1", departure_airport: "SBBR", departure_runway: "29L", arrival_airport: "SBGR" }, "cl1");
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "cl1");
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
await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "122.800" }, "cl2");
let [, c3] = await rq("cl2", { type: "clearance" });
ok("no arrival, no runway", /^Cleared as filed, squawk [0-7]{4}$/.test(c3.messages[0].text) && !c3.messages[0].text.includes(sqm[1]));
await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.871, longitude: -47.919 }, "ctl");
await new Promise(r => setTimeout(r, 2100));
let [, c4] = await rq("cl2", { type: "clearance" });
ok("tower takes clearance request", c4.mode === "controller" && c4.messages === undefined);
await call("DELETE", "/api/atc/tower?name=SBBR_TWR", null, "ctl");

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

// auto-ATC stage 1: phases, queue, go-around, unauthorised actions
{
  const P = (k, o) => call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, altitude_ft: 3500, ground_speed: 0, freq: "118.000", ...o }, k).then(r => JSON.parse(r.slice(4)));
  const R = async (k, type) => { hub.clients.get(k).lastReq = 0; return JSON.parse((await call("PUT", "/api/atc/request", { type }, k)).slice(4)); };
  const free = k => { hub.clients.get(k).st.grace = 0; };
  const T = (name, v) => console.log(name + ":", v ? "PASS" : "FAIL");
  for (const n of ["SBBR_TWR", "SBGL_TWR"]) await call("DELETE", "/api/atc/tower?name=" + n, null, "atc");
  for (const [k, cs] of [["s1", "AAA1"], ["s2", "BBB2"]]) {
    await call("PUT", "/api/flightplan", { callsign: cs, departure_airport: "SBBR", arrival_airport: "SBGL", departure_runway: "29L", arrival_runway: "15" }, k);
    await P(k, { phase: "ground" }); free(k);
  }
  // taxi without clearance -> stop call + NO CLNC; with clearance -> silent
  let r = await P("s1", { phase: "ground", ground_speed: 15 });
  T("taxi without clearance", r.messages.some(m => /not cleared to taxi/.test(m.text) && m.urgent));
  const tr = JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "s2")).slice(4));
  T("NO CLNC flag in traffic", tr.aircraft.find(a => a.callsign === "AAA1").no_clnc === true && tr.aircraft.find(a => a.callsign === "BBB2").no_clnc === false);
  r = await P("s1", { phase: "ground", ground_speed: 15 });
  T("stop call not repeated within 20 s", r.messages.length === 0);
  await R("s2", "taxi");
  r = await P("s2", { phase: "ground", ground_speed: 15 });
  T("taxi after clearance is silent", r.messages.length === 0);
  // runway lined up without takeoff clearance -> violation + runway counts as occupied for s2
  r = await P("s1", { phase: "runway", rwy_on: "11R/29L", on_rwy: "29L", rwy_apt: "SBBR", ground_speed: 0 });
  T("lined up without clearance", r.messages.some(m => /not cleared on the runway/.test(m.text)));
  let q = await R("s2", "takeoff");
  T("violator blocks runway, s2 number 2", /occupied, number 2/.test(q.messages[0].text));
  // s1 clears the runway -> lock goes; s2 (first in queue) is cleared
  await P("s1", { phase: "ground", ground_speed: 5 });
  hub.rwy.clear();
  q = await R("s2", "takeoff");
  T("queue head cleared when free", /cleared for takeoff/.test(q.messages[0].text));
  // s1 asks for takeoff behind s2: number 2; s2 departs -> contact departure once, lock released
  q = await R("s1", "takeoff");
  T("second aircraft waits", /number 2/.test(q.messages[0].text));
  await P("s2", { phase: "runway", rwy_on: "11R/29L", on_rwy: "29L", rwy_apt: "SBBR", ground_speed: 80 });
  r = await P("s2", { phase: "air", altitude_ft: 4500, ground_speed: 120, fq_dep: "APP=119.1;DEP=119.5" });
  T("contact departure after takeoff, with frequency", r.messages.length === 1 && r.messages[0].text === "Contact departure 119.5" && r.messages[0].contact === "Departure 119.5");
  r = await P("s2", { phase: "air", altitude_ft: 5000, ground_speed: 140 });
  T("departure call only once", r.messages.length === 0);
  q = await R("s1", "takeoff");
  T("runway free after departure", /cleared for takeoff/.test(q.messages[0].text));
  // landing: s2 cleared to land on 15 at SBGL, s1 sits on that runway -> go around; s1 later flagged-free
  await P("s2", { phase: "air", altitude_ft: 1500, ground_speed: 140, arr_nm: 12, latitude: -22.8, longitude: -43.2 });
  q = await R("s2", "land");
  T("landing clearance", /cleared to land/.test(q.messages[0].text));
  hub.clients.get("s1").pos = { ...hub.clients.get("s1").pos, latitude: -22.81, longitude: -43.25, phase: "runway", rwy_on: "15/33", on_rwy: "15", rwy_apt: "SBGL" };
  hub.clients.get("s1").seen = Date.now();
  r = await P("s2", { phase: "air", altitude_ft: 600, ground_speed: 130, arr_nm: 2, latitude: -22.8, longitude: -43.2 });
  T("go around when runway occupied", r.messages.some(m => /Go around, runway 15 occupied/.test(m.text) && m.urgent));
  // touchdown without clearance flagged, with clearance welcomed
  free("s2");
  r = await P("s2", { phase: "runway", rwy_on: "15/33", on_rwy: "15", rwy_apt: "SBGL", ground_speed: 100, latitude: -22.8, longitude: -43.2 });
  T("touchdown without clearance (cleared was withdrawn)", r.messages.some(m => /Landing without clearance on runway 15/.test(m.text)));
  await P("s1", { phase: "ground", ground_speed: 0, latitude: -22.9, longitude: -43.3 });
  await call("PUT", "/api/flightplan", { callsign: "CCC3", arrival_airport: "SBGL", arrival_runway: "15" }, "s3");
  await P("s3", { phase: "air", altitude_ft: 1500, ground_speed: 140, arr_nm: 10, latitude: -22.7, longitude: -43.1 }); free("s3");
  hub.rwy.clear(); hub.rwyQ.clear();
  await P("s2", { phase: "ground", ground_speed: 5, latitude: -22.9, longitude: -43.3 });
  await R("s3", "land");
  r = await P("s3", { phase: "runway", rwy_on: "15/33", on_rwy: "15", rwy_apt: "SBGL", ground_speed: 90, latitude: -22.7, longitude: -43.1, fq_arr: "TWR=118.7;GND=121.9" });
  T("cleared landing welcomed with ground frequency, no violation", r.messages.length === 1 && r.messages[0].text === "Welcome to SBGL, contact ground 121.9" && r.messages[0].contact === "Ground 121.9");
  // arrival handoffs: approach inside 35 nm, tower inside 12 nm, each once; no frequency data -> no number
  await call("PUT", "/api/flightplan", { callsign: "EEE5", arrival_airport: "SBGL" }, "s5");
  const fqa = "APP=119.1;TWR=118.7";
  r = await P("s5", { phase: "air", altitude_ft: 9000, ground_speed: 250, arr_nm: 60, latitude: -22.0, longitude: -43.0, fq_arr: fqa });
  T("no handoff far away", r.messages.length === 0);
  r = await P("s5", { phase: "air", altitude_ft: 8000, ground_speed: 250, arr_nm: 30, latitude: -22.0, longitude: -43.0, fq_arr: fqa });
  T("approach handoff", r.messages.length === 1 && r.messages[0].text === "Contact approach 119.1" && r.messages[0].contact === "Approach 119.1");
  r = await P("s5", { phase: "air", altitude_ft: 7000, ground_speed: 250, arr_nm: 25, latitude: -22.0, longitude: -43.0, fq_arr: fqa });
  T("approach handoff once", r.messages.length === 0);
  r = await P("s5", { phase: "air", altitude_ft: 3000, ground_speed: 180, arr_nm: 10, latitude: -22.0, longitude: -43.0, fq_arr: fqa });
  T("tower handoff", r.messages.length === 1 && r.messages[0].text === "Contact tower 118.7");
  r = await P("s5", { phase: "air", altitude_ft: 2000, ground_speed: 150, arr_nm: 8, latitude: -22.0, longitude: -43.0 });
  T("tower handoff once", r.messages.length === 0);
  await P("s5", { phase: "air", altitude_ft: 9000, ground_speed: 250, arr_nm: 60, latitude: -22.0, longitude: -43.0 });
  r = await P("s5", { phase: "air", altitude_ft: 8000, ground_speed: 250, arr_nm: 30, latitude: -22.0, longitude: -43.0 });
  T("handoff without frequency data", r.messages.length === 1 && r.messages[0].text === "Contact approach" && !r.messages[0].contact.includes("1"));
  // human tower: auto-ATC stays silent
  await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.87, longitude: -47.92 }, "atc");
  await call("PUT", "/api/flightplan", { callsign: "DDD4", departure_airport: "SBBR" }, "s4");
  await P("s4", { phase: "ground" }); free("s4");
  r = await P("s4", { phase: "ground", ground_speed: 20 });
  T("human tower: no auto violation", r.messages.length === 0 && !hub.clients.get("s4").viol);
  T("violations stored", hub.violations.length >= 3 && hub.violations[0].callsign === "AAA1");
}

// stage 2: mayday
{
  const P = (k, o) => call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, altitude_ft: 3500, ground_speed: 120, freq: "118.000", ...o }, k).then(r => JSON.parse(r.slice(4)));
  const R = async (k, b) => { hub.clients.get(k).lastReq = 0; return JSON.parse((await call("PUT", "/api/atc/request", b, k)).slice(4)); };
  const T = (name, v) => console.log(name + ":", v ? "PASS" : "FAIL");
  for (const n of ["SBBR_TWR", "SBGL_TWR", "SBSP_TWR"]) await call("DELETE", "/api/atc/tower?name=" + n, null, "atc");
  await call("PUT", "/api/flightplan", { callsign: "EMG1", arrival_airport: "SBSP", arrival_runway: "35L" }, "m1");
  await call("PUT", "/api/flightplan", { callsign: "NEAR2", arrival_airport: "SBSP", arrival_runway: "35L" }, "m2");
  await call("PUT", "/api/flightplan", { callsign: "FAR3" }, "m3");
  await P("m1", { phase: "air", arr_nm: 10 }); await P("m2", { phase: "air", latitude: -15.9, longitude: -47.95, arr_nm: 12 });
  await P("m3", { phase: "air", latitude: 10, longitude: 10 });
  const r = await R("m1", { type: "mayday" });
  T("mayday reply", r.mode === "auto" && r.messages[0].text === "Roger Mayday, say intentions" && r.messages[0].urgent);
  const n = await P("m2", { phase: "air", latitude: -15.9, longitude: -47.95, arr_nm: 12 });
  T("nearby pilot warned", n.messages.some(m => /Mayday traffic, EMG1/.test(m.text) && m.urgent));
  T("far pilot not warned", (await P("m3", { phase: "air", latitude: 10, longitude: 10 })).messages.length === 0);
  const tr = JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "m2")).slice(4));
  T("emergency flag in traffic", tr.aircraft.find(a => a.callsign === "EMG1").emergency === true && tr.aircraft.find(a => a.callsign === "NEAR2").emergency === false);
  const q = await R("m2", { type: "land" });
  T("runway held for emergency", /occupied, number 2/.test(q.messages[0].text));
  const c = await R("m1", { type: "mayday_cancel" });
  T("cancel", c.messages[0].text === "Mayday cancelled" && !hub.clients.get("m1").emerg && ![...hub.rwy.values()].some(l => l.type === "emerg"));
  await R("m1", { type: "mayday" });
  await P("m1", { phase: "runway", rwy_on: "17R/35L", on_rwy: "35L", rwy_apt: "SBSP", ground_speed: 90 });
  T("no violation on emergency landing", (await P("m1", { phase: "runway", rwy_on: "17R/35L", on_rwy: "35L", rwy_apt: "SBSP", ground_speed: 60 })).messages.length === 0);
  await call("PUT", "/api/atc/tower", { name: "SBSP_TWR", latitude: -15.87, longitude: -47.92 }, "atc");
  await P("m1", { phase: "air" }); const h = await R("m1", { type: "mayday" });
  T("human tower gets mayday as request", h.mode === "controller");
}

// pilot -> controller chat
{
  const CH = async (k, b) => JSON.parse((await call("PUT", "/api/atc/chat", b, k)).slice(4));
  const T = (n, v) => console.log("chat " + n + ":", v ? "PASS" : "FAIL");
  hub = new Hub(ctx);
  T("not flying -> 404", (await call("PUT", "/api/atc/chat", { text: "hi" }, "ch1")).startsWith("404"));
  await call("PUT", "/api/flightplan", { callsign: "CHAT1" }, "ch1");
  await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, freq: "121.900" }, "ch1");
  T("empty -> 400", (await call("PUT", "/api/atc/chat", { text: "  " }, "ch1")).startsWith("400"));
  hub.towers.clear();
  const a = await CH("ch1", { text: "Request pushback" });
  T("no tower -> mode none", a.success && a.mode === "none");
  hub.clients.get("ch1").lastChat = 0;
  await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.87, longitude: -47.92, holder: "ctl" }, "atc");
  T("tower open -> controller", (await CH("ch1", { text: "x".repeat(500) })).mode === "controller");
  T("rate limit", (await call("PUT", "/api/atc/chat", { text: "again" }, "ch1")).startsWith("429"));
  const tr = JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "atc")).slice(4));
  const ms = tr.atc_messages.filter(m => m.kind === "chat");
  T("listed for radar, status request, text capped", ms.length === 2 && ms.every(m => m.status === "request") && ms[1].text.length === 200);
  const up = JSON.parse((await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92 }, "ch1")).slice(4));
  T("never delivered back to pilot", !up.messages.some(m => m.kind === "chat"));
}

// push-to-talk voice
{
  const J = async (m, p, b, k) => { const s = await call(m, p, b, k); return { st: +s.slice(0, 3), j: JSON.parse(s.slice(4)) }; };
  const T = (n, v) => console.log("voice " + n + ":", v ? "PASS" : "FAIL");
  hub = new Hub(ctx);
  await call("PUT", "/api/flightplan", { callsign: "VOX1" }, "v1");
  await call("PUT", "/api/position", { latitude: 1, longitude: 2, voice: true, freq: "121.900" }, "v1");
  const clip = { audio: "QUJD", mime: "audio/mp4", ms: 3000 };
  T("no listener -> 409", (await J("PUT", "/api/voice/clip", clip, "v1")).j.error === "no_listener");
  await J("PUT", "/api/voice/listen", { on: true }, "ctl");
  await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: 1, longitude: 2, holder: "ctl", freq: "121.900" }, "ctl");
  const a = await J("PUT", "/api/voice/clip", clip, "v1");
  T("listener -> accepted", a.st === 200 && a.j.success);
  const tr = (await J("GET", "/api/traffic?lat=1&lon=2&radius_miles=50", null, "ctl")).j;
  T("announced without audio", tr.voice_clips.length === 1 && tr.voice_clips[0].callsign === "VOX1" && !("audio" in tr.voice_clips[0]));
  const g = await J("GET", "/api/voice/clip?id=" + a.j.id, null, "ctl");
  T("audio fetched", g.j.audio === "QUJD");
  hub.clients.get("v1").lastClip = 0;
  await J("PUT", "/api/voice/listen", { on: false }, "ctl");
  T("listener off -> 409", (await J("PUT", "/api/voice/clip", clip, "v1")).j.error === "no_listener");
  const icao = hub.clients.get("v1").pos.icao_address;
  const d = await J("PUT", "/api/atc/voice", { icao_address: icao, holder: "ctl", freq: "121.900", ...clip }, "ctl");
  T("controller -> pilot accepted", d.st === 200);
  const up = (await J("PUT", "/api/position", { latitude: 1, longitude: 2, voice: true, freq: "121.900" }, "v1")).j;
  T("delivered once", up.voice && up.voice.length === 1 && up.voice[0].audio === "QUJD");
  const up2 = (await J("PUT", "/api/position", { latitude: 1, longitude: 2, voice: false, freq: "121.900" }, "v1")).j;
  T("not delivered twice", !up2.voice);
  // pilots on the same frequency hear each other (and the controller's call); 20 s clips
  await call("PUT", "/api/flightplan", { callsign: "VOX2" }, "v2"); await call("PUT", "/api/flightplan", { callsign: "VOX3" }, "v3");
  await call("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "121.9" }, "v1");
  await call("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "121.9" }, "v2");
  await call("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "118.3" }, "v3");
  hub.clients.get("v1").lastClip = 0;
  const pp = await J("PUT", "/api/voice/clip", { ...clip, ms: 20000 }, "v1");
  T("pilot clip without controller, peers on freq", pp.st === 200);
  const r2 = (await J("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "121.9" }, "v2")).j, r3 = (await J("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "118.3" }, "v3")).j;
  T("same-freq pilot hears it, other freq does not", r2.voice && r2.voice.length === 1 && !r3.voice && hub.clips.get(pp.j.id).ms === 20000);
  const r1 = (await J("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "121.9" }, "v1")).j;
  T("sender does not hear own clip", !r1.voice);
  await J("PUT", "/api/atc/voice", { icao_address: icao, holder: "ctl", ...clip, freq: "121.900" }, "ctl");
  const r2b = (await J("PUT", "/api/position", { latitude: 1, longitude: 2, freq: "121.9" }, "v2")).j;
  T("controller call heard by other pilots on freq", r2b.voice && r2b.voice.length === 1);
  await call("PUT", "/api/position", { latitude: 1, longitude: 2, voice: false, freq: "121.900" }, "v1");
  const off = await J("PUT", "/api/atc/voice", { icao_address: icao, holder: "ctl", freq: "121.900", ...clip }, "ctl");
  T("pilot voice off -> 409", off.st === 409 && off.j.error === "voice_off");
  await J("PUT", "/api/voice/listen", { on: true }, "ctl");
  hub.clients.get("v1").lastClip = 0;
  T("pilot with voice off cannot send", (await J("PUT", "/api/voice/clip", clip, "v1")).j.error === "voice_off");
}

// group code
{
  const genv = { ...env, GROUP_CODE: "tango7" };
  const G = async (method, path, body, key, group) => {
    const h = { "X-API-Key": key }; if (group !== undefined) h["X-Group"] = group;
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: h }), genv);
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { st: r.status, j, t };
  };
  const T = (n, v) => console.log("group " + n + ":", v ? "PASS" : "FAIL");
  await G("PUT", "/api/position", { latitude: 5, longitude: 5 }, "gm", "tango7");
  await G("PUT", "/api/position", { latitude: 5, longitude: 5.01 }, "gx", "wrong");
  await G("PUT", "/api/position", { latitude: 5, longitude: 5.02 }, "gn");
  await G("PUT", "/api/flightplan", { callsign: "SPOOF", member: true }, "gx", "wrong");
  await G("PUT", "/api/position", { latitude: 5, longitude: 5.01 }, "gx", "wrong");
  await G("PUT", "/api/atc/tower", { name: "SBMM", latitude: 5, longitude: 5 }, "gm", "tango7");
  await G("PUT", "/api/atc/tower", { name: "SBXX", latitude: 5, longitude: 5 }, "gn", "nope");
  const tr = (await G("GET", "/api/traffic?lat=5&lon=5&radius_miles=50", null, "gm", "tango7")).j.aircraft;
  const tp = (await G("GET", "/api/traffic?lat=5&lon=5&radius_miles=50", null, "gn")).j.aircraft;
  const mem = a => a && a.member === true;
  const ic = k => hub.clients.get(k).pos.icao_address;
  T("member sees member pilot (self)", mem(tr.find(a => a.icao_address === ic("gm"))));
  T("member does not see public pilots", !tr.some(a => a.icao_address === ic("gx") || a.icao_address === ic("gn")));
  T("member sees member tower, not public tower", mem(tr.find(a => a.callsign === "ATC_SBMM")) && !tr.some(a => a.callsign === "ATC_SBXX"));
  T("public does not see member pilot/tower", !tp.some(a => a.icao_address === ic("gm") || a.callsign === "ATC_SBMM"));
  T("public sees public pilots + tower", tp.some(a => a.icao_address === ic("gx")) && tp.some(a => a.icao_address === ic("gn")) && tp.some(a => a.callsign === "ATC_SBXX"));
  T("wrong code = plain", !mem(tp.find(a => a.icao_address === ic("gx"))));
  const all = JSON.stringify(tr) + (await G("GET", "/api/health", null, "gm")).t;
  T("code never returned", !all.includes("tango7"));
  const nocfg = await worker.fetch(new Request("https://x/api/position", { method: "PUT", body: JSON.stringify({ latitude: 6, longitude: 6 }), headers: { "X-API-Key": "q", "X-Group": "" } }), env);
  T("no GROUP_CODE var = nobody member", nocfg.status === 200 && !hub.clients.get("q").member);
}

// ATIS
{
  const { parseMetar, wxSig } = await import("./src/atis.js");
  const T = (n, v) => console.log("atis " + n + ":", v ? "PASS" : "FAIL");
  const m1 = parseMetar("METAR SBBR 141200Z 09008KT 9999 FEW030 SCT100 25/14 Q1016 NOSIG=");
  T("parse wind/qnh/temp/clouds", m1.wind.dir === 90 && m1.wind.spd === 8 && m1.qnh === 1016 && m1.temp === 25 && m1.dew === 14 && m1.clouds.length === 2 && m1.vis_m === 9999);
  const m2 = parseMetar("KJFK 141251Z 28016G25KT 10SM FEW250 M02/M10 A3012");
  T("parse US (gust, SM, A, negative temp)", m2.wind.gst === 25 && m2.vis_m === 16090 && m2.qnh === 1020 && m2.temp === -2 && m2.dew === -10);
  T("CAVOK + VRB + MPS", (() => { const x = parseMetar("UUEE 141230Z VRB02MPS CAVOK 05/01 Q1008"); return x.cavok && x.wind.dir === null && x.wind.spd === 4 && x.vis_m === 9999; })());
  T("sig steady for small change", wxSig(m1) === wxSig(parseMetar("SBBR 141300Z 10010KT 9999 FEW030 25/14 Q1016")));
  T("sig changes with QNH", wxSig(m1) !== wxSig(parseMetar("SBBR 141300Z 09008KT 9999 FEW030 25/14 Q1013")));
  let metar = "SBBR 141200Z 09008KT 9999 FEW030 25/14 Q1016";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(metar);
  const A = async (method, path, body, key = "atc") => { const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key } }), env); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { st: r.status, j }; };
  T("no tower -> 404", (await A("GET", "/api/atis?name=SBZZ")).st === 404);
  await A("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.8, longitude: -47.9 });
  const g = (await A("GET", "/api/atis?name=SBBR")).j;
  T("letter A + decoded weather", g.letter === "A" && g.weather.qnh === 1016 && g.weather.wind.spd === 8 && g.wx_ok);
  T("runways -> bump B", (await A("PUT", "/api/atc/atis", { name: "SBBR", runways: "11r 11l" })).j.letter === "B");
  const same = (await A("PUT", "/api/atc/atis", { name: "SBBR", runways: "11R 11L" })).j;
  T("same text no bump, uppercase", same.letter === "B" && same.runways === "11R 11L");
  T("manual bump C", (await A("PUT", "/api/atc/atis", { name: "SBBR", bump: true })).j.letter === "C");
  T("freq + remarks saved, bump D", (await A("PUT", "/api/atc/atis", { name: "SBBR", frequencies: "TWR 118.3", remarks: "bird activity" })).j.letter === "D");
  metar = "SBBR 141300Z 09008KT 9999 FEW030 25/14 Q1010";
  hub.wx.clear();
  T("weather change auto-bump E", (await A("GET", "/api/atis?name=SBBR")).j.letter === "E");
  T("cached weather no bump", (await A("GET", "/api/atis?name=SBBR")).j.letter === "E");
  await A("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.8, longitude: -47.9 });
  const keep = (await A("GET", "/api/atis?name=SBBR")).j;
  T("tower re-register keeps ATIS", keep.letter === "E" && keep.frequencies === "TWR 118.3");
  hub = new Hub(ctx); await hub.fetch(new Request("https://hub/api/health"));
  T("survives restart", (await A("GET", "/api/atis?name=SBBR")).j.remarks === "bird activity");
  globalThis.fetch = async () => { throw new Error("down"); };
  hub.wx.clear();
  const off = (await A("GET", "/api/atis?name=SBBR")).j;
  T("weather down -> still answers", off.letter === "E" && off.wx_ok === false && off.weather === null);
  globalThis.fetch = realFetch;
}

// member towers are protected
{
  const genv = { ...env, GROUP_CODE: "tango7" };
  const G = async (method, path, body, group) => { const h = { "X-API-Key": "k" }; if (group) h["X-Group"] = group;
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: h }), genv); return r.status; };
  const T = (n, v) => console.log("tower guard " + n + ":", v ? "PASS" : "FAIL");
  const tw = { name: "SBGL", latitude: -22.8, longitude: -43.2 };
  T("member opens", await G("PUT", "/api/atc/tower", tw, "tango7") === 200);
  T("non-member cannot close", await G("DELETE", "/api/atc/tower?name=SBGL", null, "no") === 403);
  T("non-member cannot overwrite", await G("PUT", "/api/atc/tower", tw, "") === 403);
  T("non-member cannot edit ATIS", await G("PUT", "/api/atc/atis", { name: "SBGL", runways: "10" }, "no") === 403);
  T("non-member can still read ATIS", await G("GET", "/api/atis?name=SBGL", null, "no") === 200);
  T("tower still open", hub.towers.has("SBGL"));
  T("non-member tower stays open to all", await G("PUT", "/api/atc/tower", { name: "SBSP", latitude: -23.6, longitude: -46.6 }, "") === 200 && await G("DELETE", "/api/atc/tower?name=SBSP", null, "no") === 200);
  T("member edits ATIS", await G("PUT", "/api/atc/atis", { name: "SBGL", runways: "10" }, "tango7") === 200);
  T("member closes", await G("DELETE", "/api/atc/tower?name=SBGL", null, "tango7") === 200 && !hub.towers.has("SBGL"));
}

// positions: claiming, heartbeat expiry, coverage chain
{
  const T = (n, v) => console.log("positions " + n + ":", v ? "PASS" : "FAIL");
  const st = async (name, holder) => Number((await call("PUT", "/api/atc/tower", { name, latitude: -15.87, longitude: -47.92, holder }, "pc" + holder)).slice(0, 3));
  const del = async (name, holder) => Number((await call("DELETE", "/api/atc/tower?name=" + name + (holder ? "&holder=" + holder : ""), null, "x")).slice(0, 3));
  hub.towers.clear();
  T("open GND", await st("SBBR_GND", "h1") === 200 && hub.towers.get("SBBR_GND").pos === "GND" && hub.towers.get("SBBR_GND").apt === "SBBR");
  T("plain name = airport anchor", await st("SBBR", "") === 200 && hub.towers.get("SBBR").pos === "APT" && hub.towers.has("SBBR_GND"));
  T("_TWR suffix = TWR role", await st("SBBR_TWR", "h2") === 200 && hub.towers.get("SBBR_TWR").pos === "TWR");
  await del("SBBR_TWR", "h2");
  T("second claimant refused", await st("SBBR_GND", "h3") === 409);
  T("holder heartbeat ok", await st("SBBR_GND", "h1") === 200);
  T("bad position rejected", await st("SBBR_XYZ", "h1") === 400);
  T("other cannot close claimed", await del("SBBR_GND", "h3") === 409 && hub.towers.has("SBBR_GND"));
  T("holder closes", await del("SBBR_GND", "h1") === 200 && !hub.towers.has("SBBR_GND"));
  await st("SBBR_APP", "h3");
  hub.towers.get("SBBR_APP").at -= 130_000; hub.purge();
  T("claim frees after 2 min (different holder)", !hub.towers.has("SBBR_APP") && await st("SBBR_APP", "h4") === 200);
  const ta = JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "x")).slice(4)).aircraft.filter(a => a.virtual_tower);
  T("traffic: one symbol per airport with positions", ta.filter(a => a.callsign.startsWith("ATC_SBBR")).length === 1 && ta.some(a => a.callsign === "ATC_SBBR" && a.claimed && a.positions.some(p => p.pos === "APP" && p.claimed)));
  await st("SBBR_GND", "h5");
  const t2 = JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "x")).slice(4)).aircraft.filter(a => a.virtual_tower);
  T("two roles still one symbol", t2.length === 1 && t2[0].positions.length === 2);
  T("close airport blocked while another is live", await del("SBBR", "h1") === 409 && hub.towers.has("SBBR_GND"));
  T("close airport by the holders removes roles", await del("SBBR_GND", "h5") === 200 && await del("SBBR_APP", "h4") === 200 && await del("SBBR", "h1") === 200 && ![...hub.towers.keys()].some(k => k.startsWith("SBBR")));
  await st("SBBR", ""); await st("SBBR_GND", "h5");
  // ATIS is shared per airport
  const at = await call("PUT", "/api/atc/atis", { name: "SBBR_APP", runways: "11R" }, "x");
  T("ATIS resolves to airport", at.startsWith("200") && JSON.parse((await call("GET", "/api/atis?name=SBBR", null, "x")).slice(4)).runways === "11R");
  // coverage chain for auto-ATC
  const P = (k, o) => call("PUT", "/api/position", { latitude: -15.871, longitude: -47.919, altitude_ft: 3500, ground_speed: 0, freq: "118.000", ...o }, k);
  await call("PUT", "/api/flightplan", { callsign: "PPP1", departure_airport: "SBBR", departure_runway: "11R" }, "ppp");
  await P("ppp", { phase: "ground" });
  const R = async type => { hub.clients.get("ppp").lastReq = 0; return JSON.parse((await call("PUT", "/api/atc/request", { type }, "ppp")).slice(4)); };
  hub.towers.clear();
  await st("SBBR_APP", "h1");
  T("APP only: taxi goes to auto-ATC (APP cannot cover it)", (await R("taxi")).mode === "auto");
  // proximity rule still counts towers near the aircraft, so test with only the APP tower 8+ mi away covers nothing for takeoff
  await st("SBBR_GND", "coverage-gnd");
  T("GND staffed: taxi goes to controller", (await R("taxi")).mode === "controller");
  T("GND only: takeoff is auto (GND cannot clear takeoff)", (await R("takeoff")).mode === "auto");
  await call("DELETE", "/api/atc/tower?name=SBBR_GND&holder=coverage-gnd", null, "x");
  await st("SBBR_TWR", "coverage-twr");
  T("TWR staffed covers taxi (next up)", (await R("taxi")).mode === "controller");
  T("TWR staffed: takeoff to controller", (await R("takeoff")).mode === "controller");
  hub.towers.clear();
}

// role lock, airport owner, kick / unban
{
  const T = (n, v) => console.log("owner " + n + ":", v ? "PASS" : "FAIL");
  const genv = { ...env, GROUP_CODE: "tango7" };
  const raw = async (method, path, body, group) => { const h = { "X-API-Key": "k" }; if (group) h["X-Group"] = group;
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: h }), genv); return { s: r.status, t: await r.text() }; };
  const put = (name, extra) => (globalThis.__cd !== true && hub.lastClaim.clear(), raw("PUT", "/api/atc/tower", { name, latitude: -15.87, longitude: -47.92, ...extra }).then(r => r.s));
  const del = (name, holder) => raw("DELETE", "/api/atc/tower?name=" + name + "&holder=" + holder).then(r => r.s);
  const kick = (b, g) => raw("POST", "/api/atc/kick", b, g).then(r => r.s), unban = (b, g) => raw("POST", "/api/atc/unban", b, g).then(r => r.s);
  const traf = async () => JSON.parse((await raw("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=3000")).t).aircraft.find(a => a.callsign === "ATC_SBBR");
  hub.towers.clear();
  // owner is the creator and never changes
  T("airport open records owner", await put("SBBR", { owner: "own" }) === 200 && hub.towers.get("SBBR").owner === "own");
  T("re-PUT by someone else keeps owner", await put("SBBR", { owner: "troll" }) === 200 && hub.towers.get("SBBR").owner === "own");
  // role lock: one airport at a time
  await put("SBGL", { owner: "other" });
  T("claim a role", await put("SBBR_GND", { holder: "h1", freq: "121.9" }) === 200);
  T("lock: claim at another airport refused", await put("SBGL_TWR", { holder: "h1" }) === 409);
  T("lock: open/anchor at another airport refused", await put("SBGL", { owner: "h1" }) === 409);
  T("lock: close at another airport refused", await del("SBGL", "h1") === 409 && hub.towers.has("SBGL"));
  T("lock: ATIS at another airport refused", (await raw("PUT", "/api/atc/atis", { name: "SBGL", runways: "10", holder: "h1" })).s === 409);
  T("lock: own airport ATIS ok", (await raw("PUT", "/api/atc/atis", { name: "SBBR", runways: "11R", holder: "h1" })).s === 200);
  globalThis.__cd = true; hub.lastClaim.set("h1", { name: "SBBR_GND", at: Date.now() }); T("cooldown: second role within 2 min refused", await put("SBBR_APP", { holder: "h1" }) === 409); globalThis.__cd = false;
  hub.lastClaim.clear();
  T("lock: second role at same airport ok", await put("SBBR_APP", { holder: "h1" }) === 200);
  T("lock: someone else unaffected", await put("SBGL_TWR", { holder: "h7" }) === 200);
  await del("SBGL_TWR", "h7");
  await del("SBBR_APP", "h1"); await del("SBBR_GND", "h1");
  T("lock released with the role: no waiting time", await put("SBGL_TWR", { holder: "h1" }) === 200);
  await del("SBGL_TWR", "h1");
  // kick + permanent ban
  await put("SBBR_GND", { holder: "h2" });
  T("kick by non-owner refused", await kick({ airport: "SBBR", pos: "GND", holder: "h2" }) === 403 && hub.towers.has("SBBR_GND"));
  T("kick by owner frees the role", await kick({ airport: "SBBR", pos: "GND", holder: "own" }) === 200 && !hub.towers.has("SBBR_GND"));
  T("kicked holder cannot re-claim", await put("SBBR_GND", { holder: "h2" }) === 403 && await put("SBBR_DEP", { holder: "h2" }) === 403);
  T("ban survives re-PUT of the airport", await put("SBBR", { owner: "own" }) === 200 && await put("SBBR_GND", { holder: "h2" }) === 403);
  T("others can still claim", await put("SBBR_GND", { holder: "h3" }) === 200);
  const e = await traf();
  T("traffic lists bans + owner hid, no raw ids", e.bans.length === 1 && e.bans[0].pos === "GND" && e.owner_hid && !JSON.stringify(e).includes('"h2"') && !JSON.stringify(e).includes('"h3"') && !JSON.stringify(e).includes('"own"'));
  T("non-owner cannot close an airport with bans", await del("SBBR", "h3") === 403 && hub.towers.has("SBBR"));
  T("non-owner cannot unban", await unban({ airport: "SBBR", hid: e.bans[0].hid, holder: "h3" }) === 403);
  T("owner unbans", await unban({ airport: "SBBR", hid: e.bans[0].hid, holder: "own" }) === 200 && !hub.towers.get("SBBR").bans);
  T("unbanned holder can claim again", await put("SBBR_DEP", { holder: "h2" }) === 200);
  // member override, owner immune, close clears bans
  T("member kicks on any airport", await kick({ airport: "SBBR", pos: "GND" }, "tango7") === 200 && !hub.towers.has("SBBR_GND"));
  T("member kick bans too", await put("SBBR_GND", { holder: "h3" }) === 403);
  await put("SBBR_TWR", { holder: "own" });
  T("owner's own role kick does not ban the owner", await kick({ airport: "SBBR", pos: "TWR" }, "tango7") === 200 && await put("SBBR_TWR", { holder: "own" }) === 200);
  T("owner closes (roles of others live -> refused)", await del("SBBR", "own") === 409);
  await del("SBBR_DEP", "h2"); await del("SBBR_TWR", "own");
  T("owner closes airport", await del("SBBR", "own") === 200 && !hub.towers.has("SBBR"));
  await put("SBBR", { owner: "own" });
  T("closing the airport cleared the bans", await put("SBBR_GND", { holder: "h3" }) === 200);
  T("kick on missing role / airport", await kick({ airport: "SBBR", pos: "APP", holder: "own" }) === 404 && await kick({ airport: "ZZZZ", pos: "GND", holder: "own" }) === 404);
  hub.towers.clear();
}

// frequencies: tuning, routing of text/clips, stations, human handoff frequency
{
  const T = (n, v) => console.log("freq " + n + ":", v ? "PASS" : "FAIL");
  hub.towers.clear();
  const P = (k, o) => call("PUT", "/api/position", { latitude: -15.871, longitude: -47.919, altitude_ft: 3500, ground_speed: 0, freq: "118.000", ...o }, k).then(r => JSON.parse(r.slice(4)));
  await call("PUT", "/api/flightplan", { callsign: "FQ1", departure_airport: "SBBR", arrival_airport: "SBSP" }, "fq1");
  await call("PUT", "/api/flightplan", { callsign: "FQ2", departure_airport: "SBBR" }, "fq2");
  await P("fq1", { freq: "121.9" }); await P("fq2", {});
  const tr = async () => JSON.parse((await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "x")).slice(4));
  let a = (await tr()).aircraft;
  const id1 = a.find(x => x.callsign === "FQ1").icao_address, id2 = a.find(x => x.callsign === "FQ2").icao_address;
  T("freq normalised and listed", a.find(x => x.callsign === "FQ1").freq === "121.900" && a.find(x => x.callsign === "FQ2").freq === "118.000");
  await P("fq2", { freq: "99.9" });
  T("invalid freq ignored", (await tr()).aircraft.find(x => x.callsign === "FQ2").freq === "");
  await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", latitude: -15.87, longitude: -47.92, holder: "atc", freq: "121.900" }, "atc");
  const msg = (id, freq) => call("PUT", "/api/atc/message", { icao_address: id, text: "hello", freq, holder: "atc" }, "atc").then(r => r.slice(0, 3));
  T("text same freq delivered", await msg(id1, "121.900") === "200");
  T("text other freq refused", await msg(id1, "118.300") === "409");
  T("text without explicit freq uses tuned pilot frequency", await msg(id1, undefined) === "200");
  T("pilot frequency routing", await msg(id2, "118.300") === "200");
  const clip = (id, freq) => call("PUT", "/api/atc/voice", { icao_address: id, audio: "AAAA", mime: "audio/webm", ms: 1000, freq, holder: "atc" }, "atc").then(r => r.slice(0, 3));
  T("clip refused off freq", await clip(id1, "118.300") === "409" && await clip(id1, "121.900") === "200");
  // pilot -> controller: stamped with the pilot's freq
  await call("PUT", "/api/voice/listen", { on: true }, "atc");
  hub.clients.get("fq1").lastChat = 0; hub.clients.get("fq1").lastClip = 0;
  await call("PUT", "/api/atc/chat", { text: "ready" }, "fq1");
  await call("PUT", "/api/voice/clip", { audio: "AAAA", mime: "audio/mp4", ms: 1000 }, "fq1");
  const t2 = await tr();
  T("chat + clip carry freq", t2.atc_messages.some(m => m.kind === "chat" && m.freq === "121.900") && t2.voice_clips.some(v => v.freq === "121.900"));
  // tower frequency
  const tp = (name, freq, holder) => call("PUT", "/api/atc/tower", { name, latitude: -15.87, longitude: -47.92, freq, holder }, "c" + holder);
  T("bad tower freq rejected", (await tp("SBBR_GND", "12", "freq-holder-bad")).startsWith("400"));
  T("tower freq stored", (await tp("SBBR_GND", "121.9", "freq-holder-good")).startsWith("200") && hub.towers.get("SBBR_GND").freq === "121.900");
  T("tower freq listed", (await tr()).aircraft.some(x => x.callsign === "ATC_SBBR" && x.positions.some(p => p.pos === "GND" && p.freq === "121.900")));
  // stations in the position reply (dep airport on the ground)
  const r = await P("fq2", { phase: "ground" });
  T("stations in reply", Array.isArray(r.stations) && r.stations.some(x => x.pos === "GND" && x.freq === "121.900"));
  // auto handoff uses the human frequency of the departure airport (arrival has no tower, so auto-ATC speaks)
  hub.towers.clear();
  await tp("SBBR_DEP", "119.5", "freq-holder-dep");
  const k = "fq3"; await call("PUT", "/api/flightplan", { callsign: "FQ3", departure_airport: "SBBR", arrival_airport: "SBSP" }, k);
  await P(k, { phase: "ground", latitude: -15.5, longitude: -47.5 });
  await P(k, { phase: "runway", latitude: -15.5, longitude: -47.5, ground_speed: 100 });
  hub.clients.get(k).st.gr.takeoff = Date.now() + 60000;
  const d = await P(k, { phase: "air", latitude: -15.5, longitude: -47.5, ground_speed: 150, altitude_ft: 1500, fq_dep: "DEP=118.1" });
  T("handoff prefers human DEP frequency", d.messages.some(m => /119\.500/.test(m.text)));
  hub.towers.clear();
}

// ---- SimBrief route
{
  const T = (n, v) => console.log("route " + n + ":", v ? "PASS" : "FAIL");
  const J = async (method, path, body, key) => { const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key } }), env); return { s: r.status, j: await r.json().catch(() => ({})), }; };
  const k = "rt1";
  await call("PUT", "/api/flightplan", { callsign: "RT1", departure_airport: "SBBR" }, k);
  await call("PUT", "/api/position", { latitude: 10, longitude: 20, icao_address: "ABC123" }, k);
  const icao = JSON.parse((await call("GET", "/api/traffic?lat=10&lon=20&radius_miles=50", null, "o")).slice(4)).aircraft.find(a => a.callsign === "RT1");
  T("no route yet", (await J("GET", "/api/route?icao_address=" + icao.icao_address, null, "o")).s === 404 && !icao.has_route);
  T("bad body 400", (await J("PUT", "/api/flightplan/route", { points: "x" }, k)).s === 400);
  T("one point 400", (await J("PUT", "/api/flightplan/route", { points: [[1, 2]] }, k)).s === 400);
  const pts = []; for (let i = 0; i < 300; i++) pts.push([10 + i * 0.01, 20, 30000, "FX" + i]); pts.push([999, 0, 0, "BAD"]);
  const put = await J("PUT", "/api/flightplan/route", { points: pts, route: "DCT FOO" }, k);
  T("stored, capped at 200", put.s === 200 && put.j.points === 200);
  const g = await J("GET", "/api/route?icao_address=" + icao.icao_address.toLowerCase(), null, "o");
  T("fetch", g.s === 200 && g.j.points.length === 200 && g.j.points[0][3] === "FX0" && g.j.route === "DCT FOO");
  const t2 = await call("GET", "/api/traffic?lat=10&lon=20&radius_miles=50", null, "o");
  T("flag in traffic, points not", t2.includes('"has_route":true') && !t2.includes("FX0"));
  hub = new Hub(ctx); await call("PUT", "/api/position", { latitude: 10, longitude: 20, icao_address: "ABC123" }, k);
  T("survives restart", (await J("GET", "/api/route?icao_address=ABC123", null, "o")).s === 200);
  await call("PUT", "/api/flightplan", { callsign: "RT1" }, k);
  T("new plan clears route", (await J("GET", "/api/route?icao_address=ABC123", null, "o")).s === 404);
  await J("PUT", "/api/flightplan/route", { points: [[1, 2], [3, 4]] }, k);
  await call("DELETE", "/api/position", null, k);
  T("cleared on DELETE", (await J("GET", "/api/route?icao_address=ABC123", null, "o")).s === 404 && !(await ctx.storage.get("route:" + k)));
}

// ---- one airport per person, 2-minute airport expiry
{
  const T = (n, v) => console.log("onetower " + n + ":", v ? "PASS" : "FAIL");
  const put = async (name, who, ip, member) => { const h = { "X-API-Key": "k", "X-Member": member ? "1" : "0" }; if (ip) h["X-IP"] = ip;
    const r = await hub.fetch(new Request("https://hub/api/atc/tower", { method: "PUT", headers: h, body: JSON.stringify({ name, latitude: 1, longitude: 1, owner: who }) })); return { s: r.status, j: await r.json() }; };
  hub.towers.clear();
  T("first airport ok", (await put("AAAA", "u1", "ip1")).s === 200);
  T("refresh same airport ok", (await put("AAAA", "u1", "ip1")).s === 200);
  const r2 = await put("BBBB", "u1", "ip1");
  T("second airport same person blocked", r2.s === 409 && r2.j.error === "one_tower" && r2.j.airport === "AAAA");
  T("same IP, fresh browser id blocked", (await put("CCCC", "u9", "ip1")).j.error === "one_tower");
  T("other person ok", (await put("DDDD", "u2", "ip2")).s === 200);
  T("member unrestricted", (await put("EEEE", "m1", "ip1", true)).s === 200 && (await put("FFFF", "m1", "ip1", true)).s === 200);
  T("no IP header, other id ok", (await put("GGGG", "u3", "")).s === 200);
  T("closing frees the slot", (await hub.fetch(new Request("https://hub/api/atc/tower?name=AAAA&holder=u1", { method: "DELETE", headers: { "X-API-Key": "k" } }))).status === 200 && (await put("BBBB", "u1", "ip1")).s === 200);
  hub.towers.get("BBBB").at = Date.now() - 121_000; hub.purge();
  T("expires after 2 min", !hub.towers.has("BBBB"));
  hub.towers.get("DDDD").at = Date.now() - 100_000; hub.purge();
  T("alive at 100 s", hub.towers.has("DDDD"));
  hub.towers.clear();
}

// ATC credential
{
  const aenv = { ...env, GROUP_CODE: "tango7", ATC_CODES: "JOHN-1=John, ZED-9" };
  const A = async (method, path, body, key, hdr = {}) => {
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, ...hdr } }), aenv);
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { st: r.status, j };
  };
  const T = (n, v) => console.log("cred " + n + ":", v ? "PASS" : "FAIL");
  const M = { "X-Group": "tango7" };
  T("member without credential refused", (await A("PUT", "/api/atc/tower", { name: "SBCF", latitude: 1, longitude: 1 }, "c1", M)).st === 403);
  T("error name", (await A("PUT", "/api/atc/tower", { name: "SBCF", latitude: 1, longitude: 1 }, "c1", M)).j.error === "atc_credential");
  T("wrong credential refused", (await A("PUT", "/api/atc/tower", { name: "SBCF", latitude: 1, longitude: 1 }, "c1", { ...M, "X-Atc": "nope" })).st === 403);
  T("valid credential opens tower", (await A("PUT", "/api/atc/tower", { name: "SBCF", latitude: 1, longitude: 1 }, "c1", { ...M, "X-Atc": "JOHN-1" })).st === 200);
  T("second code (no label) works", (await A("PUT", "/api/atc/tower", { name: "SBCF", latitude: 1, longitude: 1 }, "c2", { ...M, "X-Atc": "ZED-9" })).st === 200);
  T("credential without group code = public, no effect", (await A("PUT", "/api/atc/tower", { name: "SBPA", latitude: 2, longitude: 2 }, "c3", { "X-Atc": "JOHN-1" })).st === 200);
  T("public tower unaffected", (await A("PUT", "/api/atc/tower", { name: "SBRJ", latitude: 3, longitude: 3 }, "c4")).st === 200);
  T("member without credential can't close/ATIS", (await A("DELETE", "/api/atc/tower?name=SBCF", null, "c1", M)).st === 403 && (await A("PUT", "/api/atc/atis", { name: "SBCF", remarks: "x" }, "c1", M)).st === 403);
  T("health flags", (async () => 0) && (await A("GET", "/api/health", null, "c1", { ...M, "X-Atc": "JOHN-1" })).j.atc === true && (await A("GET", "/api/health", null, "c1", M)).j.atc === false && (await A("GET", "/api/health", null, "c1", M)).j.atc_required === true);
  T("code never returned", !JSON.stringify((await A("GET", "/api/health", null, "c1", { ...M, "X-Atc": "JOHN-1" })).j).includes("JOHN"));
  T("client-sent X-Member can't spoof", (await A("PUT", "/api/atc/tower", { name: "SBXX", latitude: 1, longitude: 1 }, "c5", { "X-Member": "1", "X-Atc": "1" })).st === 200);
  const off = await worker.fetch(new Request("https://x/api/atc/tower", { method: "PUT", body: JSON.stringify({ name: "SBYY", latitude: 1, longitude: 1 }), headers: { "X-API-Key": "c6", "X-Group": "tango7" } }), { ...env, GROUP_CODE: "tango7" });
  T("no ATC_CODES = rule off", off.status === 200);
}

// Manager + managed credentials
{
  const menv = { ...env, GROUP_CODE: "tango7", MANAGER_CODES: "BOSS-1, BOSS-2" };
  const A = async (method, path, body, key, hdr = {}) => {
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, ...hdr } }), menv);
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { st: r.status, j };
  };
  const T = (n, v) => console.log("mgr " + n + ":", v ? "PASS" : "FAIL");
  const M = { "X-Group": "tango7" }, B = { "X-Manager": "BOSS-1" };
  T("page served", (await worker.fetch(new Request("https://x/manager"), menv)).status === 200);
  T("no manager code refused", (await A("GET", "/api/manager/creds", null, "m1")).st === 403);
  T("wrong manager code refused", (await A("PUT", "/api/manager/creds", { name: "X" }, "m1", { "X-Manager": "no" })).st === 403);
  T("health mgr flag", (await A("GET", "/api/health", null, "m1", B)).j.mgr === true && (await A("GET", "/api/health", null, "m1")).j.mgr === false);
  T("name required", (await A("PUT", "/api/manager/creds", {}, "m1", B)).st === 400);
  const g = await A("PUT", "/api/manager/creds", { name: "Ana" }, "m1", B);
  const code = g.j.code;
  T("generated format", g.st === 200 && /^ATC-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code));
  T("listed", (await A("GET", "/api/manager/creds", null, "m1", { "X-Manager": "BOSS-2" })).j.creds.some(c => c.code === code && c.name === "Ana"));
  T("member without cred refused now", (await A("PUT", "/api/atc/tower", { name: "SBGR", latitude: 1, longitude: 1 }, "c1", M)).st === 403);
  T("managed cred opens tower", (await A("PUT", "/api/atc/tower", { name: "SBGR", latitude: 1, longitude: 1 }, "c1", { ...M, "X-Atc": code })).st === 200);
  T("health atc true", (await A("GET", "/api/health", null, "c1", { ...M, "X-Atc": code })).j.atc === true);
  T("cred without group = public", (await A("PUT", "/api/atc/tower", { name: "SBKP", latitude: 1, longitude: 1 }, "c9", { "X-Atc": code })).st === 200);
  T("revoke", (await A("DELETE", "/api/manager/creds?code=" + code, null, "m1", B)).st === 200);
  T("revoked cred refused at once", (await A("PUT", "/api/atc/tower", { name: "SBGR", latitude: 1, longitude: 1 }, "c1", { ...M, "X-Atc": code })).st === 403);
  T("revoke unknown 404", (await A("DELETE", "/api/manager/creds?code=ZZZ", null, "m1", B)).st === 404);
  T("client X-Mgr can't spoof", (await A("GET", "/api/manager/creds", null, "m1", { "X-Mgr": "1" })).st === 403);
}

// Credential holder names + restricted controller actions
{
  const cenv = { ...env, GROUP_CODE: "tango7", ATC_CODES: "JOHN-1=John", MANAGER_CODES: "B1, B2" };
  const A = async (method, path, body, key, hdr = {}) => {
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, ...hdr } }), cenv);
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { st: r.status, j };
  };
  const T = (n, v) => console.log("ctl " + n + ":", v ? "PASS" : "FAIL");
  const M = { "X-Group": "tango7" };
  T("second manager code works", (await A("GET", "/api/manager/creds", null, "m", { "X-Manager": "B2" })).st === 200);
  const g = (await A("PUT", "/api/manager/creds", { name: "Ana" }, "m", { "X-Manager": "B1" })).j.code;
  await A("PUT", "/api/position", { latitude: 1, longitude: 1, altitude_ft: 3000, heading_true: 90, ground_speed: 120, freq: "118.000" }, "p1", M);
  await A("PUT", "/api/flightplan", { callsign: "PIL1" }, "p1", M);
  const traffic = async (hdr) => (await A("GET", "/api/traffic?lat=1&lon=1&radius_miles=500", null, "v", hdr)).j.aircraft;
  const icao = (await traffic(M)).find(x => x.callsign === "PIL1").icao_address;
  T("member no cred: squawk 403", (await A("PUT", "/api/atc/squawk", { icao_address: icao, code: "2101" }, "c1", M)).st === 403);
  T("member no cred: message 403", (await A("PUT", "/api/atc/message", { icao_address: icao, text: "hi" }, "c1", M)).st === 403);
  T("member no cred: voice 403", (await A("PUT", "/api/atc/voice", { icao_address: icao, audio: "AAAA", mime: "audio/webm", ms: 500 }, "c1", M)).st === 403);
  T("member no cred: clear squawk 403", (await A("DELETE", "/api/atc/squawk?icao_address=" + icao, null, "c1", M)).st === 403);
  await A("PUT", "/api/atc/tower", { name: "SBAA_TWR", latitude: 1, longitude: 1, holder: "h1", owner: "h1" }, "h1", { ...M, "X-Atc": "JOHN-1" });
  T("managed cred: squawk ok", (await A("PUT", "/api/atc/squawk", { icao_address: icao, code: "2101", holder: "h1", freq: "118.000" }, "c1", { ...M, "X-Atc": g })).st === 200);
  T("squawk: no role refused", (await A("PUT", "/api/atc/squawk", { icao_address: icao, holder: "nobody", freq: "118.000" }, "c1", { ...M, "X-Atc": g })).st === 409);
  T("squawk: other frequency refused", (await A("PUT", "/api/atc/squawk", { icao_address: icao, holder: "h1", freq: "121.900" }, "c1", { ...M, "X-Atc": g })).j.error === "not_tuned");
  T("squawk: clear other frequency refused", (await A("DELETE", "/api/atc/squawk?icao_address=" + icao + "&holder=h1&freq=121.900", null, "c1", { ...M, "X-Atc": g })).st === 409);
  T("managed cred: message ok", (await A("PUT", "/api/atc/message", { icao_address: icao, text: "hi", holder: "h1", freq: "118.000" }, "c1", { ...M, "X-Atc": g })).st === 200);
  const claim = async (name, hdr, h) => (await A("PUT", "/api/atc/tower", { name, latitude: 1, longitude: 1, holder: h, owner: h }, h, { ...M, ...hdr })).st;
  T("open airport", (await claim("SBAA", { "X-Atc": "JOHN-1" }, "h1")) === 200);
  T("claim role (env label)", (await claim("SBAA_TWR", { "X-Atc": "JOHN-1" }, "h1")) === 200);
  const role = ap => ap.find(x => x.callsign === "ATC_SBAA").positions.find(x => x.pos === "TWR");
  T("env label shown", role(await traffic({ ...M, "X-Atc": "JOHN-1" })).ctl === "John");
  T("claim role (managed name)", (await claim("SBAA_GND", { "X-Atc": g }, "h2")) === 200);
  T("managed name shown", (await traffic(M)).find(x => x.callsign === "ATC_SBAA").positions.find(x => x.pos === "GND").ctl === "Ana");
  T("public users unaffected", (await A("PUT", "/api/atc/message", { icao_address: icao, text: "x" }, "c2")).st !== 403);
}

// profile
{
  const T = (n, v) => console.log("profile " + n + ":", v ? "PASS" : "FAIL");
  const raw = async (method, path, body) => { const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": "pk", "Content-Type": "application/json" } }), env); return { s: r.status, t: await r.text() }; };
  const g = await raw("GET", "/api/profile");
  T("get ok", g.s === 200 && JSON.parse(g.t).nick === "");
  const p = await raw("PUT", "/api/profile", { nick: "Cayden<b>" });
  T("put saves nick, strips <>", p.s === 200 && JSON.parse(p.t).nick === "Caydenb");
}

// airport lead approval + handoff
{
  const T = (n, v) => console.log("lead " + n + ":", v ? "PASS" : "FAIL");
  const raw = async (method, path, body, mem) => { const h = { "X-API-Key": "k" }; if (mem) h["X-Member"] = "1";
    const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: h }), env); return { s: r.status, t: await r.text() }; };
  const put = (name, extra) => (hub.lastClaim.clear(), raw("PUT", "/api/atc/tower", { name, latitude: -15.87, longitude: -47.92, ...extra }).then(r => r.s));
  const post = (path, b, mem) => raw("POST", path, b, mem).then(r => r.s);
  const traf = async () => JSON.parse((await raw("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=3000")).t).aircraft;
  hub.towers.clear(); hub.credOn = false; hub.creds.clear();
  await put("SBLD", { owner: "lead" });
  T("claim ok while approval off", await put("SBLD_TWR", { holder: "a1", freq: "118.3" }) === 200);
  T("non-owner cannot switch approval", await post("/api/atc/approval", { airport: "SBLD", on: true, holder: "a1" }) === 403);
  T("owner switches approval on", await post("/api/atc/approval", { airport: "SBLD", on: true, holder: "lead" }) === 200 && hub.towers.get("SBLD").approval === true);
  T("existing controller stays approved (heartbeat ok)", await put("SBLD_TWR", { holder: "a1", freq: "118.3" }) === 200);
  T("newcomer refused: approval_required", await put("SBLD_GND", { holder: "n1", freq: "121.9" }) === 409 && !hub.towers.has("SBLD_GND"));
  T("refused claim does not start the cooldown", !hub.lastClaim.has("n1"));
  let e = (await traf()).find(a => a.callsign === "ATC_SBLD");
  T("traffic lists approval + pending (no raw ids)", e.approval === true && e.pending.length === 1 && e.pending[0].pos === "GND" && !JSON.stringify(e).includes('"n1"'));
  const ph = e.pending[0].hid;
  T("non-owner cannot approve", await post("/api/atc/approve", { airport: "SBLD", hid: ph, holder: "a1" }) === 403);
  T("owner approves", await post("/api/atc/approve", { airport: "SBLD", hid: ph, holder: "lead" }) === 200);
  T("approved newcomer can claim", await put("SBLD_GND", { holder: "n1", freq: "121.9" }) === 200);
  T("pending cleared", !(await traf()).find(a => a.callsign === "ATC_SBLD").pending.length);
  await put("SBLD_DEP", { holder: "n2" });
  const ph2 = (await traf()).find(a => a.callsign === "ATC_SBLD").pending[0].hid;
  T("owner denies", await post("/api/atc/approve", { airport: "SBLD", hid: ph2, allow: false, holder: "lead" }) === 200 && await put("SBLD_DEP", { holder: "n2" }) === 409);
  T("member bypasses approval", await worker.fetch(new Request("https://x/api/atc/tower", { method: "PUT", body: JSON.stringify({ name: "SBLD_APP", latitude: -15.87, longitude: -47.92, holder: "m1" }), headers: { "X-API-Key": "k", "X-Group": "tango7" } }), { ...env, GROUP_CODE: "tango7" }).then(r => r.status) === 200);
  T("owner claims own role", await put("SBLD_DEL", { holder: "lead" }) === 200);
  T("approval survives airport re-PUT", await put("SBLD", { owner: "lead" }) === 200 && hub.towers.get("SBLD").approval === true && hub.towers.get("SBLD").ok.n1);
  // handoff
  await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, altitude_ft: 3500, ground_speed: 0 }, "pl1");
  await call("PUT", "/api/flightplan", { callsign: "HND1" }, "pl1");
  const icao = (await traf()).find(a => a.callsign === "HND1").icao_address;
  const ho = (b) => post("/api/atc/handoff", { icao_address: icao, ...b }), acc = (b) => post("/api/atc/handoff/accept", { icao_address: icao, ...b });
  T("handoff needs a role", await ho({ to: "GND", holder: "nobody" }) === 409);
  T("handoff to unstaffed role refused", await ho({ to: "DEP", holder: "a1" }) === 409);
  T("handoff to own role refused", await ho({ to: "TWR", holder: "a1" }) === 400);
  T("handoff TWR -> GND", await ho({ to: "GND", holder: "a1" }) === 200);
  let h = (await traf()).find(a => a.callsign === "HND1");
  T("traffic shows pending handoff", h.handoff_from === "TWR" && h.handoff_to === "GND" && !h.handler);
  T("wrong role cannot accept", await acc({ holder: "a1", accept: true }) === 404);
  T("GND accepts", await acc({ holder: "n1", accept: true }) === 200);
  h = (await traf()).find(a => a.callsign === "HND1");
  T("handler is GND, handoff cleared", h.handler === "GND" && !h.handoff_to);
  const pr = await call("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, altitude_ft: 3500, ground_speed: 0 }, "pl1");
  T("pilot told to contact ground with freq", /Contact ground 121\.900/.test(pr));
  T("only the handler can hand off", await ho({ to: "DEL", holder: "a1" }) === 409);
  T("handler hands back, TWR declines", await ho({ to: "TWR", holder: "n1" }) === 200 && await acc({ holder: "a1", accept: false }) === 200 && (await traf()).find(a => a.callsign === "HND1").handler === "GND");
  hub.towers.get("SBLD_GND").at = Date.now() - 200_000;
  T("handler tag drops when the role goes away", !(await traf()).find(a => a.callsign === "HND1").handler);
}
