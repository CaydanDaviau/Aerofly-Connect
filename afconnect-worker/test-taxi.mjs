import worker, { Hub, TEST } from "./src/index.js";
TEST.skipGrades = true; TEST.warnLimit = 0;
import { exitAhead, buildGraph, nearest, holdNode, holdNodes, pickHold, route, legs, spokenName } from "./src/taxi.js";
const T = (n, v) => console.log("taxi " + n + ":", v ? "PASS" : "FAIL");
// synthetic airport: runway 09/27 along lat 0, parallel taxiway A (north), connectors B (east), C (west), crossing D to taxiway S (south)
const B0 = [-15.87, -47.92], P = (la, lo) => ({ lat: B0[0] + la, lon: B0[1] + lo });
let id = 1; const N = {};
const way = (tags, pts, names) => ({ type: "way", id: id++, tags, nodes: names, geometry: pts });
const nd = (name, la, lo) => { N[name] = { id: 100 + Object.keys(N).length, ...P(la, lo) }; return N[name]; };
[["R1", 0, -.01], ["R2", 0, 0], ["X", 0, .005], ["R3", 0, .01], ["A1", .0008, -.01], ["A2", .0008, 0], ["A5", .0008, .005], ["A3", .0008, .01], ["B2", .0004, .01], ["C2", .0004, -.01], ["D1", .0004, .005], ["D2", -.0004, .005], ["S1", -.0008, .005], ["S2", -.0008, .0]].forEach(a => nd(...a));
const W = (tags, names) => way(tags, names.map(n => ({ lat: N[n].lat, lon: N[n].lon })), names.map(n => N[n].id));
const J = { elements: [
  W({ aeroway: "runway", ref: "09/27" }, ["R1", "R2", "X", "R3"]),
  W({ aeroway: "taxiway", ref: "A" }, ["A1", "A2", "A5", "A3"]),
  W({ aeroway: "taxiway", ref: "B" }, ["A3", "B2", "R3"]),
  W({ aeroway: "taxiway", ref: "C" }, ["R1", "C2", "A1"]),
  W({ aeroway: "taxiway", ref: "D" }, ["A5", "D1", "X", "D2", "S1"]),
  W({ aeroway: "taxiway", ref: "S" }, ["S1", "S2"]),
  { type: "node", id: 9001, lat: N.A1.lat, lon: N.A1.lon, tags: { aeroway: "gate", ref: "G1" } },
  { type: "node", id: 9002, lat: N.S2.lat, lon: N.S2.lon, tags: { aeroway: "gate", ref: "S9" } },
] };
const g = buildGraph(J);
T("graph built", g.edges.length > 10 && g.stands.length === 2 && g.runways.length === 1);
const h = holdNode(g, "27");
T("hold short node on connector B (near east threshold, off the runway)", h && h.id === N.B2.id);
const a1 = nearest(g, N.A1.lat, N.A1.lon);
let path = route(g, a1.id, h.id);
let lg = legs(path, g);
T("taxi-out legs Alpha then Bravo", lg.map(l => l.name).join(",") === "A,B");
T("spoken names", spokenName("A") === "Alpha" && spokenName("A1") === "Alpha 1" && spokenName("Y") === "Yankee");
const s9 = g.stands.find(s => s.ref === "S9");
path = route(g, a1.id, s9.node);
lg = legs(path, g);
T("route to S9 crosses the runway via D", lg.some(l => l.kind === "rwy" && l.cross) && lg.map(l => l.name).join(",") === "A,D,09/27,D,S");
// conflict avoidance: with A reserved, penalty makes no difference here (only path), but extra cost is honoured
let used = 0; route(g, a1.id, h.id, e => { used++; return 0; }); T("extra cost callback used", used > 0);

