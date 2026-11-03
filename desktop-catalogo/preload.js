const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("catalogoLoja", {
  lerConfig: () => ipcRenderer.invoke("config:ler"),
  salvarConfig: (url) => ipcRenderer.invoke("config:salvar", url),
  recarregar: () => ipcRenderer.invoke("app:recarregar"),
  // Aviso de nova versão do programa.
  versaoNova: () => ipcRenderer.invoke("app:versao-nova"),
  atualizar: () => ipcRenderer.invoke("app:atualizar"),
  aoHaverNovaVersao: (cb) => ipcRenderer.on("app:nova-versao", (_e, v) => cb(v)),
  aoProgressoAtualizacao: (cb) => ipcRenderer.on("app:progresso-atualizacao", (_e, p) => cb(p)),
  // Verificar atualizações dos catálogos agora (botão em "Ver Catálogos"); mesma rotina da meia-noite.
  sincronizarCatalogosAgora: () => ipcRenderer.invoke("catalogo:sincronizar-agora"),
  aoProgressoSincronizacao: (cb) => ipcRenderer.on("catalogo:sync-progresso", (_e, p) => cb(p)),
  // Cópia local dos catálogos (1º clique baixa e guarda; depois abre direto).
  catalogoLocalLer: (chave) => ipcRenderer.invoke("catalogo-local:ler", chave),
  catalogoLocalSalvar: (chave, versao, bytes, nome) => ipcRenderer.invoke("catalogo-local:salvar", chave, versao, bytes, nome),
  catalogoLocalApagar: (chave) => ipcRenderer.invoke("catalogo-local:apagar", chave),
  catalogoLocalListar: () => ipcRenderer.invoke("catalogo-local:listar"),
  catalogoLocalLerPorId: (id) => ipcRenderer.invoke("catalogo-local:ler-id", id),
  catalogoLocalAbrir: (id) => ipcRenderer.invoke("catalogo-local:abrir", id)
});
