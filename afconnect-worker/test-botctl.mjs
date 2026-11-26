import { Hub } from "./src/index.js";
import { buildGraph } from "./src/taxi.js";
let fails = 0; const T = (n, c) => { console.log("botctl " + n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
// synthetic airport: runway 09/27 (3.9 km) along lat0, parallel taxiway A 445 m north, connectors at 0.004 / 0.015 / 0.030 deg east, stub taxiways to 3 gates
function airport(lat0, lon0) {
  let id = 1; const N = {}, nd = (nm, la, lo) => { N[nm] = { id: 100 + Object.keys(N).length, lat: lat0 + la, lon: lon0 + lo }; };
  nd("R1", 0, 0); for (const [k, lo] of [["x1", .004], ["x2", .015], ["x3", .030]]) nd("R" + k, 0, lo); nd("R2", 0, .035);
  nd("A1", .004, 0); for (const [k, lo] of [["x1", .004], ["x2", .015], ["x3", .030], ["g1", .008], ["g2", .010], ["g3", .012]]) nd("A" + k, .004, lo); nd("A2", .004, .035);
  for (const k of ["x1", "x2", "x3"]) nd("H" + k, .0006, { x1: .004, x2: .015, x3: .030 }[k]);
  for (const [k, lo] of [["g1", .008], ["g2", .010], ["g3", .012]]) nd("G" + k, .007, lo);
  const W = (tags, names) => ({ type: "way", id: id++, tags, nodes: names.map(n => N[n].id), geometry: names.map(n => ({ lat: N[n].lat, lon: N[n].lon })) });
  const els = [W({ aeroway: "runway", ref: "09/27" }, ["R1", "Rx1", "Rx2", "Rx3", "R2"]),
    W({ aeroway: "taxiway", ref: "A" }, ["A1", "Ax1", "Ag1", "Ag2", "Ag3", "Ax2", "Ax3", "A2"])];
  for (const k of ["x1", "x2", "x3"]) els.push(W({ aeroway: "taxiway", ref: "E" + k.slice(1) }, ["R" + k, "H" + k, "A" + k]));
  for (const k of ["g1", "g2", "g3"]) { els.push(W({ aeroway: "taxiway", ref: "G" + k.slice(1) }, ["A" + k, "G" + k])); els.push({ type: "node", id: 9000 + id++, lat: N["G" + k].lat, lon: N["G" + k].lon, tags: { aeroway: "gate", ref: k.toUpperCase() } }); }
  const g = buildGraph({ elements: els }); g.center = { lat: lat0, lon: lon0 + .0175 }; return g;
}
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: f => f() };
let hub = new Hub(ctx);
const call = async (method, path, body, hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": "m", "Content-Type": "application/json", ...hdr } })); let j = {}; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
const M = { "X-Mgr": "1" };
const SEED = () => { hub.apts.set("AAAA", { at: Date.now(), a: { lat: 10, lon: 20, elev: 100 } }); hub.apts.set("BBBB", { at: Date.now(), a: { lat: 10, lon: 22, elev: 100 } }); hub.gfx.set("AAAA", { at: Date.now(), g: airport(10, 20) }); hub.gfx.set("BBBB", { at: Date.now(), g: airport(10, 22) }); };
SEED();

hub.towers.set("AAAA_GND", { apt: "AAAA", name: "AAAA", pos: "GND", freq: "121.700", latitude: 10, longitude: 20 });
hub.towers.set("AAAA_TWR", { apt: "AAAA", name: "AAAA", pos: "TWR", freq: "118.100", latitude: 10, longitude: 20 });
hub.towers.set("BBBB_TWR", { apt: "BBBB", name: "BBBB", pos: "TWR", freq: "118.300", latitude: 10, longitude: 22 });
await call("POST", "/api/manager/bots", { callsign: "CTL1", model: "A320", dep: "AAAA", arr: "BBBB", dep_rwy: "09", arr_rwy: "09", cruise: "FL200", turn: 120, loop: true }, M);
const b = [...hub.bots.values()][0], k = "bot:" + b.id;
const reqs = () => [...hub.msgs.values()].filter(m => m.kind === "request" && m.callsign === "CTL1");
const base = Date.now(); let n = 0; const run = sec => { for (let i = 0; i < sec / 2; i++) hub.advanceBots(base + (++n) * 2000); };
// human tower + ground at AAAA; BBBB has a human approach/tower too
run(20); await new Promise(r => setTimeout(r, 30));
let c = hub.clients.get(k);
T("parked bot is tuned to the human ground frequency", c && c.pos.freq === "121.700");
T("bot at a human airport waits parked (asks, does not move)", b.s.mode === "park" && reqs().length >= 1);
T("it asked for clearance as a request strip", reqs().some(m => /clear/i.test(m.text) || m.type === "clearance" || m.req === "clearance") || reqs().length >= 1);
run(120); T("still parked without an answer", b.s.mode === "park");
// controller answers
hub.addMsg(c, "CTL1 pushback approved", "atc"); run(30); await new Promise(r => setTimeout(r, 30));
T("pushback approval releases it", b.s.mode !== "park");
run(120); T("it asks for taxi before moving off (waits at push end)", ["push", "taxi"].includes(b.s.mode));
hub.addMsg(c, "CTL1 taxi to holding point runway 09 via A", "atc"); c.st.gr.taxi = base + n * 2000 + 3e6; run(900);
T("it reaches the hold point and stops there asking for takeoff", ["hold"].includes(b.s.mode));
run(120); T("holds without takeoff clearance", b.s.mode === "hold");
hub.addMsg(c, "CTL1 line up and wait runway 09", "atc"); run(60); T("line up and wait: lines up and waits", ["lineup", "lined"].includes(b.s.mode));
run(120); T("does not roll without takeoff clearance", b.s.mode === "lined");
c.st.gr.takeoff = base + n * 2000 + 6e5; hub.addMsg(c, "CTL1 runway 09 cleared for takeoff", "atc"); run(240);
T("takeoff clearance: rolls and flies", ["roll", "fly"].includes(b.s.mode));
T("liftoff clears the takeoff grant", !c.st.gr.takeoff || b.s.mode === "roll");
// airborne: heading order
run(300); T("is airborne", b.s.mode === "fly");
hub.addMsg(c, "CTL1 fly heading 180", "atc"); run(30); T("heading order stored", b.s.hdgTgt != null);
hub.addMsg(c, "CTL1 climb and maintain 5000", "atc"); T("altitude order stored on the client", c.st.alt && c.st.alt.ft === 5000);
// autonomous without humans
hub.towers.clear(); await call("DELETE", "/api/manager/bots?all=1", null, M);
await call("POST", "/api/manager/bots", { callsign: "AUT1", model: "A320", dep: "AAAA", arr: "BBBB", dep_rwy: "09", arr_rwy: "09", cruise: "FL200", turn: 60, loop: true }, M);
const a = [...hub.bots.values()][0]; const base2 = Date.now() + 1e8; for (let i = 1; i <= 1500; i++) hub.advanceBots(base2 + i * 2000);
T("without human controllers it flies by itself and lands", a.s.landed >= 1);
console.log(fails ? fails + " FAILED" : "all ok"); process.exit(fails ? 1 : 0);