// hold-short side: aircraft on the south side must not be sent across the runway to the nearer north hold point (180 deg turn back onto it)
{
  const q = (name, la, lo) => { N[name] = { id: 100 + Object.keys(N).length, ...P(la, lo) }; };
  q("TR1", 0, -.01); q("TX", 0, -.005); q("TR3", 0, .01); q("TNa", .0008, -.005); q("TNb", .0008, .0101); q("THn", .0004, .0101);
  q("TSa", -.0008, -.005); q("TSb", -.0008, .0103); q("THs", -.0004, .0103);
  const g2 = buildGraph({ elements: [
    W({ aeroway: "runway", ref: "09/27" }, ["TR1", "TX", "TR3"]),
    W({ aeroway: "taxiway", ref: "N" }, ["TNa", "TNb", "THn"]),
    W({ aeroway: "taxiway", ref: "D" }, ["TNa", "TX", "TSa"]),
    W({ aeroway: "taxiway", ref: "S" }, ["TSa", "TSb", "THs"]),
  ] });
  const hs = holdNodes(g2, "27");
  T("two hold candidates, one per side", hs.length === 2 && hs[0].id === N.THn.id && hs[1].id === N.THs.id);
  const south = nearest(g2, N.TSa.lat, N.TSa.lon), north = nearest(g2, N.TNa.lat, N.TNa.lon);
  T("south aircraft holds on the south side (no runway crossing)", pickHold(g2, "27", south.id).node.id === N.THs.id);
  T("north aircraft holds on the north side", pickHold(g2, "27", north.id).node.id === N.THn.id);
}

// ---- integration: Hub with mocked Overpass
// rollout: exit must be ahead of the aircraft, never behind
{
  const brg = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
  const h1 = brg(N.R1, N.R3), mid = { lat: (N.R2.lat + N.X.lat) / 2, lon: (N.R2.lon + N.X.lon) / 2 };
  const e1 = exitAhead(g, mid.lat, mid.lon, h1, 40);
  T("rollout toward R3: exit ahead (X or R3), not R1", !!e1 && (e1.node.id === N.X.id || e1.node.id === N.R3.id));
  const e2 = exitAhead(g, mid.lat, mid.lon, (h1 + 180) % 360, 40);
  T("rollout toward R1: exit ahead is R2/R1 side", !!e2 && e2.node.id !== N.R3.id && e2.node.id !== N.X.id);
  T("not on a runway: no exit logic", exitAhead(g, N.A3.lat, N.A3.lon, h1, 40) === null);
}
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f() };
const hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
const call = async (method, path, body, key) => { const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key } }), env); return JSON.parse((await r.text()) || "{}"); };
let overpass = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { if (String(u).includes("overpass")) { overpass++; return new Response(JSON.stringify(J)); } return realFetch(u, o); };
const pos = (k, o) => call("PUT", "/api/position", { latitude: N.A1.lat, longitude: N.A1.lon, altitude_ft: 3500, ground_speed: 0, freq: "118.000", phase: "ground", ...o }, k);
await call("PUT", "/api/flightplan", { callsign: "TX1", departure_airport: "SBBR", departure_runway: "27", arrival_airport: "SBBR", arrival_runway: "27" }, "t1");
await call("PUT", "/api/flightplan", { callsign: "TX2", departure_airport: "SBBR", departure_runway: "27" }, "t2");
await pos("t1"); await pos("t2", { latitude: N.A2.lat, longitude: N.A2.lon });
await new Promise(r => setTimeout(r, 50));
T("graph prefetched once", overpass === 1);
const R = async (k, b) => { hub.clients.get(k).lastReq = 0; return call("PUT", "/api/atc/request", b, k); };
let r = await R("t1", { type: "pushback" });
T("pushback approved", r.messages[0].text === "Startup and pushback approved, facing west, expect runway 27");
r = await R("t1", { type: "taxi" });
T("taxi route with names", r.messages[0].text === "Taxi to holding point runway 27 via Alpha, Bravo");
// second aircraft starts on the same taxiway: occupied/reserved edges -> give way note
r = await R("t2", { type: "taxi" });
T("second aircraft told to give way", /^Taxi to holding point runway 27 via Alpha, Bravo, give way to TX1$/.test(r.messages[0].text));
r = await R("t1", { type: "taxi", lang: "pt" });
T("pt route", /^Táxi para o ponto de espera da pista 27 via Alfa|^Táxi para o ponto de espera da pista 27 via Alpha/.test(r.messages[0].text));
// arrival: touchdown, then slow on the runway near R1 -> route to the gate comes as a normal message
await pos("t1", { phase: "air", altitude_ft: 3600, ground_speed: 130, arr_nm: 3 });
hub.clients.get("t1").st.gr.land = Date.now() + 60000;
await pos("t1", { latitude: N.R1.lat, longitude: N.R1.lon + .0005, phase: "runway", rwy_on: "09/27", on_rwy: "27", rwy_apt: "SBBR", ground_speed: 90, altitude_ft: 3500 });
hub.clients.get("t1").st.landedAt = Date.now() - 10000;
await pos("t1", { latitude: N.R1.lat, longitude: N.R1.lon + .0005, phase: "runway", rwy_on: "09/27", on_rwy: "27", rwy_apt: "SBBR", ground_speed: 20 });
await new Promise(r => setTimeout(r, 80));
r = await pos("t1", { latitude: N.R1.lat, longitude: N.R1.lon + .0005, phase: "runway", ground_speed: 15 });
T("gate route after landing", r.messages.some(m => /^Táxi para o portão G1 via Charlie/.test(m.text)));
globalThis.fetch = realFetch;

