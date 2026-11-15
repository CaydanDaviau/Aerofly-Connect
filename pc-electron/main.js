const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const WebSocket = require("ws");
const { Store, simHostProblem } = require("./core/config");
const { Api, SERVER } = require("./core/api");
const { Flight } = require("./core/flight");
const { TcpLink, UdpLink } = require("./core/sim");
const simbrief = require("./core/simbrief");

if (!app.requestSingleInstanceLock()) app.quit();
let win, store, flight;

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

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
      api, store, onState: s => send("flight:state", s),
      makeLink: () => (store.data.simSource === "tcp" ? new TcpLink(store.data.simIp.trim()) : new UdpLink()),
    });
    return flight.start();
  });
  ipcMain.handle("flight:stop", async () => { if (flight) await flight.stop(); return true; });
  ipcMain.handle("flight:state", () => (flight ? flight.state() : null));

  ipcMain.handle("health", async () => {
    try {
      const h = { "X-API-Key": store.data.key }; if (store.data.group) h["X-Group"] = store.data.group;
      const r = await fetch(SERVER + "/api/health", { headers: h });
      const j = await r.json(); return j.pilots !== undefined ? j.pilots : j.active_clients;
    } catch (e) { return null; }
  });
  ipcMain.handle("simbrief", async (e, u) => {
    const p = await simbrief.fetchPlan(u);
    if (!p.error) store.set({ simbrief: u, sbRoute: { dep: p.dep, arr: p.arr, points: p.points, route: p.route } });
    return p;
  });
  ipcMain.handle("open", (e, what) => {
    const c = store.data, q = "?key=" + encodeURIComponent(c.key) + (c.group ? "&group=" + encodeURIComponent(c.group) : "") + (c.lang ? "&lang=" + c.lang : "");
    shell.openExternal(SERVER + (what === "map" ? "/map" : "/atc") + q);
  });
});

app.on("window-all-closed", async () => { try { if (flight) await flight.stop(); } catch (e) {} app.quit(); });
