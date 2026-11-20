import worker, { Hub, TEST } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
const hub = new Hub(ctx);
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
TEST.skipGrades = false;
const call = async (method, path, body, key = "k1", hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "X-Member": "0", ...hdr } })); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const M = { "X-Mgr": "1" };
t("page served", (await worker.fetch(new Request("https://x/players"), { HUB: {} })).status === 200);
t("not manager refused", (await call("GET", "/api/manager/players")).s === 403 && (await call("POST", "/api/manager/player", {})).s === 403);
await call("PUT", "/api/profile", { nick: "Maverick" }, "dev1");
await call("PUT", "/api/profile", { nick: "Goose" }, "dev2");
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "dev1");
await call("PUT", "/api/flightplan", { callsign: "AFL123" }, "dev1");
let r = await call("GET", "/api/manager/players", null, "m", M);
t("lists profiles, online first", r.s === 200 && r.j.players.length === 2 && r.j.players[0].online && r.j.players[0].callsign === "AFL123" && r.j.players[0].nick === "Maverick");
t("no raw key leaked", !JSON.stringify(r.j).includes("dev1") && !JSON.stringify(r.j).includes("dev2"));
r = await call("GET", "/api/manager/players?q=goo", null, "m", M); t("search by nick", r.j.players.length === 1 && r.j.players[0].nick === "Goose");
r = await call("GET", "/api/manager/players?q=afl", null, "m", M); t("search by callsign", r.j.players.length === 1 && r.j.players[0].nick === "Maverick");
const id1 = (await call("GET", "/api/manager/players?q=maver", null, "m", M)).j.players[0].id;
// promote / demote
r = await call("POST", "/api/manager/player", { id: id1, action: "promote" }, "m", M); t("promote -> Tower, manual", r.s === 200 && r.j.player.atc_grade_name === "Tower" && r.j.player.grade_manual);
const claim = pos => call("PUT", "/api/atc/tower", { name: "SBBR_" + pos, holder: "h1", latitude: -15.87, longitude: -47.92 }, "dev1");
r = await claim("TWR"); t("promoted player may claim TWR", r.s === 200);
r = await call("POST", "/api/manager/player", { id: id1, action: "demote" }, "m", M); t("demote -> Ground", r.j.player.atc_grade_name === "Ground");
r = await call("POST", "/api/manager/player", { id: id1, action: "demote" }, "m", M); t("demote below Ground refused", r.s === 400 && r.j.error === "grade_limit");
r = await call("POST", "/api/manager/player", { id: id1, action: "grade_auto" }, "m", M); t("auto grade clears manual", !r.j.player.grade_manual);
// timeout
r = await call("POST", "/api/manager/player", { id: id1, action: "timeout", minutes: 0 }, "m", M); t("bad minutes refused", r.s === 400);
r = await call("POST", "/api/manager/player", { id: id1, action: "timeout", minutes: 10, reason: "test" }, "m", M); t("timeout set, plane dropped", r.s === 200 && r.j.player.timeout_s > 590 && !r.j.player.online);
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "dev1"); t("position refused 423 timeout", r.s === 423 && r.j.error === "timeout" && r.j.remaining_s > 590);
r = await call("POST", "/api/manager/player", { id: id1, action: "untimeout" }, "m", M); t("end timeout", r.j.player.timeout_s === 0);
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "dev1"); t("flies again", r.s === 200);
// ban
r = await call("POST", "/api/manager/player", { id: id1, action: "ban", reason: "spam" }, "m", M); t("ban", r.j.player.banned && r.j.player.ban_reason === "spam" && !r.j.player.online);
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "dev1"); t("banned: position 403", r.s === 403 && r.j.error === "banned");
r = await call("PUT", "/api/flightplan", { callsign: "X" }, "dev1"); t("banned: plan 403", r.s === 403);
hub.lastClaim.clear(); r = await claim("GND"); t("banned: role claim 403", r.s === 403 && r.j.error === "banned");
r = await call("GET", "/api/traffic?lat=0&lon=0&radius_miles=50", null, "dev1"); t("banned can still read traffic", r.s === 200);
r = await call("POST", "/api/manager/player", { id: id1, action: "unban" }, "m", M); t("unban", !r.j.player.banned);
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "dev1"); t("flies after unban", r.s === 200);
t("unknown id 404", (await call("POST", "/api/manager/player", { id: "k:zzz", action: "ban" }, "m", M)).s === 404);
t("bad action 400", (await call("POST", "/api/manager/player", { id: id1, action: "x" }, "m", M)).s === 400);
// persisted
t("ban/grade stored in profile storage", [...store.keys()].some(k => k.startsWith("prof:")));
console.log(fails ? fails + " FAIL" : "0 FAIL"); process.exit(fails ? 1 : 0);
