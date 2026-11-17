const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("afc", {
  cfg: () => ipcRenderer.invoke("cfg:get"),
  set: p => ipcRenderer.invoke("cfg:set", p),
  setFlight: p => ipcRenderer.invoke("cfg:flight", p),
  start: () => ipcRenderer.invoke("flight:start"),
  stop: () => ipcRenderer.invoke("flight:stop"),
  state: () => ipcRenderer.invoke("flight:state"),
  health: () => ipcRenderer.invoke("health"),
  latest: () => ipcRenderer.invoke("latest"),
  simbrief: u => ipcRenderer.invoke("simbrief", u),
  open: w => ipcRenderer.invoke("open", w),
  onState: cb => ipcRenderer.on("flight:state", (e, s) => cb(s)),
});
