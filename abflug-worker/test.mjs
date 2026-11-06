import worker, { Hub } from "./src/index.js";
const hub = new Hub();
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
