const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const path = require("path");
const WebSocket = require("ws");
const { Store, simHostProblem } = require("./core/config");
const { Api, SERVER } = require("./core/api");
const { Flight } = require("./core/flight");
const { Airports } = require("./core/airports");
const { stepFreq } = require("./core/atc");
const { TcpLink, UdpLink } = require("./core/sim");
const simbrief = require("./core/simbrief");

if (!app.requestSingleInstanceLock()) app.quit();
let win, store, flight, mapWin = null, ctlWin = null, mapBig = { width: 900, height: 700 }, ov = null, ovDrag = null, ovTyping = false;

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

// ---- always-on-top ATC overlay (bubble / panel), created while flying if enabled in Settings ----
function ovArea() { return screen.getDisplayMatching(ov ? ov.getBounds() : screen.getPrimaryDisplay().bounds).workArea; }
function ovClamp(x, y, w, h) { const a = ovArea(); return [Math.min(Math.max(x, a.x), a.x + a.width - w), Math.min(Math.max(y, a.y), a.y + a.height - h)]; }
function createOverlay() {
  if (ov || store.data.overlay === false) return;
  const a = screen.getPrimaryDisplay().workArea, p = store.data.ov || {};
  ov = new BrowserWindow({ width: 56, height: 56, x: p.x != null ? p.x : a.x + a.width - 90, y: p.y != null ? p.y : a.y + 120, frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required" } });
  ov.setAlwaysOnTop(true, "screen-saver");
  ov.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  ov.once("ready-to-show", () => { if (ov) ov.showInactive(); });
  ov.on("closed", () => { ov = null; });
}
function closeOverlay() { if (ov && !ov.isDestroyed()) ov.destroy(); ov = null; ovTyping = false; }
function sendOv(s) { if (ov && !ov.isDestroyed()) ov.webContents.send("overlay:state", s ? s.atc : null); }
// ---- map and controller radar in their own windows (or the browser, Settings switch) ----
function webUrl(what) {
  const c = store.data;
  return SERVER + (what === "map" ? "/map" : "/atc") + "?key=" + encodeURIComponent(c.key) + (c.group ? "&group=" + encodeURIComponent(c.group) : "") + (c.lang ? "&lang=" + c.lang : "");
}
const isSmall = w => { const b = w.getBounds(); return b.width < 420 && b.height < 420; };
function openWeb(what) {
  if (store.data.browser) { shell.openExternal(webUrl(what)); return; }
  const cur = what === "map" ? mapWin : ctlWin;
  if (cur && !cur.isDestroyed()) { if (cur.isMinimized()) cur.restore(); cur.show(); cur.focus(); return; }
  const w = new BrowserWindow({ width: what === "map" ? 900 : 1100, height: what === "map" ? 700 : 760, minWidth: 220, minHeight: 160, backgroundColor: "#1a1a1a", autoHideMenuBar: true, icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "web-preload.js"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required" } });
  w.setTitle(what === "map" ? "Aerofly Connect - Map" : "Aerofly Connect - Radar");
  w.on("page-title-updated", e => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // seen on a real PC: the page's <head> (title, CSS, JS) was drawn as text over the map; keep head content hidden
  const hideHead = () => {
    if (w.isDestroyed()) return;
    w.webContents.insertCSS("head,head *,style,script,title,link,meta,noscript,template{display:none!important}").catch(() => {});
    w.webContents.executeJavaScript("document.querySelectorAll('style,script,title,link,meta,noscript,head').forEach(function(e){e.style.setProperty('display','none','important')})").catch(() => {});
  };
  w.webContents.on("dom-ready", hideHead);
  w.webContents.on("did-finish-load", () => { hideHead(); setTimeout(hideHead, 1500); });
  w.webContents.on("did-fail-load", (e, code, desc, url, main) => { if (main && code !== -3) w.loadURL("data:text/html," + encodeURIComponent("<body style='font:15px system-ui;background:#222;color:#eee;padding:24px'>Could not load the page (" + desc + "). Check your connection, or turn on 'Open in the browser' in Settings.</body>")); });
  w.loadURL(webUrl(what));
  if (what === "map") {
    mapWin = w;
    // small window = PiP look (the page switches by size) and stays on top of the sim; big = normal window
    const sync = () => { if (!w.isDestroyed()) w.setAlwaysOnTop(isSmall(w), "screen-saver"); };
    w.on("resize", sync);
    w.webContents.on("did-finish-load", () => { if (flight) pushOwn(flight.state()); });
    w.on("closed", () => { mapWin = null; });
  } else { ctlWin = w; w.on("closed", () => { ctlWin = null; }); }
}
function pushOwn(s) {
  if (!mapWin || mapWin.isDestroyed() || !s || !s.running || !s.own) return;
  const o = s.own, n = v => (Number.isFinite(Number(v)) ? Number(v) : null), j = JSON.stringify;
  mapWin.webContents.executeJavaScript("window.__appOwn=true;window.setOwn&&window.setOwn(" + [n(o.lat), n(o.lon), n(o.hdg), n(o.gs), n(o.alt), j(o.callsign || ""), n(o.eta), n(o.fpm)].join(",") + ")").catch(() => {});
}

function onFlightState(s) {
  send("flight:state", s); pushOwn(s);
  if (s.running) { createOverlay(); sendOv(s); } else closeOverlay();
}

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 820, minWidth: 400, minHeight: 600, backgroundColor: "#00414B", autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  store = new Store(app.getPath("userData"));
  createWindow();

  ipcMain.handle("cfg:get", () => ({ ...store.data, version: app.getVersion(), locale: app.getLocale() }));
  ipcMain.handle("cfg:set", (e, p) => { store.set(p); return true; });
  ipcMain.handle("cfg:flight", (e, p) => { store.setFlight(p); return true; });

  ipcMain.handle("flight:start", async () => {
    if (flight && flight.state().running) return {};
    const c = store.data;
    if (c.simSource === "tcp") {
      const pr = simHostProblem(c.simIp);
      if (!c.simIp.trim()) return { error: "noip" };
      if (pr) return { error: pr };
    }
    const api = new Api({ key: c.key, group: c.group, WebSocket });
    flight = new Flight({
      api, store, airports: new Airports({ fetchFn: async u => { const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }, cache: { get: k => store.cacheGet(k), put: (k, v) => store.cachePut(k, v) } }), onState: onFlightState,
      makeLink: () => (store.data.simSource === "tcp" ? new TcpLink(store.data.simIp.trim()) : new UdpLink()),
    });
    api.onVoice(j => { if (ov && !ov.isDestroyed()) ov.webContents.send("overlay:voice", j); });
    return flight.start();
  });
  ipcMain.handle("flight:stop", async () => { if (flight) await flight.stop(); return true; });
  ipcMain.handle("flight:state", () => (flight ? flight.state() : null));

  // overlay: window mechanics
  ipcMain.on("overlay:ready", () => { if (flight) sendOv(flight.state()); });
  ipcMain.on("overlay:size", (e, { w, h }) => {
    if (!ov || ov.isDestroyed() || !(w > 20) || !(h > 20)) return;
    const b = ov.getBounds(), [x, y] = ovClamp(b.x, b.y, w, h); ov.setBounds({ x, y, width: w, height: h });
  });
  ipcMain.on("overlay:drag", (e, d) => {
    if (!ov || ov.isDestroyed()) return;
    if (d.t === "start") ovDrag = { sx: d.sx, sy: d.sy, b: ov.getBounds() };
    else if (d.t === "move" && ovDrag) { const [x, y] = ovClamp(ovDrag.b.x + d.sx - ovDrag.sx, ovDrag.b.y + d.sy - ovDrag.sy, ovDrag.b.width, ovDrag.b.height); ov.setPosition(x, y); }
    else if (d.t === "end") { if (ovDrag) { const b = ov.getBounds(); store.set({ ov: { x: b.x, y: b.y } }); } ovDrag = null; }
  });
  // the overlay never takes focus from the sim except while a text field is being edited
  ipcMain.on("overlay:typing", (e, on) => { if (!ov || ov.isDestroyed()) return; ovTyping = on; ov.setFocusable(on); if (on) ov.focus(); else ov.blur(); });
  // overlay: ATC actions
  const A = () => (flight && flight.state().running ? flight.atc : null);
  ipcMain.handle("atc:reply", (e, id, which) => A() ? A().reply(id, which) : false);
  ipcMain.handle("atc:request", (e, type) => A() ? A().request(type) : null);
  ipcMain.handle("atc:emergency", () => A() ? A().emergencyTap() : null);
  ipcMain.handle("atc:chat", (e, text) => A() ? A().chat(text) : null);
  ipcMain.handle("atc:atis", (e, icao) => A() ? A().fetchAtis(icao) : null);
  ipcMain.handle("atc:freq", (e, mode, v) => { const a = A(); if (!a) return ""; return a.setFreq(mode === "step" ? stepFreq(a.freq, v.dir, v.khz) : v); });

  let latestPc = "";
  ipcMain.handle("latest", () => latestPc);
  ipcMain.handle("health", async () => {
    try {
      const h = { "X-API-Key": store.data.key }; if (store.data.group) h["X-Group"] = store.data.group;
      const r = await fetch(SERVER + "/api/health", { headers: h });
      const j = await r.json(); latestPc = j.latest_pc || ""; return j.pilots !== undefined ? j.pilots : j.active_clients;
    } catch (e) { return null; }
  });
  ipcMain.handle("simbrief", async (e, u) => {
    const p = await simbrief.fetchPlan(u);
    if (!p.error) store.set({ simbrief: u, sbRoute: { dep: p.dep, arr: p.arr, points: p.points, route: p.route } });
    return p;
  });
  ipcMain.handle("open", (e, what) => { if (what === "update") shell.openExternal("https://github.com/CaydanDaviau/Aerofly-Connect/releases/tag/pc2-latest"); else openWeb(what); return true; });
  ipcMain.on("map:pip", () => {
    if (!mapWin || mapWin.isDestroyed()) return;
    if (isSmall(mapWin)) mapWin.setSize(mapBig.width, mapBig.height);
    else { const b = mapWin.getBounds(); mapBig = { width: Math.max(500, b.width), height: Math.max(400, b.height) }; mapWin.setSize(380, 300); }
  });
  // controller radar: hold-to-talk needs the microphone, only for our own server
  const mediaOk = wc => { const u = wc ? wc.getURL() : ""; return u.startsWith(SERVER) || u.startsWith("file://"); };   // radar page and our own overlay
  const ses = require("electron").session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === "media" && mediaOk(wc)));
  ses.setPermissionCheckHandler((wc, perm) => perm === "media" && mediaOk(wc));
  // live PTT: the overlay sends start/chunk/end over the flight's WebSocket
  ipcMain.handle("voice:clip", (e, body) => (flight && flight.state().running ? flight.api.request("PUT", "/api/voice/clip", body) : null));
  ipcMain.handle("voice:tx", (e, action, payload) => (flight && flight.state().running ? flight.api.sendVoiceStream(String(action), payload || {}) : false));
});

app.on("window-all-closed", async () => { try { if (flight) await flight.stop(); } catch (e) {} app.quit(); });
