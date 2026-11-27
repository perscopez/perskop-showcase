const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("perskop", {
  getProviders: () => ipcRenderer.invoke("perskop:get-providers"),
  getConfig: () => ipcRenderer.invoke("perskop:get-config"),
  chat: (payload) => ipcRenderer.invoke("perskop:chat", payload),
  memory: () => ipcRenderer.invoke("perskop:memory"),
});
