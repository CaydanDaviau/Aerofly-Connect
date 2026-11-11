// Mock-based tests for the /ws routing + push (run: node test-ws.mjs)
import worker, { Hub } from "./src/index.js";
const store = new Map(); const socks = [];
const mkWs = () => { const w = { sent: [], att: null, closed: false, send(x) { this.sent.push(x); }, close() { this.closed = true; }, serializeAttachment(a) { this.att = JSON.parse(JSON.stringify(a)); }, deserializeAttachment() { return this.att; } }; return w; };
let autoResp = null;
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) },
  blockConcurrencyWhile: async f => f(), acceptWebSocket: w => socks.push(w), getWebSockets: () => socks, setWebSocketAutoResponse: p => { autoResp = p; } };
globalThis.WebSocketPair = function () { this[0] = mkWs(); this[1] = mkWs(); };
globalThis.WebSocketRequestResponsePair = function (a, b) { this.request = a; this.response = b; };
const RealResponse = Response;
globalThis.Response = class extends RealResponse { constructor(b, i) { if (i && i.status === 101) { super(null, { status: 200 }); this.wsStatus = 101; this.webSocket = i.webSocket; } else super(b, i); } };
const hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(new Request(r, init)) }) } };
let fails = 0; const T = (n, v) => { if (!v) fails++; console.log(n + ":", v ? "PASS" : "FAIL"); };
const up = (key, hdr = { Upgrade: "websocket" }) => worker.fetch(new Request("https://x/ws?key=" + key, { headers: hdr }), env);
const msg = async (ws, o) => { await hub.webSocketMessage(ws, JSON.stringify(o)); return JSON.parse(ws.sent[ws.sent.length - 1]); };

T("no upgrade -> 426", (await up("k1", {})).status === 426);
T("no key -> 401", (await worker.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket" } }), env)).status === 401);
const r = await up("pil"); const ws = socks[0];
T("upgrade accepted", r.wsStatus === 101 && ws && ws.att.key === "pil" && autoResp.request === "ping" && autoResp.response === "pong");

// position via socket = same handler as HTTP (key comes from the socket)
await msg(ws, { id: 0, method: "PUT", path: "/api/flightplan", body: { callsign: "WS1" } });
let a = await msg(ws, { id: 1, method: "PUT", path: "/api/position", body: { latitude: 10, longitude: 20, altitude_ft: 3000, callsign: "WS1" } });
T("position over ws", a.id === 1 && a.status === 200 && a.body.success === true && Array.isArray(a.body.messages));
a = await msg(ws, { id: 2, method: "PUT", path: "/api/position?traffic=1", body: { latitude: 10, longitude: 20 } });
T("traffic=1 over ws", a.status === 200 && a.body.aircraft.length === 1);
a = await msg(ws, { id: 3, method: "GET", path: "/api/health" });
T("health over ws", a.status === 200 && a.body.pilots === 1);
a = await msg(ws, { id: 4, method: "GET", path: "/api/debug" });
T("debug refused", a.status === 400);
a = await msg(ws, { id: 5, method: "PUT", path: "/etc/passwd" });
T("non-api path refused", a.status === 400);
a = await msg(ws, { id: 6, method: "PUT", path: "/api/atc/message", body: { icao_address: "ZZZ", text: "hi" } });
T("error status passed on", a.status === 404 && a.body.error === "aircraft not found");

// radar socket: subscribe + push
await up("radar"); const rd = socks[1];
const first = await msg(rd, { sub: { lat: 0, lon: 0, radius_miles: 13000 } });
T("sub answers at once", first.push === "traffic" && first.aircraft.length === 1 && first.aircraft[0].callsign === "WS1");
T("sub stored", rd.att.sub.rad === 13000);
const before = rd.sent.length, pb = ws.sent.length;
await hub.pushAll();
T("push to subscriber", rd.sent.length === before + 1 && JSON.parse(rd.sent.at(-1)).push === "traffic");
T("no push without sub", ws.sent.length === pb);
// a new plane shows up in the next push, no poll needed
await hub.webSocketMessage(socks[0], JSON.stringify({ id: 7, method: "PUT", path: "/api/position", body: { latitude: 11, longitude: 21 } }));
await worker.fetch(new Request("https://x/api/position", { method: "PUT", body: JSON.stringify({ latitude: 12, longitude: 22, callsign: "HTTP1" }), headers: { "X-API-Key": "other" } }), env);
await hub.pushAll();
T("push sees HTTP client too", JSON.parse(rd.sent.at(-1)).aircraft.length === 2);
// sub.max caps the pushed list (the app asks for 100)
a = await msg(rd, { sub: { lat: 0, lon: 0, radius_miles: 13000, max: 1 } });
T("sub max caps list", a.aircraft.length === 1 && a.truncated === true && rd.att.sub.max === 1);
await msg(rd, { sub: { lat: 0, lon: 0, radius_miles: 13000 } });
// ATC action over the radar socket reaches the pilot
const icao = JSON.parse(rd.sent.at(-1)).aircraft.find(x => x.callsign === "WS1").icao_address;
a = await msg(rd, { id: 8, method: "PUT", path: "/api/atc/squawk", body: { icao_address: icao, squawk: "2314" } });
T("squawk over ws", a.status === 200 && a.body.squawk === "2314");
a = await msg(ws, { id: 9, method: "PUT", path: "/api/position", body: { latitude: 10, longitude: 20 } });
T("pilot gets message in position reply", a.body.messages.some(m => /Squawk 2314/.test(m.text)));
// unsubscribe, bad json, closed socket in push
await msg(rd, { sub: null }); const n = rd.sent.length; await hub.pushAll();
T("unsub stops push", rd.sent.length === n);
await hub.webSocketMessage(ws, "not json"); T("bad json ignored", true);
socks.splice(0, socks.length); await hub.pushAll(); T("timer stops with no sockets", hub.pushTimer === null);
// HTTP still intact
const h = await worker.fetch(new Request("https://x/api/traffic?lat=0&lon=0&radius_miles=13000", { headers: { "X-API-Key": "k" } }), env);
const hj = await h.json(); T("HTTP /api/traffic unchanged", h.status === 200 && hj.aircraft.length >= 2 && "crashes" in hj && "atc_messages" in hj);
// stats: socket requests counted separately, reset works
{
  const st = async q => (await (await worker.fetch(new Request("https://x/api/stats" + q), env)).json());
  let j = await st("");
  T("stats: WS requests listed separately", (j.counts["WS PUT /api/position"] || 0) > 0 && !("PUT /api/position" in j.counts && j.counts["PUT /api/position"] > j.counts["WS PUT /api/position"] + 5));
  j = await st("?reset=1");
  T("stats: reset empties counters", Object.keys(j.counts).length === 0 && j.seconds_since_start <= 2);
}
process.exit(fails ? 1 : 0);
