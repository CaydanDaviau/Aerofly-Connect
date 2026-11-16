const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ov", {
  onState: cb => ipcRenderer.on("overlay:state", (e, s) => cb(s)),
  ready: () => ipcRenderer.send("overlay:ready"),
  size: (w, h) => ipcRenderer.send("overlay:size", { w, h }),
  drag: (t, sx, sy) => ipcRenderer.send("overlay:drag", { t, sx, sy }),
  typing: on => ipcRenderer.send("overlay:typing", !!on),
  reply: (id, which) => ipcRenderer.invoke("atc:reply", id, which),
  request: type => ipcRenderer.invoke("atc:request", type),
  emergency: () => ipcRenderer.invoke("atc:emergency"),
  chat: text => ipcRenderer.invoke("atc:chat", text),
  atis: icao => ipcRenderer.invoke("atc:atis", icao),
  voice: (action, payload) => ipcRenderer.invoke("voice:tx", action, payload),
  onVoice: cb => ipcRenderer.on("overlay:voice", (e, j) => cb(j)),
  freq: (mode, v) => ipcRenderer.invoke("atc:freq", mode, v),
});