// ---- waypoint tracking
{
  const store2 = new Map();
  const ctx2 = { storage: { get: async k => store2.get(k), put: async (k, v) => store2.set(k, v), delete: async k => store2.delete(k), list: async () => new Map() }, blockConcurrencyWhile: async f => f() };
  const h2 = new Hub(ctx2);
  const env2 = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => h2.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
  const c2 = async (m, p, b, k) => { const r = await worker.fetch(new Request("https://x" + p, { method: m, body: b && JSON.stringify(b), headers: { "X-API-Key": k } }), env2); return JSON.parse((await r.text()) || "{}"); };
  const W = (n, v) => console.log("wp " + n + ":", v ? "PASS" : "FAIL");
  await c2("PUT", "/api/flightplan", { callsign: "WP1", departure_airport: "SBBR", arrival_airport: "SBGR", arrival_runway: "09R" }, "w1");
  const pos2 = o => c2("PUT", "/api/position", { latitude: -15.87, longitude: -47.92, altitude_ft: 3500, ground_speed: 0, freq: "118.000", phase: "ground", ...o }, "w1");
  await pos2({});
  await c2("PUT", "/api/flightplan/route", { points: [[-15.87, -47.92, 0, "SBBR"], [-16.5, -47.5, 20000, "ABCDE"], [-20, -46, 30000, "FGHIJ"], [-23.4, -46.4, 0, "SBGR"]], route: "x" }, "w1");
  await pos2({ phase: "runway", rwy_on: "11R/29L", on_rwy: "29L", rwy_apt: "SBBR", ground_speed: 80 });
  hub2: { const cl = h2.clients.get("w1"); cl.st.gr.takeoff = Date.now() + 60000; cl.st.grace = 0; }
  let rr = await pos2({ phase: "air", altitude_ft: 4500, ground_speed: 150, latitude: -15.9, longitude: -47.9 });
  W("direct to first fix after departure", rr.messages.some(m => m.text === "Proceed direct ABCDE"));
  rr = await pos2({ phase: "air", altitude_ft: 8000, ground_speed: 200, latitude: -15.95, longitude: -47.85 });
  W("direct said once", !rr.messages.some(m => /direct ABCDE/.test(m.text)));
  // way off the leg for over a minute
  const cl = h2.clients.get("w1");
  rr = await pos2({ phase: "air", altitude_ft: 20000, ground_speed: 300, latitude: -17, longitude: -43 });
  cl.st.wp.off = Date.now() - 61000;
  rr = await pos2({ phase: "air", altitude_ft: 20000, ground_speed: 300, latitude: -17, longitude: -43 });
  W("no off-route call any more", !rr.messages.some(m => /off route/.test(m.text)));
  rr = await pos2({ phase: "air", altitude_ft: 20000, ground_speed: 300, latitude: -17, longitude: -43 });
  W("off-route not repeated", !rr.messages.some(m => /off route/.test(m.text)));
  // joins mid-route, already past the first fix: next fix is the one ahead, never the one behind
  await c2("PUT", "/api/flightplan", { callsign: "WP2", departure_airport: "SBBR", arrival_airport: "SBGR" }, "w2");
  await c2("PUT", "/api/flightplan/route", { points: [[-15.87, -47.92, 0, "SBBR"], [-16.5, -47.5, 20000, "ABCDE"], [-20, -46, 30000, "FGHIJ"], [-23.4, -46.4, 0, "SBGR"]], route: "x" }, "w2");
  await c2("PUT", "/api/position", { latitude: -18, longitude: -46.8, altitude_ft: 30000, ground_speed: 420, phase: "air" }, "w2");
  W("mid-route join starts at the fix ahead", h2.clients.get("w2").st.wp.i === 2);
  await c2("PUT", "/api/position", { latitude: -19.5, longitude: -46.2, altitude_ft: 30000, ground_speed: 420, phase: "air" }, "w2");
  W("still ahead after more progress", h2.clients.get("w2").st.wp.i === 2);
  await c2("PUT", "/api/position", { latitude: -20.6, longitude: -45.8, altitude_ft: 30000, ground_speed: 420, phase: "air" }, "w2");
  W("passed fix is skipped (moves to next)", h2.clients.get("w2").st.wp.i === 3);
  // approach call also gives expected runway
  rr = await pos2({ phase: "air", altitude_ft: 9000, ground_speed: 250, latitude: -23, longitude: -46.5, arr_nm: 30 });
  W("approach + expect runway", rr.messages.some(m => /Contact approach/.test(m.text)) && rr.messages.some(m => m.text === "Expect runway 09R"));
  const hl = await worker.fetch(new Request("https://x/api/health"), env2); const hj = await hl.json();
  W("health carries latest versions", typeof hj.latest_android === "string" && typeof hj.latest_pc === "string");
}

