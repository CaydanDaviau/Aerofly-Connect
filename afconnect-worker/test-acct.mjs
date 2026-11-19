import worker, { Hub } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
let hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
let fails = 0;
const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
const call = async (method, path, body, key = "oldkey") => { const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: key ? { "X-API-Key": key } : {} }), env); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
// old key earns hours
const prof = hub.profGet("oldkey"); prof.flight_s = 3600; prof.flights = 4; prof.nick = "Old";
let r = await call("POST", "/api/account/register", { name: "Pedro", password: "abc" }); t("short password", r.s === 400);
r = await call("POST", "/api/account/register", { name: "a b", password: "abcdef" }); t("bad name", r.s === 400);
r = await call("POST", "/api/account/register", { name: "Pedro", password: "secret1" }); t("register", r.s === 200 && r.j.token.startsWith("afa_") && r.j.name === "Pedro");
const tok = r.j.token;
r = await call("POST", "/api/account/register", { name: "pedro", password: "secret1" }, "k2"); t("name taken (case-insens)", r.s === 409);
r = await call("GET", "/api/account", null, tok); t("whoami", r.s === 200 && r.j.name === "Pedro");
r = await call("GET", "/api/profile", null, tok); t("hours carried over", r.s === 200 && r.j.flight_s === 3600 && r.j.flights === 4 && r.j.nick === "Old");
r = await call("PUT", "/api/profile", { nick: "Pedro" }, tok); t("nick on account", r.j.nick === "Pedro");
r = await call("GET", "/api/profile", null, "oldkey"); t("old key profile untouched", r.j.nick === "Old");
r = await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, tok); t("token can fly", r.s === 200);
r = await call("GET", "/api/account", null, "oldkey"); t("plain key not logged in", r.s === 404);
r = await call("GET", "/api/profile", null, "afa_bogus"); t("unknown token 401", r.s === 401);
// login on a second device with a different key links it once
const p2 = hub.profGet("dev2"); p2.flight_s = 100;
r = await call("POST", "/api/account/login", { name: "PEDRO", password: "wrong1" }, "dev2"); t("wrong password", r.s === 401);
r = await call("POST", "/api/account/login", { name: "PEDRO", password: "secret1" }, "dev2"); t("login", r.s === 200);
const tok2 = r.j.token;
r = await call("POST", "/api/account/login", { name: "PEDRO", password: "secret1" }, "dev2");
r = await call("GET", "/api/profile", null, tok2); t("dev2 hours merged once", r.j.flight_s === 3700);
// brute force
for (let i = 0; i < 5; i++) await call("POST", "/api/account/login", { name: "x1y", password: "nope12" });
await call("POST", "/api/account/register", { name: "Maria", password: "secret2" }, "k3");
for (let i = 0; i < 5; i++) await call("POST", "/api/account/login", { name: "Maria", password: "nope12" });
r = await call("POST", "/api/account/login", { name: "Maria", password: "secret2" }); t("locked after 5 failures", r.s === 429);
// restart persistence
hub = new Hub(ctx); await new Promise(r => setTimeout(r, 20));
r = await call("GET", "/api/profile", null, tok); t("token + profile survive restart", r.s === 200 && r.j.nick === "Pedro");
// password change revokes other tokens
r = await call("POST", "/api/account/password", { old: "bad", new: "newpass1" }, tok); t("password change wrong old", r.s === 401);
r = await call("POST", "/api/account/password", { old: "secret1", new: "newpass1" }, tok); t("password change", r.s === 200);
r = await call("GET", "/api/account", null, tok2); t("other token revoked", r.s === 401);
r = await call("POST", "/api/account/login", { name: "pedro", password: "newpass1" }); t("login new password", r.s === 200);
r = await call("POST", "/api/account/logout", {}, tok); t("logout", r.s === 200);
r = await call("GET", "/api/account", null, tok); t("token dead after logout", r.s === 401);
console.log(fails ? "FAILS: " + fails : "all pass"); process.exit(fails ? 1 : 0);
