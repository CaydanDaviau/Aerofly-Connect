// Mock-based tests for the /ws routing + push (run: node test-ws.mjs)
import worker, { Hub, TEST } from "./src/index.js";
TEST.skipGrades = true;
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


const ctlSock = async (key, hold) => { await worker.fetch(new Request("https://x/ws?key=" + key + "&holder=" + hold, { headers: { Upgrade: "websocket" } }), env); return socks[socks.length - 1]; };
const pil = async (key, cs, freq, extra = {}) => { await up(key); const w = socks[socks.length - 1]; await msg(w, { id: 1, method: "PUT", path: "/api/flightplan", body: { callsign: cs } }); await msg(w, { id: 2, method: "PUT", path: "/api/position", body: { latitude: -15.87, longitude: -47.92, altitude_ft: 3000, callsign: cs, freq, ...extra } }); return w; };
const p1 = await pil("p1", "AAA1", "131.500"), p2 = await pil("p2", "BBB2", "131.500", { voice: false }), p3 = await pil("p3", "CCC3", "118.000"), p4 = await pil("p4", "DDD4", "");
const H1 = "h-ctl1", H2 = "h-ctl2";
const c1 = await ctlSock("ctl1", H1), c2 = await ctlSock("ctl2", H2);
let a = await msg(c1, { id: 1, method: "PUT", path: "/api/atc/tower", body: { name: "SBBR_CTR", holder: H1, freq: "131.500", latitude: -15.87, longitude: -47.92 } });
T("controller claims CTR 131.500", a.status === 200);
const traffic = async w => (await msg(w, { id: 9, method: "GET", path: "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=100" })).body;
const stat = async () => { const t = await traffic(c1); const apt = t.aircraft.find(x => x.virtual_tower); return apt && apt.positions.find(x => x.pos === "CTR"); };
let st0 = await stat(); T("roster: 2 pilots + 1 controller on 131.500", st0 && st0.pilots === 2 && st0.ctls === 1);
a = await msg(c2, { id: 1, method: "PUT", path: "/api/atc/tower", body: { name: "SBBR_GND", holder: H2, freq: "131.500", latitude: -15.87, longitude: -47.92 } });
st0 = await stat(); T("second controller on the same frequency counts", st0.ctls === 2 && st0.pilots === 2);
await msg(c2, { id: 2, method: "DELETE", path: "/api/atc/tower?name=SBBR_GND&holder=" + H2 });

// ---- text to frequency
const fm = (w, body) => msg(w, { id: 3, method: "PUT", path: "/api/atc/freqmsg", body });
a = await fm(c1, { holder: H1, freq: "131.500", text: "AAA1 descend FL100, BBB2 maintain" });
T("freqmsg ok, heard by 2", a.status === 200 && a.body.heard_by === 2);
const FQ = { AAA1: "131.500", BBB2: "131.500", CCC3: "118.000", DDD4: "" };
const inbox = async (w, cs) => (await msg(w, { id: 4, method: "PUT", path: "/api/position", body: { latitude: -15.87, longitude: -47.92, altitude_ft: 3000, callsign: cs, freq: FQ[cs], ...(cs === "BBB2" ? { voice: false } : {}) } })).body.messages || [];
T("pilot on frequency gets it", (await inbox(p1, "AAA1")).some(m => m.text.includes("descend FL100")));
T("voice-off pilot on frequency still gets the text", (await inbox(p2, "BBB2")).some(m => m.text.includes("descend FL100")));
T("pilot on another frequency does not", !(await inbox(p3, "CCC3")).some(m => m.text.includes("descend")));
T("untuned pilot does not", !(await inbox(p4, "DDD4")).some(m => m.text.includes("descend")));
const t1 = await traffic(c1);
T("controller sees ONE log line with the count, no per-pilot copies", t1.atc_messages.filter(m => m.text.includes("descend")).length === 1 && t1.atc_messages.find(m => m.kind === "freq").n === 2 && t1.atc_messages.find(m => m.kind === "freq").icao_address === "");
a = await fm(c1, { holder: H1, freq: "118.000", text: "x" }); T("cannot write on a frequency you do not hold", a.status === 409 && a.body.error === "not_your_frequency");
a = await fm(c1, { holder: H1, freq: "131.500", text: "  " }); T("empty text refused", a.status === 400);
a = await fm(c1, { holder: "nobody", freq: "131.500", text: "hi" }); T("no role: division_required", a.status === 409 && a.body.error === "division_required");
a = await fm(c1, { holder: H1, freq: "", text: "hi" }); T("no frequency refused", a.status === 409 && a.body.error === "frequency_required");

// ---- speak on frequency (live stream, no aircraft named)
const n0 = [p1, p2, p3, p4, c1, c2].map(w => w.sent.length);
await hub.webSocketMessage(c1, JSON.stringify({ voice_stream: "start", id: "bc1", direction: "down", holder: H1, freq: "131.500", sampleRate: 16000 }));
await hub.webSocketMessage(c1, JSON.stringify({ voice_stream: "chunk", id: "bc1", data: "AQIDBA==" }));
await hub.webSocketMessage(c1, JSON.stringify({ voice_stream: "end", id: "bc1" }));
const got = (w, i) => w.sent.slice(n0[i]).map(JSON.parse).filter(x => x.push === "voice_stream");
T("pilot on 131.500 hears start+chunk+end", got(p1, 0).map(x => x.event).join() === "start,chunk,end");
T("start meta: down, freq, no aircraft", got(p1, 0)[0].meta.direction === "down" && got(p1, 0)[0].meta.freq === "131.500" && !got(p1, 0)[0].meta.icao);
T("voice-off pilot does not get audio", got(p2, 1).length === 0);
T("pilot on another frequency hears nothing", got(p3, 2).length === 0);
T("untuned pilot hears nothing", got(p4, 3).length === 0);
T("sender does not get its own audio", got(c1, 4).length === 0);
const n1 = p1.sent.length;
await hub.webSocketMessage(c1, JSON.stringify({ voice_stream: "start", id: "bc2", direction: "down", holder: H1, freq: "118.000", sampleRate: 16000 }));
T("speaking on a frequency you do not hold is dropped", p1.sent.length === n1 && p3.sent.slice(n0[2]).map(JSON.parse).filter(x => x.push === "voice_stream").length === 0);
// legacy: aircraft named still works per pilot
const n3 = p1.sent.length;
const icao1 = (await traffic(c1)).aircraft.find(x => x.callsign === "AAA1").icao_address;
await hub.webSocketMessage(c1, JSON.stringify({ voice_stream: "start", id: "bc3", direction: "down", holder: H1, icao_address: icao1, freq: "131.500", sampleRate: 16000 }));
T("per-aircraft stream still reaches only that pilot", p1.sent.length === n3 + 1 && p3.sent.slice(n0[2]).map(JSON.parse).filter(x => x.push === "voice_stream").length === 0);

// ---- other controller on the same frequency hears it too
hub.lastClaim.clear(); const r5 = await msg(c2, { id: 5, method: "PUT", path: "/api/atc/tower", body: { name: "SBBR_TWR", holder: H2, freq: "131.500", latitude: -15.87, longitude: -47.92 } });
const m2 = c2.sent.length;
await hub.webSocketMessage(c1, JSON.stringify({ voice_stream: "start", id: "bc4", direction: "down", holder: H1, freq: "131.500", sampleRate: 16000 }));
T("another controller on the frequency hears it", c2.sent.slice(m2).map(JSON.parse).some(x => x.push === "voice_stream" && x.event === "start"));

console.log(fails ? fails + " FAIL" : "0 FAIL"); process.exit(fails ? 1 : 0);
