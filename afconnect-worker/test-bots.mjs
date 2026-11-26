import worker, { Hub } from "./src/index.js";
import { mkBot, advance, posOf, TYPES, perf } from "./src/bots.js";
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
// ---- engine: A (0,0) -> B (0,2) (120 nm east), runway 10 at B (heading 090, threshold 0,2.0), loop with 60 s turnaround
const ilsB = { thr: { lat: 0, lon: 2 }, hdg: 90, mv: 0, elev: 100, rwy: "09" };
const A = { lat: 0, lon: 0, elev: 20, ils: null }, B = { lat: 0, lon: 2.002, elev: 100, ils: ilsB };
const T0 = 1_000_000;
const def = { callsign: "TST1", model: "A320", dep: "AAAA", arr: "BBBB", cruise: 20000, wps: [], loop: true, turn: 60 };
const b = mkBot(1, def, A, B, T0);
let now = T0, maxAlt = 0, sawFinal = false, minAglFinal = 1e9, landedAt = 0, maxGs = 0;
for (let i = 0; i < 4000 && !landedAt; i++) {   // 1 s reads, like a busy server
  now += 1000; advance(b, now);
  if (b.s.mode === "wait" && b.s.landed) landedAt = now;
  if (b.s.mode === "fly") { maxAlt = Math.max(maxAlt, b.s.alt); maxGs = Math.max(maxGs, b.s.gs); if (b.s.final) sawFinal = true; }
}
t("climbs to the cruise level", maxAlt > 19900 && maxAlt < 20300);
t("lands on the runway after the final", sawFinal && landedAt > 0 && b.s.landed === 1);
t("landing takes a plausible time (15-40 min)", (landedAt - T0) / 60000 > 15 && (landedAt - T0) / 60000 < 40);
t("ground speed within the type", maxGs <= perf("A320").cr + 1);
t("then waits hidden and flips the leg", b.s.mode === "wait" && b.s.leg === 1);
// lazy catch-up: the same flight advanced with ONE call after a long gap lands too
const c = mkBot(2, def, A, B, T0);
advance(c, T0 + 2000);   // spawn
advance(c, T0 + 3600_000);
t("one big catch-up step also lands and wraps", c.s.landed >= 1);
// one-way bot is finished after landing
const o = mkBot(3, { ...def, loop: false }, A, B, T0); let res = null;
for (let i = 0; i < 4000 && res !== "done"; i++) { now = T0 + (i + 1) * 1000; res = advance(o, now); }
t("one-way bot reports done", res === "done");
// delayed start
const dl = mkBot(4, def, A, B, T0, 600);
advance(dl, T0 + 300_000); t("delayed bot still waiting", dl.s.mode === "wait");
advance(dl, T0 + 601_000); t("delayed bot airborne after the delay", dl.s.mode === "fly");
const p = posOf(dl, T0 + 601_000); t("pos has pilot-upload fields", p.callsign === "TST1" && p.phase === "air" && Number.isFinite(p.altitude_ft) && p.bot === true && /^BB/.test(p.icao_address));
// no runway data: lands at the airport point
const n = mkBot(5, def, A, { ...B, ils: null }, T0); let lnd = 0;
for (let i = 0; i < 4000 && !lnd; i++) { now = T0 + (i + 1) * 1000; advance(n, now); if (n.s.landed) lnd = 1; }
t("lands without runway data too", lnd === 1);

// ---- Hub integration
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: f => f() };
const hub = new Hub(ctx);
const call = async (method, path, body, key = "k1", hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "Content-Type": "application/json", ...hdr } })); let j = {}; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
const M = { "X-Mgr": "1" };
t("page served", (await worker.fetch(new Request("https://x/aipilots"), { HUB: {} })).status === 200);
t("not manager refused", (await call("GET", "/api/manager/bots")).s === 403 && (await call("POST", "/api/manager/bots", {})).s === 403);
hub.apts.set("SBGR", { at: Date.now(), a: { lat: -23.43, lon: -46.47, elev: 2461 } }); hub.apts.set("SBGL", { at: Date.now(), a: { lat: -22.81, lon: -43.25, elev: 28 } });
let r = await call("POST", "/api/manager/bots", { callsign: "TAM3001", model: "A320", dep: "SBGR", arr: "SBGL", cruise: "FL330", count: 3, spacing_min: 0 }, "m", M);
t("adds 3 bots with counting callsigns", r.s === 200 && r.j.added === 3);
r = await call("GET", "/api/manager/bots", null, "m", M);
t("listed", r.j.bots.length === 3 && r.j.bots.map(x => x.callsign).join() === "TAM3001,TAM3002,TAM3003");
t("bad airport refused", (await call("POST", "/api/manager/bots", { callsign: "X1", dep: "SBGR", arr: "SBGR" }, "m", M)).j.error === "bad_airports");
t("unknown airport refused", (await call("POST", "/api/manager/bots", { callsign: "X1", dep: "SBGR", arr: "ZZZZ" }, "m", M)).j.error === "airport_not_found");
// a pilot sees them in traffic, positions move between reads
await call("PUT", "/api/position", { latitude: -23.4, longitude: -46.4, altitude_ft: 3000, ground_speed: 200, heading_true: 90, phase: "air" }, "dev1");
r = await call("GET", "/api/traffic?lat=-23.4&lon=-46.4&radius_miles=100", null, "dev1");
const bt = r.j.traffic.filter(x => /^TAM30/.test(x.callsign));
t("bots appear in traffic", bt.length === 3 && bt[0].phase === "air" && bt[0].departure_airport === "SBGR" && bt[0].arrival_airport === "SBGL");
const p0 = bt[0].latitude + "," + bt[0].longitude;
hub.botT -= 5000; hub.bots.get(1).s.t -= 5000;
r = await call("GET", "/api/traffic?lat=-23.4&lon=-46.4&radius_miles=100", null, "dev1");
t("positions advance on read", r.j.traffic.find(x => x.callsign === "TAM3001").latitude + "," + r.j.traffic.find(x => x.callsign === "TAM3001").longitude !== p0);
t("bots are not counted as pilots", (await call("GET", "/api/health", null, "dev1")).j.pilots === 1);
// persisted and removable
await hub.saveBots(); t("saved to storage", store.get("bots").list.length === 3);
r = await call("DELETE", "/api/manager/bots?id=1", null, "m", M); t("remove one", r.j.success && hub.bots.size === 2 && !hub.clients.has("bot:1"));
r = await call("DELETE", "/api/manager/bots?all=1", null, "m", M); t("remove all", hub.bots.size === 0 && ![...hub.clients.keys()].some(k => k.startsWith("bot:")));
console.log(fails ? fails + " FAILED" : "all ok"); process.exit(fails ? 1 : 0);
