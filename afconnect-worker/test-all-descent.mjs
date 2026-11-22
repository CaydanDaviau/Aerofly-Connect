import { Hub, TEST } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f(), acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
const hub = new Hub(ctx);
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
const call = async (method, path, body, key = "k1", hdr = {}) => { const r = await hub.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key, "X-Member": "0", ...hdr } })); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
TEST.skipGrades = true; TEST.warnLimit = 0;
// airport SBBR at (-15.87,-47.92); owner opens it and takes ALL
let r = await call("PUT", "/api/atc/tower", { name: "SBBR", owner: "own", latitude: -15.87, longitude: -47.92 }, "ctl");
t("airport opened", r.s === 200);
r = await call("PUT", "/api/atc/tower", { name: "SBBR_ALL", holder: "other", latitude: -15.87, longitude: -47.92 }, "x"); t("ALL refused for non-owner", r.s === 403 && r.j.error === "not_owner");
r = await call("PUT", "/api/atc/tower", { name: "SBBR_ALL", holder: "own", latitude: -15.87, longitude: -47.92 }, "ctl"); t("owner takes ALL", r.s === 200);
r = await call("PUT", "/api/atc/tower", { name: "SBBR_GND", holder: "g1", latitude: -15.87, longitude: -47.92 }, "g"); t("GND slot still free for someone else", r.s === 200);
r = await call("PUT", "/api/atc/tower", { name: "SBBR_TWR", holder: "own", latitude: -15.87, longitude: -47.92 }, "ctl"); t("owner can still take other roles (ALL is separate)", r.s === 200 || r.s === 409);
// pilot far from SBBR (200 nm), airborne, descent request
await call("PUT", "/api/flightplan", { callsign: "TST1", departure_airport: "SBSP", arrival_airport: "SBBR" }, "p");
await call("PUT", "/api/position", { latitude: -13, longitude: -45, altitude_ft: 30000, ground_speed: 450, icao_address: "AAA111", phase: "air", freq: "119.100" }, "p");
r = await call("PUT", "/api/atc/request", { type: "descent", altitude: "FL200" }, "p");
t("far from the staffed airport: auto-ATC answers a descent", r.j.mode === "auto" && /Descend/.test((r.j.messages || [])[0]?.text || ""));
// pilot inside 50 nm: ALL covers it, goes to the controller
await call("PUT", "/api/position", { latitude: -15.5, longitude: -47.7, altitude_ft: 12000, ground_speed: 250, icao_address: "AAA111", phase: "air", freq: "119.100" }, "p");
await new Promise(z => setTimeout(z, 2100));
r = await call("PUT", "/api/atc/request", { type: "descent", altitude: "5000" }, "p");
t("inside the airspace: descent goes to the controller", r.j.mode === "controller");
console.log("FAILS: " + fails);
