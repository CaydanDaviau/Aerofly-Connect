import worker, { Hub, TEST } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
const hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
const call = async (method, path, body, key = "k1", hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "X-Member": "0", ...hdr } })); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
TEST.skipGrades = true; TEST.warnLimit = null;
const mk = () => ({ c: { pos: { latitude: 1, longitude: 2 }, plan: { callsign: "TST" }, lang: "en" }, st: { viol: {} } });
const viol = (key, type, at) => { const { c, st } = mk(); hub.violate(key, c, st, type, "SBBR", "", at, () => {}); return c; };
await call("PUT", "/api/position", { latitude: 1, longitude: 2, icao_address: "AAA111" }, "p1");
const pc = hub.clients.get("p1");
// public pilot: two warnings first (with reason), third counts
const w = (type, at) => { const { st } = mk(); hub.violate("p1", pc, st, type, "SBBR", "", at, () => {}); };
w("alt", 1e12); let pf = hub.profGet("p1");
t("warning 1: no points, no timeout", pf.warn === 1 && pf.pen === 0 && pf.vpts === 0 && !hub.locks.get("p1"));
const m1 = [...hub.msgs.values()].pop(); t("warning message has number + reason", /WARNING 1\/2/.test(m1.text) && /altitude/.test(m1.text) && m1.urgent === true);
w("taxi", 1e12 + 400_000); pf = hub.profGet("p1");
t("warning 2: still free", pf.warn === 2 && pf.pen === 0 && pf.vpts === 0);
w("alt", 1e12 + 800_000); pf = hub.profGet("p1");
t("3rd counts: penalty points", pf.pen === 3 && pf.vpts === 3);
w("landing", 1e12 + 1_200_000);
t("landing after warnings: violation + timeout", hub.profGet("p1").violations === 1 && !!hub.locks.get("p1"));
// warnings reset with the daily counters
pf = hub.profGet("p1"); pf.pday = "1999-01-01"; pf = hub.profGet("p1"); t("warnings reset daily", pf.warn === 0);
// ATC timeout (private network)
const M = { "X-Member": "1" };
await call("PUT", "/api/position", { latitude: 1, longitude: 2, icao_address: "BBB222", ground_speed: 100 }, "m1", M);
await call("PUT", "/api/position", { latitude: 1, longitude: 2, icao_address: "CCC333", ground_speed: 100 }, "pub", {});
let r = await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", holder: "hc", latitude: 1, longitude: 2 }, "ctl", M); t("controller role claimed", r.s === 200);
r = await call("PUT", "/api/atc/timeout", { icao_address: "BBB222", holder: "hc", minutes: 10, reason: "Ignored instructions" }, "ctl", {}); t("public controller refused", r.s === 403 && r.j.error === "network_only");
r = await call("PUT", "/api/atc/timeout", { icao_address: "CCC333", holder: "hc", minutes: 10 }, "ctl", M); t("public pilot not reachable", r.s === 404);
r = await call("PUT", "/api/atc/timeout", { icao_address: "BBB222", holder: "nobody", minutes: 10 }, "ctl", M); t("needs a live role", r.s === 409 && r.j.error === "division_required");
r = await call("PUT", "/api/atc/timeout", { icao_address: "BBB222", holder: "hc", minutes: 500 }, "ctl", M); t("minutes capped", r.s === 400);
r = await call("PUT", "/api/atc/timeout", { icao_address: "BBB222", holder: "hc", minutes: 10, reason: "Ignored instructions" }, "ctl", M); t("timeout sent", r.s === 200 && r.j.minutes === 10);
const mp = hub.profGet("m1"); t("no penalty/violation/timeout count on account", mp.pen === 0 && mp.vpts === 0 && mp.violations === 0 && (mp.timeouts || 0) === 0);
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "m1", M); t("pilot gets 423 with reason + time", r.s === 423 && r.j.error === "timeout" && r.j.note === "Ignored instructions" && r.j.remaining_s > 590);
console.log("FAILS: " + fails);
// human taxi clearance: entering a runway is fine, only > 35 kt counts as a takeoff attempt
{
  TEST.warnLimit = 0;
  const run = (gs, taxi) => { const c = { pos: { ground_speed: gs, on_rwy: true, rwy_on: "27", latitude: 1, longitude: 2 }, plan: { callsign: "H1" } }, now = Date.now(), st = { viol: {}, grace: 0, gr: { taxi: taxi ? now + 60_000 : 0, takeoff: 0 } };
    hub.humanTrack("hx", c, st, "runway", "runway", now, "SBBR"); return !!st.viol.runway; };
  t("taxi clearance, 20 kt on runway: no violation", run(20, true) === false);
  t("taxi clearance, 40 kt on runway: violation", run(40, true) === true);
  t("no taxi clearance, on runway: violation", run(5, false) === true);
}
console.log("FAILS: " + fails);
