const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("catalogoLoja", {
  lerConfig: () => ipcRenderer.invoke("config:ler"),
  salvarConfig: (url) => ipcRenderer.invoke("config:salvar", url),
  recarregar: () => ipcRenderer.invoke("app:recarregar")
});
