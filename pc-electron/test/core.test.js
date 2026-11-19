const assert = require("assert"), os = require("os"), fs = require("fs"), path = require("path");
const { toPosition, UdpLink } = require("../core/sim");
const { Store, simHostProblem, effKey } = require("../core/config");
const simbrief = require("../core/simbrief");
const { Api } = require("../core/api");
const { Flight } = require("../core/flight");
let pass = 0; const T = (n, f) => { try { const r = f(); if (r && r.then) return r.then(() => { pass++; console.log("PASS", n); }, e => { console.log("FAIL", n, e.message); process.exitCode = 1; }); pass++; console.log("PASS", n); } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };

(async () => {
  T("sim line", () => { const p = toPosition("-15.871444|-47.980871|4543|279|299|217|232|1782"); assert.deepStrictEqual(p, { latitude: -15.871444, longitude: -47.980871, altitude_ft: 4543, heading_true: 279, heading_mag: 299, ground_speed: 232, vertical_speed_ft_min: 1782 }); });
  T("sim line header + junk", () => { assert.ok(toPosition("gmap_dat|1|2|3|4|5|6|7")); assert.strictEqual(toPosition("0|0|1|2"), null); assert.strictEqual(toPosition("abc"), null); assert.strictEqual(toPosition("95|0|1|2|3|4|5|6"), null); });
  T("udp xgps/xatt", () => { const u = new UdpLink(); u.handle("XGPSAerofly,-47.9,-15.8,1000,90,100", 10); u.handle("XATTAerofly,270,0,0", 10); u.handle("XGPSAerofly,-47.9,-15.8,1030,90,100", 11);
    const p = u.position(11.5); assert.strictEqual(p.heading_true, 270); assert.strictEqual(p.ground_speed, 194); assert.ok(p.vertical_speed_ft_min > 0); assert.strictEqual(u.position(20), null); });
  T("sim host check", () => { assert.strictEqual(simHostProblem("192.0.0.2"), "mobile"); assert.strictEqual(simHostProblem("1.2.3"), "invalid"); assert.strictEqual(simHostProblem("192.168.1.5"), ""); assert.strictEqual(simHostProblem(""), ""); });
  T("store key + persist", () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "afc")); const s = new Store(d); assert.ok(/^rv[0-9a-f]{16}$/.test(s.data.key)); s.setFlight({ dep: "SBBR" }); const s2 = new Store(d); assert.strictEqual(s2.data.flight.dep, "SBBR"); assert.strictEqual(s2.data.key, s.data.key); });
  T("simbrief parse", () => { const p = simbrief.parse({ fetch: { status: "Success" }, origin: { icao_code: "vko", plan_rwy: "28L" }, destination: { icao_code: "aer", plan_rwy: "22R" }, general: { icao_airline: "DP", flight_number: "9281", initial_altitude: "36000", route: "A B" }, atc: { callsign: "" }, aircraft: { icaocode: "b738" }, navlog: { fix: [{ pos_lat: "55.1", pos_long: "37.2", altitude_feet: "0", ident: "VKO" }, { pos_lat: "43.4", pos_long: "39.9", altitude_feet: "100", ident: "AER" }] } });
    assert.strictEqual(p.error, ""); assert.strictEqual(p.callsign, "DP9281"); assert.strictEqual(p.dep, "VKO"); assert.strictEqual(p.points.length, 2); assert.strictEqual(simbrief.parse({ fetch: { status: "Error: Unknown UserID" } }).error, "user"); });

  // Flight loop against a fake server
  const calls = []; let posCode = 200;
  const fetchFn = async (url, o) => { const path = url.replace(/^https:\/\/[^/]+/, ""); calls.push({ m: o.method, path, body: o.body ? JSON.parse(o.body) : null, h: o.headers });
    const code = path === "/api/position" && o.method === "PUT" ? posCode : 200; return { status: code, text: async () => (code === 423 ? JSON.stringify({ remaining_s: 120, landing_fpm: -1800 }) : JSON.stringify({ success: true, messages: path === "/api/position" ? [{ text: "Squawk 4321" }] : [] })) }; };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afc")); const store = new Store(d);
  store.setFlight({ callsign: "pedro1", dep: "sbbr", arr: "sbgr", model: "A320" }); store.set({ simSource: "tcp", simIp: "1.2.3.4", group: "g", sbRoute: { dep: "SBBR", arr: "SBGR", points: [[1, 2, 0, "A"], [3, 4, 0, "B"]], route: "A B" } });
  const api = new Api({ key: store.data.key, group: "g", WebSocket: null, fetchFn });
  const link = { n: 0, readLine: async () => "-15.8|-47.9|3000|90|95|200|210|0", close() {} };
  const f = new Flight({ api, store, makeLink: () => link });
  f.link = link; f.planSent = false; f.routeSent = false;
  await T("turn uploads plan, route, position", async () => { await f.turn();
    const m = calls.map(c => c.m + " " + c.path); assert.deepStrictEqual(m, ["PUT /api/flightplan", "PUT /api/flightplan/route", "PUT /api/position"]);
    assert.strictEqual(calls[0].body.callsign, "PEDRO1"); assert.strictEqual(calls[0].body.departure_airport, "SBBR");
    const pos = calls[2].body; assert.strictEqual(pos.airplane_model, "A320"); assert.strictEqual(pos.voice, true); assert.strictEqual(pos.heading_mag, 95);
    assert.strictEqual(calls[2].h["X-Group"], "g"); assert.strictEqual(f.state().uploads, 1); assert.strictEqual(f.state().messages[0].text, "Squawk 4321"); });
  await T("second turn only position", async () => { calls.length = 0; await f.turn(); assert.deepStrictEqual(calls.map(c => c.path), ["/api/position"]); });
  await T("route not sent for other airports", async () => { const f2 = new Flight({ api, store, makeLink: () => link }); f2.link = link; store.setFlight({ arr: "SBGL" }); calls.length = 0; await f2.turn(); assert.ok(!calls.some(c => c.path.endsWith("/route"))); });
  await T("423 crash blocks start", async () => { posCode = 423; const f3 = new Flight({ api, store, makeLink: () => link }); f3.link = link; calls.length = 0; const r = await f3.turn(); assert.strictEqual(r, "crash"); assert.ok(store.data.crashUntil > Date.now()); const s = await f3.start(); assert.strictEqual(s.error, "crash"); posCode = 200; });
  await T("websocket path", async () => {
    const EventEmitter = require("events"); const sent = [];
    class FakeWS extends EventEmitter { constructor(u) { super(); this.u = u; FakeWS.last = this; setTimeout(() => this.emit("open"), 1); } send(x) { const j = JSON.parse(x); sent.push(j); setTimeout(() => this.emit("message", JSON.stringify({ id: j.id, status: 200, body: { success: true } })), 1); } ping() {} close() {} terminate() {} }
    const a = new Api({ key: "k1", group: "g 1", WebSocket: FakeWS, fetchFn: async () => { throw new Error("http used"); } });
    a.ensure(); await new Promise(r => setTimeout(r, 10)); assert.ok(a.live()); assert.ok(FakeWS.last.u.includes("wss://") && FakeWS.last.u.includes("key=k1") && FakeWS.last.u.includes("group=g%201"));
    const r = await a.request("PUT", "/api/position", { latitude: 1 }); assert.strictEqual(r.code, 200); assert.strictEqual(sent[0].path, "/api/position"); assert.strictEqual(sent[0].body.latitude, 1);
    FakeWS.last.emit("close"); assert.ok(!a.live()); a.shutdown();
  });
  console.log(pass + " passed"); 
})();

T("account: token replaces the device key, signed out falls back", () => { assert.strictEqual(effKey({ key: "rvabc", token: "" }), "rvabc"); assert.strictEqual(effKey({ key: "rvabc", token: "afa_1" }), "afa_1"); });
