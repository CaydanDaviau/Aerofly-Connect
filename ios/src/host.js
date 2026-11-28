// iOS host: replaces Electron's main process. Runs the PC app's core (flight loop, ATC panel, API) inside the WebView and
// exposes the same window.afc / window.ov interfaces the PC renderer and overlay already use.
const { Store, simHostProblem, effKey } = require("../../pc-electron/core/config");
const { Api, SERVER } = require("../../pc-electron/core/api");
const { Flight } = require("../../pc-electron/core/flight");
const { Airports } = require("../../pc-electron/core/airports");
const { stepFreq } = require("../../pc-electron/core/atc");
const { toPosition } = require("../../pc-electron/core/sim");
const simbrief = require("../../pc-electron/core/simbrief");

const VERSION = "1.0.0";
const sim = () => window.AFSim;

// ---- native HTTP (no CORS), fetch-like ----
async function nfetch(url, o = {}) {
  const r = await sim().http(o.method || "GET", url, o.headers || {}, o.body, 9000);
  return { status: r.status, ok: r.status < 400, text: async () => r.body, json: async () => JSON.parse(r.body) };
}

// ---- WebSocket with the Node "ws" surface core/api.js uses ----
class WSA {
  constructor(url) { this.w = new WebSocket(url); this.cb = {}; }
  on(ev, cb) {
    const w = this.w;
    if (ev === "open") w.onopen = () => cb();
    else if (ev === "message") w.onmessage = e => cb(typeof e.data === "string" ? e.data : "");
    else if (ev === "close") w.onclose = () => cb();
    else if (ev === "error") w.onerror = () => cb();
  }
  send(d, cb) { this.w.send(d); if (cb) cb(); }
  ping() { try { this.w.send("ping"); } catch (e) {} }
  terminate() { try { this.w.close(); } catch (e) {} }
  close() { try { this.w.close(); } catch (e) {} }
}

// ---- Aerofly sim link over the native TCP plugin (same interface as core/sim.js TcpLink) ----
class NativeTcp {
  constructor(host) { this.host = host; this.open = true; }
  isOpen() { return this.open; }
  async readLine() { return sim().tcpRead(this.host, 58585, 2000); }
  close() { try { sim().tcpClose(); } catch (e) {} }
  stop() { this.close(); }
}

const store = new Store("/aerofly");
if (!store.data.iosInit) { store.set({ iosInit: true, simSource: "tcp", simIp: store.data.simIp || "127.0.0.1", overlay: true }); }
if (store.data.simSource !== "tcp") store.set({ simSource: "tcp" });

let flight = null, stateCbs = [], ovCbs = [], voiceCbs = [], latest = "";
const hdr = (k, extra) => { const c = store.data, h = { "X-API-Key": k || effKey(c), "X-Mode": c.mode === "casual" ? "casual" : "expert", ...(extra || {}) }; if (c.group) h["X-Group"] = c.group; return h; };
const webUrl = what => {
  const c = store.data, p = { map: "/map", train: "/train", events: "/events", atc: "/atc" }[what] || "/atc";
  return SERVER + p + "?key=" + encodeURIComponent(effKey(c)) + "&mode=" + (c.mode === "casual" ? "casual" : "expert") + (c.group ? "&group=" + encodeURIComponent(c.group) : "") + (c.lang ? "&lang=" + c.lang : "");
};

function ovState(s) {
  if (!s || !s.atc) return null;
  const f = store.data.flight || {}, o = s.own || {};
  return { ...s.atc, tel: s.own ? { alt: o.alt, hdg: o.hdg, gs: o.gs, vs: o.vs, lat: o.lat, lon: o.lon } : null, plan: { dep: f.dep, arr: f.arr, deprwy: f.deprwy, arrrwy: f.arrrwy, cruise: f.cruise, route: f.route }, mapUrl: webUrl("map") };
}
let lastRunning = false;
function onFlightState(s) {
  stateCbs.forEach(cb => cb(s));
  ovCbs.forEach(cb => cb(ovState(s)));
  if (!s.running && lastRunning) { sim().keepAlive(false).catch(() => {}); }
  lastRunning = !!s.running;
  document.body.classList.toggle("flying", !!s.running);
}

const A = () => (flight && flight.state().running ? flight.atc : null);

