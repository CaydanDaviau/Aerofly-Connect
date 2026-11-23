import worker, { Hub, TEST } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), getWebSockets: () => [] };
const hub = new Hub(ctx);
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
const call = async (method, path, body, key, sec, extra = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "X-Sec": sec, "X-Member": sec === "net" ? "1" : "0", "Content-Type": "application/json", ...extra } })); return { s: r.status, j: await r.json().catch(() => ({})) }; };
TEST.skipGrades = true; TEST.warnLimit = 0;
const pos = (icao, o = {}) => ({ latitude: 1, longitude: 2, altitude_ft: 3000, ground_speed: 120, icao_address: icao, ...o });
await call("PUT", "/api/position", pos("AAA111"), "pe", "expert");
await call("PUT", "/api/position", pos("BBB222"), "pc", "casual");
await call("PUT", "/api/position", pos("CCC333"), "pn", "net");
const ids = async sec => (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50", null, "pe", sec)).j.aircraft.map(a => a.icao_address).filter(i => /^[A-C]{3}\d/.test(i)).sort().join();
t("expert sees only expert", await ids("expert") === "AAA111");
t("casual sees only casual", await ids("casual") === "BBB222");
t("net sees only net", await ids("net") === "CCC333");
let h = await call("GET", "/api/health", null, "pe", "casual"); t("health counts own section + mode", h.j.pilots === 1 && h.j.mode === "casual");
// airport namespace: other section cannot touch it
let r = await call("PUT", "/api/atc/tower", { name: "SBBR", latitude: 1, longitude: 2, owner: "o1" }, "ce", "expert"); t("expert opens airport", r.s === 200);
r = await call("PUT", "/api/atc/tower", { name: "SBBR", latitude: 1, longitude: 2, owner: "o2" }, "cc", "casual"); t("casual refused: other_section", r.s === 403 && r.j.error === "other_section");
t("casual does not see expert airport", !(await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50", null, "pc", "casual")).j.aircraft.some(a => a.virtual_tower));
r = await call("DELETE", "/api/atc/tower?name=SBBR&holder=o2", null, "cc", "casual"); t("casual cannot close it", r.s === 403);
// penalties
const viol = (key, type, at) => { const c = hub.clients.get(key), st = c.st || (c.st = { viol: {}, gr: {}, calls: {}, grace: 0 }); hub.violate(key, c, st, type, "SBBR", "27", at, () => {}); };
viol("pc", "landing", 1e12); viol("pc", "runway", 1e12 + 400_000);
let pf = hub.profGet("pc"); t("casual: no violations/points/timeout", pf.violations === 0 && pf.vpts === 0 && !hub.locks.get("pc"));
t("casual: aircraft still tagged", hub.clients.get("pc").viol && hub.clients.get("pc").viol.type === "runway");
viol("pe", "landing", 1e12); pf = hub.profGet("pe"); t("expert: violation + timeout still apply", pf.violations === 1 && !!hub.locks.get("pe"));
// casual notice with human controller
await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", holder: "hc", latitude: 1, longitude: 2 }, "cc2", "casual").catch(() => {});
const c2 = { sec: "casual", pos: { latitude: 1, longitude: 2, icao_address: "DDD444" }, plan: { callsign: "C2", departure_airport: "SBBR" }, lang: "en" };
hub.clients.set("pc2", c2); hub.towers.set("SBBR_TWR", { name: "SBBR_TWR", apt: "SBBR", pos: "TWR", holder: "hc", at: Date.now(), sec: "casual", latitude: 1, longitude: 2 });
hub.violate("pc2", c2, { viol: {}, gr: {} }, "taxi", "SBBR", "", 1e12, () => {});
t("casual + human controller: notice, no penalty", [...hub.msgs.values()].some(m => /Casual server: no penalty/.test(m.text)) && hub.profGet("pc2").pen === 0);
// crash timeouts still apply in casual
await call("PUT", "/api/position", pos("EEE555", { ground_speed: 5, altitude_ft: 0 }), "pk", "casual");
r = await call("PUT", "/api/position", pos("EEE555", { ground_speed: 5, altitude_ft: 0, landing_fpm: -2500 }), "pk", "casual");
t("casual: hard landing crash still times out (423)", r.s === 423 || (await call("PUT", "/api/position", pos("EEE555"), "pk", "casual")).s === 423);
console.log("FAILS: " + fails);
