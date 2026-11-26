import { Hub } from "./src/index.js";
import { buildGraph } from "./src/taxi.js";
let fails = 0; const T = (n, c) => { console.log("botground " + n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
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
let r = await call("POST", "/api/manager/bots", { callsign: "GND1", model: "A320", dep: "AAAA", arr: "BBBB", dep_rwy: "09", arr_rwy: "09", cruise: "FL200", count: 2, spacing_min: 0, turn: 120, loop: true }, M);
T("added with ground plans, no warnings", r.s === 200 && r.j.added === 2 && r.j.warnings.length === 0);
const [b1, b2] = [...hub.bots.values()];
T("ground plan stored (stand, routes, rollout)", b1.G && b1.G.A.out.length > 3 && b1.G.B.in.length > 2 && b1.G.A.inRoll > 800 && store.has("botg:" + b1.id));
T("two bots use different stands", b1.G.A.ref !== b2.G.A.ref && b1.G.B.ref !== b2.G.B.ref);
// run 100 min in 2 s reads; record modes, positions, runway overlap
const base = Date.now(); const phs = new Set(); const seen = new Set(), seq = []; let overlap = 0, offRoad = 0, maxGsTaxi = 0, flew = 0;
const onRwy = m => m === "lineup" || m === "lined" || m === "roll" || m === "rollout";
for (let k = 1; k <= 3000; k++) {
  hub.advanceBots(base + k * 2000);
  const a = [b1, b2].filter(b => b.s.mode !== "wait" && b.s.lat > 9.9 && b.s.lat < 10.1 && b.s.lon < 20.05 && b.s.leg === 0 && ["lineup", "lined", "roll"].includes(b.s.mode));   // two bots on the A runway at once?
  if (a.length > 1) overlap++;
  for (const id of [b1.id, b2.id]) { const q = hub.clients.get("bot:" + id)?.pos; if (q) phs.add(q.phase + (q.phase === "air" ? "" : ":" + (q.ground_speed > 0 ? "moving" : "still"))); }
  for (const b of [b1, b2]) { seen.add(b.s.mode); if (b === b1 && seq[seq.length - 1] !== b.s.mode) seq.push(b.s.mode); if (b.s.mode === "taxi") maxGsTaxi = Math.max(maxGsTaxi, b.s.gs); if (b.s.mode === "fly") flew++; }
}
T("visits every ground phase", ["park", "push", "taxi", "hold", "lineup", "lined", "roll", "fly", "rollout"].every(m => seen.has(m)));
T("sequence push>taxi>hold>lineup>lined>roll>fly>rollout>taxi>park>push (second departure from the other airport)", seq.join(">").startsWith("push>taxi>hold>lineup>lined>roll>fly>rollout>taxi>park>push>taxi>hold"));
T("never two bots lined up/rolling on the same runway", overlap === 0);
T("taxi speed capped", maxGsTaxi <= 18.5);
T("both bots completed a landing and taxied in", b1.s.landed >= 1 && b2.s.landed >= 1);
T("landed bot is parked at the other airport's stand", (() => { const x = [b1, b2].find(b => b.s.leg === 1 && b.s.mode === "park"); return !x || (Math.abs(x.s.lat - x.G.B.stand.lat) < 1e-4 && Math.abs(x.s.lon - x.G.B.stand.lon) < 1e-4); })());
// pos record phases
T("pos phases: ground (still and moving), runway, air", phs.has("ground:still") && phs.has("ground:moving") && phs.has("runway:moving") && phs.has("air"));
// persistence: a new Hub from the same storage restores the ground plans
hub.saveBots(); const hub2 = new Hub(ctx); await new Promise(r => setTimeout(r, 20));
T("ground plans restored after restart", hub2.bots.size === 2 && hub2.bots.get(b1.id).G && hub2.bots.get(b1.id).G.A.ref === b1.G.A.ref);
// removal frees the stand data
await call("DELETE", "/api/manager/bots?all=1", null, M); T("remove all clears bots and ground data", hub.bots.size === 0 && !store.has("botg:" + b1.id));
// missing taxi data -> simple start with a warning
hub.gfx.set("AAAA", { at: Date.now(), g: null }); hub.gfx.set("BBBB", { at: Date.now(), g: null });
r = await call("POST", "/api/manager/bots", { callsign: "NOG1", dep: "AAAA", arr: "BBBB", dep_rwy: "09", arr_rwy: "09" }, M);
T("no taxi data: still added, warning given", r.s === 200 && r.j.added === 1 && r.j.warnings.length >= 1);
console.log(fails ? fails + " FAILED" : "all ok"); process.exit(fails ? 1 : 0);
