// Catálogo Rildon — versão LOJA (consulta no balcão).
// Janela única que abre o servidor da loja em "modo consulta" (?app=catalogo):
// só a aba Catálogo. O endereço do servidor é configurável (Ctrl+Shift+E; antes: Arquivo > Endereço
// do servidor) e fica guardado em config.json na pasta de dados do programa.
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const PADRAO = { url: "http://192.168.0.2:3000" };
let janela = null;

const arquivoConfig = () => path.join(app.getPath("userData"), "config.json");

function lerConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(arquivoConfig(), "utf8"));
    return { ...PADRAO, ...c };
  } catch {
    return { ...PADRAO };
  }
}

function salvarConfig(c) {
  fs.mkdirSync(path.dirname(arquivoConfig()), { recursive: true });
  fs.writeFileSync(arquivoConfig(), JSON.stringify(c, null, 2));
}

function urlNormalizada(txt) {
  let u = String(txt || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  new URL(u); // lança erro se inválida
  return u;
}

function carregar() {
  if (!janela) return;
  const { url } = lerConfig();
  janela.loadURL(`${url}/?app=catalogo`);
}

// Sem login: todo pedido ao servidor da loja leva o cabeçalho que libera a
// CONSULTA do catálogo (só leitura, só rede interna — ver
// src/middlewares/catalogo-consulta.js no servidor).
function liberarConsultaSemLogin() {
  session.defaultSession.webRequest.onBeforeSendHeaders((detalhes, cb) => {
    const base = lerConfig().url;
    if (detalhes.url.startsWith(base)) detalhes.requestHeaders["X-Consulta-Catalogo"] = "1";
    cb({ requestHeaders: detalhes.requestHeaders });
  });
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Catálogo Rildon",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  janela.setMenuBarVisibility(false);
  atalhos(janela.webContents);

  // Links externos abrem no navegador; a janela só navega no servidor da loja.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      const base = lerConfig().url;
      if (url.startsWith(base)) return { action: "allow" };
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Servidor fora do ar / sem rede: tela amigável com "Tentar de novo".
  janela.webContents.on("did-fail-load", (_e, codigo, descricao, urlFalha, principal) => {
    if (!principal || codigo === -3) return; // -3 = navegação cancelada
    janela.loadFile(path.join(__dirname, "erro.html"), {
      query: { url: lerConfig().url, motivo: descricao || String(codigo) }
    });
  });

  carregar();
}

function pedirEndereco() {
  const atual = lerConfig().url;
  const w = new BrowserWindow({
    parent: janela, modal: true, width: 520, height: 230, resizable: false,
    title: "Endereço do servidor", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true }
  });
  w.setMenu(null);
  w.loadFile(path.join(__dirname, "erro.html"), { query: { modo: "config", url: atual } });
}

// Sem barra de menu (Arquivo/Exibir): a tela fica só com o catálogo. Os atalhos
// ficam por teclado: F5 recarrega, Ctrl+Shift+E muda o endereço do servidor,
// Ctrl +/-/0 zoom, F11 tela cheia.
function montarMenu() {
  Menu.setApplicationMenu(null);
}

function atalhos(wc) {
  wc.on("before-input-event", (e, i) => {
    if (i.type !== "keyDown") return;
    const ctrl = i.control || i.meta;
    const tecla = String(i.key || "").toLowerCase();
    if (tecla === "f5") { e.preventDefault(); carregar(); }
    else if (tecla === "f11") { e.preventDefault(); janela.setFullScreen(!janela.isFullScreen()); }
    else if (ctrl && i.shift && tecla === "e") { e.preventDefault(); pedirEndereco(); }
    else if (ctrl && (tecla === "+" || tecla === "=")) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() + 0.5); }
    else if (ctrl && (tecla === "-" || tecla === "_")) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() - 0.5); }
    else if (ctrl && tecla === "0") { e.preventDefault(); wc.setZoomLevel(0); }
  });
}

ipcMain.handle("config:ler", () => lerConfig());
ipcMain.handle("config:salvar", (_e, txt) => {
  try {
    const url = urlNormalizada(txt);
    salvarConfig({ ...lerConfig(), url });
    BrowserWindow.getAllWindows().forEach((w) => { if (w !== janela) w.close(); });
    carregar();
    return { ok: true, url };
  } catch {
    return { ok: false, erro: "Endereço inválido. Exemplo: http://192.168.0.2:3000" };
  }
});
ipcMain.handle("app:recarregar", () => carregar());

// Só uma janela do programa por vez.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); } });
  app.whenReady().then(() => { liberarConsultaSemLogin(); montarMenu(); criarJanela(); });
  app.on("window-all-closed", () => app.quit());
}