window.afc = {
  cfg: async () => ({ ...store.data, version: VERSION, locale: navigator.language }),
  set: async p => { store.set(p); return true; },
  setFlight: async p => { store.setFlight(p); return true; },
  start: async () => {
    if (flight && flight.state().running) return {};
    const c = store.data;
    if (!c.simIp.trim()) return { error: "noip" };
    const pr = simHostProblem(c.simIp); if (pr) return { error: pr };
    const api = new Api({ key: effKey(c), group: c.group, mode: c.mode, WebSocket: WSA, fetchFn: nfetch });
    flight = new Flight({
      api, store, onState: onFlightState,
      airports: new Airports({ fetchFn: async u => { const r = await nfetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }, cache: { get: k => store.cacheGet(k), put: (k, v) => store.cachePut(k, v) } }),
      makeLink: () => new NativeTcp(store.data.simIp.trim()),
    });
    api.onVoice(j => voiceCbs.forEach(cb => cb(j)));
    try { await sim().keepAlive(true); } catch (e) {}
    return flight.start();
  },
  stop: async () => { if (flight) await flight.stop(); return true; },
  state: async () => (flight ? flight.state() : null),
  health: async () => {
    try {
      const r = await nfetch(SERVER + "/api/health", { headers: hdr() });
      if (r.status === 401 && store.data.token) store.set({ token: "", acctName: "" });
      const j = await r.json(); latest = j.latest_ios || ""; return j.pilots !== undefined ? j.pilots : j.active_clients;
    } catch (e) { return null; }
  },
  latest: async () => latest,
  profile: async nick => {
    try {
      const r = await nfetch(SERVER + "/api/profile", nick == null ? { headers: hdr() } : { method: "PUT", headers: hdr(null, { "Content-Type": "application/json" }), body: JSON.stringify({ nick }) });
      const b = await r.text();
      if (r.status >= 400) return { error: "HTTP " + r.status + " " + b.slice(0, 80) };
      return JSON.parse(b);
    } catch (e) { return { error: "net" }; }
  },
  account: async (op, name, pw) => {
    const c = store.data, base = SERVER + "/api/account/", J = { "Content-Type": "application/json" };
    try {
      if (op === "logout") { if (c.token) { try { await nfetch(base + "logout", { method: "POST", headers: hdr(c.token, J), body: "{}" }); } catch (e) {} } store.set({ token: "", acctName: "" }); return { ok: true }; }
      if (op === "password") {
        if (!c.token) return { error: "bad_login" };
        const r = await nfetch(base + "password", { method: "POST", headers: hdr(c.token, J), body: JSON.stringify({ old: name, new: pw }) });
        const j = await r.json().catch(() => ({})); return r.status >= 400 ? { error: j.error || ("http" + r.status) } : { ok: true };
      }
      if (flight && flight.state().running) return { error: "flight" };
      const r = await nfetch(base + (op === "register" ? "register" : "login"), { method: "POST", headers: hdr(c.key, J), body: JSON.stringify({ name, password: pw }) });
      const j = await r.json().catch(() => ({}));
      if (r.status >= 400 || !j.token) return { error: j.error || ("http" + r.status) };
      store.set({ token: j.token, acctName: j.name || name }); return { ok: true, name: j.name || name };
    } catch (e) { return { error: "net" }; }
  },
  simbrief: async u => {
    const p = await simbrief.fetchPlan(u, nfetch);
    if (!p.error) store.set({ simbrief: u, sbRoute: { dep: p.dep, arr: p.arr, points: p.points, route: p.route } });
    return p;
  },
  open: async what => {
    if (what === "update") { window.open("https://github.com/CaydanDaviau/Aerofly-Connect/releases/tag/ios-latest", "_system"); return true; }
    window.openSheet(what, webUrl(what)); return true;
  },
  onState: cb => stateCbs.push(cb),
};

// overlay interface (the overlay page runs in an iframe and reuses this object)
window.ov = {
  onState: cb => ovCbs.push(cb),
  ready: () => { if (flight) ovCbs.forEach(cb => cb(ovState(flight.state()))); },
  size() {}, drag() {}, typing() {},
  reply: (id, w) => A() ? A().reply(id, w) : false,
  request: (t, alt) => A() ? A().request(t, alt) : null,
  emergency: () => A() ? A().emergencyTap() : null,
  chat: t => A() ? A().chat(t) : null,
  atis: i => A() ? A().fetchAtis(i) : null,
  clip: b => (flight && flight.state().running ? flight.api.request("PUT", "/api/voice/clip", b) : null),
  voice: (a, p) => (flight && flight.state().running ? flight.api.sendVoiceStream(String(a), p || {}) : false),
  onVoice: cb => voiceCbs.push(cb),
  freq: (mode, v) => { const a = A(); if (!a) return ""; return a.setFreq(mode === "step" ? stepFreq(a.freq, v.dir, v.khz) : v); },
};

// exported for the headless test
window.__afc = { toPosition, store, nfetch };

// the ATC panel page needs window.ov, so it loads only now
document.getElementById("atcFrame").src = "overlay.html";