// ---- the auto message carries the taxi route (controller's taxi clearance, and a drawn route)
{
  const gc = (path, body) => call("PUT", path, { holder: "hg", freq: "118.000", ...body }, "gc");
  await gc("/api/atc/tower", { name: "SBBR_GND", latitude: B0[0], longitude: B0[1] });
  const c2 = hub.clients.get("t2"), c1 = hub.clients.get("t1"), i2 = c2.pos.icao_address, i1 = c1.pos.icao_address;
  const texts = icao => [...hub.msgs.values()].filter(m => m.icao === icao).map(m => m.text);
  hub.msgs.clear(); if (c2.st) c2.st.landedAt = 0;
  await gc("/api/atc/clearance", { icao_address: i2, type: "taxi", on: true, msg: false });
  T("auto msg off: no text", texts(i2).length === 0);
  hub.clients.get("t2").taxi = null; hub.msgs.clear();
  await gc("/api/atc/clearance", { icao_address: i2, type: "taxi", on: true, msg: true });
  const t2 = texts(i2).find(x => /^Taxi/.test(x));
  T("taxi clearance auto msg = route to the runway", /^Taxi to holding point runway 27 via .+$/.test(t2 || ""));
  // drawn route
  c1.lang = "en";
  const dr = (b) => gc("/api/atc/taxiroute", { icao_address: i1, lat: N.S2.lat, lon: N.S2.lon, ...b });
  hub.msgs.clear(); let r = await dr({ preview: true, msg: true });
  T("drawn route: preview sends nothing", r.success && r.text && texts(i1).length === 0);
  hub.msgs.clear(); r = await dr({ preview: false, msg: false });
  T("drawn route, auto msg off: no text", r.success && texts(i1).length === 0);
  hub.msgs.clear(); r = await dr({ preview: false, msg: true });
  const t1 = texts(i1)[0] || "";
  T("drawn route, auto msg on: text with the taxiways and the gate", /^Taxi to gate S9 via /.test(t1) && /Alpha/.test(t1) && /cross runway 09/.test(t1));
  hub.msgs.clear();
  await gc("/api/atc/clearance", { icao_address: i1, type: "taxi", on: true, msg: true });
  T("taxi clearance after a drawn route repeats that route", texts(i1)[0] === t1);
  // Portuguese
  hub.msgs.clear(); c1.lang = "pt"; await dr({ preview: false, msg: true });
  T("Portuguese phrase", /^Táxi para o portão S9 via /.test(texts(i1)[0] || ""));
}

// ---- Auto ATC switched off in Settings
{
  hub.towers.clear(); hub.locks.clear();
  const c = hub.clients.get("t2"), body = { ...c.pos };
  delete body.auto_atc;
  let r = await call("PUT", "/api/position", { ...body, auto_atc: false }, "t2");
  T("auto_atc:false stored from the upload", hub.clients.get("t2").pos.auto_atc === false);
  hub.clients.get("t2").lastReq = 0;
  r = await call("PUT", "/api/atc/request", { type: "taxi" }, "t2");
  T("Auto ATC off: request gets no automatic answer", r.success && r.mode === "none" && (r.messages || []).length === 0);
  r = await call("PUT", "/api/position", { ...body, auto_atc: true }, "t2"); hub.clients.get("t2").lastReq = 0;
  r = await call("PUT", "/api/atc/request", { type: "taxi" }, "t2");
  T("Auto ATC on: request answered automatically", r.mode === "auto" && r.messages.length > 0);
}
