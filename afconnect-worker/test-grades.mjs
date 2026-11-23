import worker, { Hub, TEST, GATE } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
const hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
const call = async (method, path, body, key = "k1", hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "X-Member": "0", ...hdr } })); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
TEST.skipGrades = false; GATE.on = true; TEST.warnLimit = 0;
const claim = (pos, key = "k1", hdr = {}) => call("PUT", "/api/atc/tower", { name: "SBBR_" + pos, holder: "h-" + key, latitude: -15.87, longitude: -47.92 }, key, hdr);
let r = await claim("GND"); t("everyone starts with GND", r.s === 200);
r = await claim("GND"); t("GND allowed (cooldown aside)", r.s === 200 || (r.s === 409 && r.j.error === "role_cooldown"));
r = await claim("TWR"); t("TWR needs grade", r.s === 409 && r.j.error === "grade_required" && r.j.need === "Junior" && r.j.next_req.some(x => x.k === "lv_twr" && x.need === 10));
r = await claim("TWR", "k1", { "X-Member": "1" }); t("network member has every role", r.s === 200 || (r.s === 409 && r.j.error === "role_cooldown"));
const pf = hub.profGet("k1"); pf.lv_twr = 9;
r = await claim("TWR"); t("training level 9 on TWR: still blocked", r.s === 409 && r.j.error === "grade_required");
for (let i = 0; i < 2; i++) hub.gwCredit("k1", "AC" + i, Date.now());
hub.gwCredit("k1", "AC0", Date.now());   // same aircraft inside 10 min: not counted again
t("ground work: once per aircraft per 10 min", hub.profGet("k1").gw === 2);
pf.lv_twr = 10;
t("grade is Tower", hub.gradeInfo(hub.profGet("k1")).atc_grade === 1);
store.clear(); hub.lastClaim.clear();
r = await claim("TWR"); t("TWR allowed with training level 10", r.s === 200);
r = await claim("APP"); t("APP blocked (needs APP training level 10)", r.s === 409 && r.j.error === "grade_required" && r.j.next_grade === "Senior" && r.j.next_req[0].k === "lv_app");
hub.lastClaim.clear(); pf.lv_app = 10;
r = await claim("APP"); t("APP allowed with APP training level 10", r.s === 200);
hub.lastClaim.clear(); r = await claim("CTR"); t("CTR blocked without 30 h APP", r.s === 409 && r.j.next_grade === "Chief" && r.j.next_req[0].k === "app_s");
pf.app_s = 30 * 3600; hub.lastClaim.clear();
r = await claim("CTR"); t("CTR allowed with 30 h APP", r.s === 200);
// APP heartbeat counts APP time
const before = pf.app_s; await new Promise(x => setTimeout(x, 5)); hub.towers.get("SBBR_APP").at = Date.now() - 45_000;
await claim("APP"); t("APP heartbeat adds app_s", pf.app_s > before + 40);
// ops credit: TWR/APP holders at the airport get it, others not
const o0 = pf.ops; hub.opsCredit("SBBR", Date.now()); t("own airport op credited to TWR/APP holder", pf.ops === o0 + 2);
hub.opsCredit("SBXX", Date.now()); t("other airport: nothing", pf.ops === o0 + 2);
// profile response
r = await call("GET", "/api/profile", null, "k1"); t("profile: stats + grades", r.s === 200 && r.j.atc_grade_name === "Chief" && "landings" in r.j && "rep" in r.j && r.j.pilot_grade === "Student");
// reputation score (replaces penalties / timeouts)
const mk = () => ({ c: { pos: { latitude: 1, longitude: 2 }, plan: { callsign: "TST" } }, st: { viol: {} } });
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "p1");
let { c, st } = mk(); const nowT = Date.now();
t("score starts at 500 (2 stars)", hub.repOf("p1") === 500 && hub.starsFor("p1") === 2);
hub.violate("p1", c, st, "taxi", "SBBR", "", nowT, () => {});
t("taxi without clearance: -5, no timeout", hub.repOf("p1") === 495 && !hub.locks.get("p1"));
hub.violate("p1", c, st, "taxi", "SBBR", "", nowT + 61_000, () => {});
t("same episode not counted twice", hub.repOf("p1") === 495);
({ c, st } = mk()); hub.violate("p1", c, st, "runway", "SBBR", "27", nowT, () => {});
t("runway without clearance: -20, no timeout", hub.repOf("p1") === 475 && !hub.locks.get("p1"));
({ c, st } = mk()); hub.violate("p1", c, st, "landing", "SBBR", "27", nowT, () => {});
t("landing without clearance: -40, no timeout", hub.repOf("p1") === 435 && !hub.locks.get("p1") && hub.starsFor("p1") === 2);
hub.repAdd("p1", 100, nowT); t("100 more points: 3 stars (535)", hub.repOf("p1") === 535 && hub.starsFor("p1") === 2 && (hub.repAdd("p1", 70, nowT), hub.starsFor("p1") === 3));
hub.repAdd("p1", 5000, nowT); t("capped at 1000 (5 stars)", hub.repOf("p1") === 1000 && hub.starsFor("p1") === 5);
hub.repAdd("p1", -5000, nowT); t("never below 0", hub.repOf("p1") === 0 && hub.starsFor("p1") === 0);
hub.repAdd("p1", 500, nowT);
// crash: -100, 30 min timeout, no strikes
const lk = hub.lockFor("p1", "crash", nowT, {}); t("crash: -100 and 30 min timeout", hub.repOf("p1") === 400 && lk.until - nowT === 30 * 60_000 && !(hub.profGet("p1").timeouts > 0));
// positive actions
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "p2");
hub.repAdd("p2", 15, nowT); t("flight completed +15", hub.repOf("p2") === 515);
r = await call("GET", "/api/profile", null, "p2"); t("profile exposes rep + stars, no penalties", r.j.rep === 515 && r.j.stars === 2 && !("penalties_today" in r.j) && !("timeouts" in r.j));
// stars on traffic
await call("PUT", "/api/flightplan", { callsign: "STAR1" }, "p2"); await call("PUT", "/api/position", { latitude: 1, longitude: 2, altitude_ft: 3000, ground_speed: 100, heading_true: 10, phase: "air" }, "p2");
r = await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50", null, "p3"); t("traffic carries stars", (r.j.aircraft || []).some(a => a.callsign === "STAR1" && a.stars === 2));
// manager reset
console.log(fails ? "FAILS: " + fails : "all ok"); process.exit(fails ? 1 : 0);
