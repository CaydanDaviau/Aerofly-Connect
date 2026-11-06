import worker, { Hub } from "./src/index.js";
const store = new Map();
const ctx = { blockConcurrencyWhile: async f => { await f(); }, storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) } };
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

// squawk assignment
const tr = JSON.parse((await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50", null, "cs")).slice(4));
const target = tr.aircraft.find(a => a.callsign === "PEDRO1").icao_address;
console.log("assign:", await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "2314" }, "atc"));
console.log("bad:", (await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "7700" }, "atc")).slice(0, 3));
console.log("auto:", await call("PUT", "/api/atc/squawk", { icao_address: target }, "atc"));
await call("PUT", "/api/atc/squawk", { icao_address: target, squawk: "2314" }, "atc");
console.log("in traffic:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"assigned_squawk":"2314"'));
hub = new Hub(ctx);
await call("PUT", "/api/position", { latitude: 1, longitude: 2 }, "cs");
console.log("after restart:", (await call("GET", "/api/traffic?lat=1&lon=2&radius_miles=50")).includes('"assigned_squawk":"2314"'));
console.log("unknown:", (await call("PUT", "/api/atc/squawk", { icao_address: "FFFFFF", squawk: "2000" }, "atc")).slice(0, 3));
for (const [k, cs] of [["t1", "ATC-SBBR"], ["t2", "twr sbbr"], ["t3", "TWR_SBGL"], ["t4", "ATCSBBR"], ["t5", "PEDRO1"]]) {
  await call("PUT", "/api/flightplan", { callsign: cs }, k);
  await call("PUT", "/api/position", { latitude: 5, longitude: 5 }, k);
}
const nt = JSON.parse((await call("GET", "/api/traffic?lat=5&lon=5&radius_miles=10")).slice(4));
console.log("callsigns:", nt.aircraft.map(a => a.callsign).join(" "));

// virtual towers
console.log("tower put:", await call("PUT", "/api/atc/tower", { name: "sbbr", latitude: -15.871, longitude: -47.919, altitude_ft: 3500 }, "atc"));
console.log("tower bad:", (await call("PUT", "/api/atc/tower", { name: "x", latitude: 99, longitude: 0 }, "atc")).slice(0, 3));
let tt = JSON.parse((await call("GET", "/api/traffic?lat=-15.9&lon=-47.9&radius_miles=50", null, "pilot")).slice(4)).aircraft.find(a => a.callsign === "ATC_SBBR");
console.log("tower in traffic:", !!tt, tt && tt.icao_address, tt && tt.virtual_tower);
hub = new Hub(ctx); await new Promise(r => setTimeout(r, 5));
tt = JSON.parse((await call("GET", "/api/traffic?lat=-15.9&lon=-47.9&radius_miles=50", null, "pilot")).slice(4)).aircraft.find(a => a.callsign === "ATC_SBBR");
console.log("tower after restart:", !!tt);
console.log("far away:", JSON.parse((await call("GET", "/api/traffic?lat=40&lon=0&radius_miles=50", null, "pilot")).slice(4)).aircraft.some(a => a.virtual_tower));
await call("DELETE", "/api/atc/tower?name=SBBR", null, "atc");
console.log("closed:", !JSON.parse((await call("GET", "/api/traffic?lat=-15.9&lon=-47.9&radius_miles=50", null, "pilot")).slice(4)).aircraft.some(a => a.virtual_tower));

// tower classification fields expected by the Android app
await call("PUT", "/api/atc/tower", { name: "SBBR", latitude: -15.871, longitude: -47.919 }, "ctl");
await call("PUT", "/api/flightplan", { callsign: "TWR-SBGL" }, "twrpilot");
await call("PUT", "/api/position", { latitude: -15.8, longitude: -47.9, airplane_model: "B777", airplane_livery: "Delta" }, "twrpilot");
await call("PUT", "/api/flightplan", { callsign: "PEDRO9" }, "plain");
await call("PUT", "/api/position", { latitude: -15.8, longitude: -47.9, airplane_model: "B738", airplane_livery: "Gol" }, "plain");
const cl = JSON.parse((await call("GET", "/api/traffic?lat=-15.8&lon=-47.9&radius_miles=50")).slice(4)).aircraft;
const show = n => { const a = cl.find(x => x.callsign === n); return a ? `${n}: model=${JSON.stringify(a.airplane_model)} livery=${JSON.stringify(a.airplane_livery)}` : n + " missing"; };
console.log(show("ATC_SBBR")); console.log(show("ATC_SBGL")); console.log(show("PEDRO9"));
