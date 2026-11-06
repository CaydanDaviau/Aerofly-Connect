import worker, { Hub } from "./src/index.js";
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v) } };
let hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r) => hub.fetch(r) }) } };
const call = async (method, path, body, key = "abc") => {
  const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: key ? { "X-API-Key": key } : {} }), env);
  return `${r.status} ${await r.text()}`;
};
console.log(await call("GET", "/api/health", null, null));
console.log(await call("PUT", "/api/position", { latitude: 47.4, longitude: 8.5, altitude_ft: 5000, callsign: "T1" }));
console.log(await call("PUT", "/api/flightplan", { departure_airport: "LSZH" }));
console.log((await call("GET", "/api/traffic?lat=47&lon=8&radius_miles=100")).slice(0, 160));
console.log(await call("GET", "/api/traffic", null, null));
console.log(await call("DELETE", "/api/position"));
console.log(await call("GET", "/api/health", null, null));
console.log(await call("GET", "/api/stats", null, null));
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "secretkey");
const r = await worker.fetch(new Request("https://x/api/debug?key=secretkey"), env); console.log(r.status, (await r.text()).slice(0, 140));
const r2 = await worker.fetch(new Request("https://x/api/debug"), env); console.log(r2.status);

// restart simulation: plan must survive
await call("PUT", "/api/flightplan", { departure_airport: "SBBR" }, "pk");
hub = new Hub(ctx);
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "pk");
const r3 = await worker.fetch(new Request("https://x/api/debug?key=pk"), env); console.log("after restart:", (await r3.text()).includes("SBBR"));
await call("PUT", "/api/flightplan", { callsign: "PEDRO1", departure_airport: "SBBR", cruise_altitude: 35000 }, "cs");
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "cs");
console.log("callsign test:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"callsign":"PEDRO1"'));
