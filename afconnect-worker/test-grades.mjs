import worker, { Hub, TEST } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
const hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
const call = async (method, path, body, key = "k1", hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "X-Member": "0", ...hdr } })); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
TEST.skipGrades = false;
const claim = (pos, key = "k1", hdr = {}) => call("PUT", "/api/atc/tower", { name: "SBBR_" + pos, holder: "h-" + key, latitude: -15.87, longitude: -47.92 }, key, hdr);
let r = await claim("GND"); t("everyone starts with GND", r.s === 200);
r = await claim("DEL"); t("DEL allowed (cooldown aside)", r.s === 200 || (r.s === 409 && r.j.error === "role_cooldown"));
r = await claim("TWR"); t("TWR needs grade", r.s === 409 && r.j.error === "grade_required" && r.j.need === "Tower" && r.j.next_req.some(x => x.k === "gw" && x.need === 50));
r = await claim("TWR", "k1", { "X-Member": "1" }); t("network member has every role", r.s === 200 || (r.s === 409 && r.j.error === "role_cooldown"));
const pf = hub.profGet("k1"); pf.atc_s = 3 * 3600; pf.gw = 49;
r = await claim("TWR"); t("3 h but 49 ground work actions: still blocked", r.s === 409 && r.j.error === "grade_required");
for (let i = 0; i < 2; i++) hub.gwCredit("k1", "AC" + i, Date.now());
hub.gwCredit("k1", "AC0", Date.now());   // same aircraft inside 10 min: not counted again
t("ground work: once per aircraft per 10 min", hub.profGet("k1").gw === 51);
t("grade is Tower", hub.gradeInfo(hub.profGet("k1")).atc_grade === 1);
store.clear(); hub.lastClaim.clear();
r = await claim("TWR"); t("TWR allowed with 3 h + 50 actions", r.s === 200);
r = await claim("APP"); t("APP blocked (needs 10 h + 50 own ops)", r.s === 409 && r.j.error === "grade_required" && r.j.next_grade === "Approach");
hub.lastClaim.clear(); pf.atc_s = 10 * 3600; pf.ops = 50;
r = await claim("APP"); t("APP allowed with 10 h + 50 ops", r.s === 200);
hub.lastClaim.clear(); r = await claim("CTR"); t("CTR blocked without 30 h APP", r.s === 409 && r.j.next_grade === "Center" && r.j.next_req[0].k === "app_s");
pf.app_s = 30 * 3600; hub.lastClaim.clear();
r = await claim("CTR"); t("CTR allowed with 30 h APP", r.s === 200);
// APP heartbeat counts APP time
const before = pf.app_s; await new Promise(x => setTimeout(x, 5)); hub.towers.get("SBBR_APP").at = Date.now() - 45_000;
await claim("APP"); t("APP heartbeat adds app_s", pf.app_s > before + 40);
// ops credit: TWR/APP holders at the airport get it, others not
const o0 = pf.ops; hub.opsCredit("SBBR", Date.now()); t("own airport op credited to TWR/APP holder", pf.ops === o0 + 2);
hub.opsCredit("SBXX", Date.now()); t("other airport: nothing", pf.ops === o0 + 2);
// profile response
r = await call("GET", "/api/profile", null, "k1"); t("profile: stats + grades", r.s === 200 && r.j.atc_grade_name === "Center" && "landings" in r.j && "violations" in r.j && r.j.pilot_grade === "Student");
// violations + timeouts
const mk = (key) => ({ c: { pos: { latitude: 1, longitude: 2 }, plan: { callsign: "TST" } }, st: { viol: {} } });
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "p1");
let { c, st } = mk(); hub.violate("p1", c, st, "taxi", "SBBR", "", Date.now(), () => {});
let pp = hub.profGet("p1"); t("taxi = 1 penalty, no violation, no timeout", pp.pen === 1 && pp.vio === 0 && pp.violations === 0 && !hub.locks.get("p1"));
hub.violate("p1", c, st, "taxi", "SBBR", "", Date.now() + 61_000, () => {});
t("same episode not counted twice", pp.pen === 1);
({ c, st } = mk()); hub.violate("p1", c, st, "alt", "SBBR", "", Date.now(), () => {});
t("altitude = 3 penalty points", pp.pen === 4 && pp.vio === 0);
({ c, st } = mk()); hub.violate("p1", c, st, "runway", "SBBR", "27", Date.now(), () => {});
t("runway = 1 violation + 5 min timeout", pp.vio === 1 && pp.pen === 4 && hub.locks.get("p1") && Math.abs(hub.locks.get("p1").until - Date.now() - 300_000) < 3000);
hub.locks.delete("p1");
for (let i = 0; i < 6; i++) { ({ c, st } = mk()); hub.violate("p1", c, st, "taxi", "SBBR", "", Date.now(), () => {}); }
let lk = hub.locks.get("p1"); t("10 penalties = 30 min timeout", lk && lk.reason === "penalties" && Math.abs(lk.until - Date.now() - 1_800_000) < 3000 && pp.pen === 0);
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "p1"); t("position refused with 423", r.s === 423 && r.j.reason === "penalties" && r.j.remaining_s > 1700);
r = await call("PUT", "/api/flightplan", { callsign: "TST" }, "p1"); t("flight plan refused too", r.s === 423);
hub.locks.delete("p1");
({ c, st } = mk()); hub.violate("p1", c, st, "landing", "SBBR", "27", Date.now(), () => {});
t("landing = violation 2 + 1 h timeout", pp.vio === 2 && Math.abs(hub.locks.get("p1").until - Date.now() - 3_600_000) < 3000);hub.locks.delete("p1");
({ c, st } = mk()); hub.violate("p1", c, st, "runway", "SBBR", "27", Date.now(), () => {});
lk = hub.locks.get("p1"); t("3 violations = 6 h timeout", lk && lk.reason === "violations" && Math.abs(lk.until - Date.now() - 21_600_000) < 3000 && pp.vio === 0);
hub.locks.delete("p1"); pp.pen = 4; pp.vio = 2; pp.pday = "2000-01-01"; pp = hub.profGet("p1");
t("counters reset daily", pp.pen === 0 && pp.vio === 0);
// demotion when an ATC causes a mid-air
const dp = hub.profGet("ctlx"); dp.gw = 60; dp.atc_s = 4 * 3600; t("controller is Tower", hub.gradeInfo(dp).atc_grade === 1);
hub.demote("ctlx", Date.now()); t("demotion: back to Ground, stat lost", hub.gradeInfo(hub.profGet("ctlx")).atc_grade === 0 && hub.profGet("ctlx").gw === 0);
// crash counts as a strike and respects the repeat rule
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "p2"); hub.locks.clear();
await call("PUT", "/api/position", { latitude: 1, longitude: 2, landing_fpm: -2000 }, "p2");
t("crash = 5 min first time", Math.abs(hub.locks.get("p2").until - Date.now() - 300_000) < 3000);
hub.locks.delete("p2"); hub.crashes.clear();
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "p2"); await call("PUT", "/api/position", { latitude: 1, longitude: 2, landing_fpm: -2000 }, "p2");
t("second crash same day = 1 h", Math.abs(hub.locks.get("p2").until - Date.now() - 3_600_000) < 3000);
// timeout follows the account on another device
hub.locks.set("a:pedro", { until: Date.now() + 100_000, reason: "crash" }); hub.toks.set("afa_x", { acct: "pedro", at: Date.now() });
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "afa_x"); t("lock is per account (token)", r.s === 423);
// landings count
await call("PUT", "/api/position", { latitude: 5, longitude: 5, phase: "air" }, "p3"); await call("PUT", "/api/position", { latitude: 5, longitude: 5, phase: "ground" }, "p3");
t("landing counted", hub.profGet("p3").landings === 1);
// ATC Network: no counters, no timeouts
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "m1"); hub.clients.get("m1").member = true;
for (const ty of ["taxi", "alt", "runway", "landing", "runway", "landing"]) { const x = { c: hub.clients.get("m1"), st: { viol: {} } }; hub.violate("m1", x.c, x.st, ty, "SBBR", "27", Date.now(), () => {}); }
t("member: no penalties/violations/timeout", hub.profGet("m1").pen === 0 && hub.profGet("m1").violations === 0 && !hub.locks.get("m1"));
console.log(fails ? "FAILS: " + fails : "all pass"); process.exit(fails ? 1 : 0);
