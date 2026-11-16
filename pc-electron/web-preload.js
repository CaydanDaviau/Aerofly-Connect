const { contextBridge, ipcRenderer } = require("electron");
// Lets /map show its PiP button: toggles the window between normal and small always-on-top.
contextBridge.exposeInMainWorld("AFPC", { pip: () => ipcRenderer.send("map:pip") });
