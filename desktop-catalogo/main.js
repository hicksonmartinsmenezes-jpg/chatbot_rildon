// Catálogo Rildon — versão LOJA (consulta no balcão).
// Janela única com a tela própria do programa (pasta app/), independente do painel de atendimento. O endereço do servidor é configurável (Ctrl+Shift+E; antes: Arquivo > Endereço
// do servidor) e fica guardado em config.json na pasta de dados do programa.
const { app, BrowserWindow, Menu, ipcMain, net, protocol, session, shell } = require("electron");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// O catálogo roda em contêiner próprio (porta 3001), separado do painel de atendimento (porta 3000).
const URL_ANTIGA = "http://192.168.0.2:3000";
const PADRAO = { url: "http://192.168.0.2:3001" };

// A tela do programa é servida por um endereço próprio (catalogo://) em vez de
// file://. Assim o leitor de PDF embutido (vendor/pdfjs, que usa módulos ES) e
// qualquer outro recurso carregam normalmente, inclusive de dentro do pacote.
// Leitor de PDF (pdf.js) em português: ele segue o idioma do programa.
app.commandLine.appendSwitch("lang", "pt-BR");
// Não trocar http:// por https:// sozinho (as fotos do servidor da loja são http).
app.commandLine.appendSwitch("disable-features", "MixedContentAutoupgrade,AutoupgradeMixedContent");

const ESQUEMA = "catalogo";
const TIPOS = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".pdf": "application/pdf", ".ftl": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8"
};
// "secure: false" de propósito: como origem segura, o Chromium tenta trocar as fotos
// do servidor (http://) por https:// e, não existindo https, a foto some do card.
protocol.registerSchemesAsPrivileged([
  { scheme: ESQUEMA, privileges: { standard: true, secure: false, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

function servirArquivosDoPrograma() {
  protocol.handle(ESQUEMA, async (req) => {
    let rel, busca;
    try {
      const u = new URL(req.url);
      rel = decodeURIComponent(u.pathname);
      busca = u.search || "";
    } catch { return new Response("", { status: 400 }); }

    // Fotos e demais arquivos do servidor passam por aqui (…/servidor/api/…).
    // O servidor marca as imagens como "só para a própria origem" (Cross-Origin-
    // Resource-Policy), então pedi-las direto da tela do programa dava
    // ERR_BLOCKED_BY_RESPONSE e o card ficava sem foto. Buscando por fora,
    // a imagem chega como se fosse do próprio programa.
    if (rel.startsWith("/servidor/")) {
      const alvo = lerConfig().url + rel.slice("/servidor".length) + busca;
      try {
        const r = await net.fetch(alvo, { headers: { "X-Consulta-Catalogo": "1" } });
        return new Response(r.body, {
          status: r.status,
          headers: {
            "Content-Type": r.headers.get("content-type") || "application/octet-stream",
            "Cache-Control": "max-age=86400"
          }
        });
      } catch {
        return new Response("", { status: 502 });
      }
    }
    const arquivo = path.normalize(path.join(__dirname, rel.replace(/^[/\\]+/, "")));
    if (!arquivo.startsWith(__dirname)) return new Response("", { status: 403 });
    try {
      const dados = await fs.promises.readFile(arquivo);
      return new Response(dados, { headers: { "Content-Type": TIPOS[path.extname(arquivo).toLowerCase()] || "application/octet-stream" } });
    } catch {
      return new Response("", { status: 404 });
    }
  });
}
let janela = null;

const arquivoConfig = () => path.join(app.getPath("userData"), "config.json");

// O config fica em memória: lerConfig() é chamado a cada pedido ao servidor
// (ver liberarConsultaSemLogin) e ler o arquivo toda vez trava a tela quando a
// busca carrega dezenas de fotos.
let configEmMemoria = null;
function lerConfig() {
  if (configEmMemoria) return configEmMemoria;
  try {
    const c = JSON.parse(fs.readFileSync(arquivoConfig(), "utf8"));
    // Instalações antigas guardaram o endereço do painel (porta 3000): passam para o catálogo próprio.
    if (c && String(c.url || "").replace(/\/+$/, "") === URL_ANTIGA) {
      c.url = PADRAO.url;
      try { fs.writeFileSync(arquivoConfig(), JSON.stringify(c, null, 2)); } catch { /* ignora */ }
    }
    configEmMemoria = { ...PADRAO, ...c };
  } catch {
    configEmMemoria = { ...PADRAO };
  }
  return configEmMemoria;
}

function salvarConfig(c) {
  fs.mkdirSync(path.dirname(arquivoConfig()), { recursive: true });
  fs.writeFileSync(arquivoConfig(), JSON.stringify(c, null, 2));
  configEmMemoria = { ...PADRAO, ...c };
}

function urlNormalizada(txt) {
  let u = String(txt || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  new URL(u); // lança erro se inválida
  return u;
}

function carregar() {
  if (!janela) return;
  // Programa próprio: a tela vive dentro do .exe (app/). O servidor só entrega catálogos, produtos e fotos.
  janela.loadURL(`${ESQUEMA}://programa/app/index.html`);
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
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A tela é local (file://) e fala com o servidor da loja (http://): sem isso o navegador bloqueia (CORS).
      // Seguro aqui porque a janela só carrega os arquivos do próprio programa.
      webSecurity: false
    }
  });

  janela.setMenuBarVisibility(false);
  // Evita a janela branca na abertura: só aparece depois da 1ª pintura e força um repaint.
  janela.once("ready-to-show", () => {
    // Preferencia do balcao: abrir sempre em modo janela (F11 alterna tela cheia) e com zoom de 125%.
    janela.webContents.setZoomFactor(1.25);
    janela.show();
    setTimeout(() => { try { janela.webContents.invalidate(); } catch (_) { /* ignora */ } }, 400);
  });
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

  carregar();
}

function pedirEndereco() {
  const atual = lerConfig().url;
  const w = new BrowserWindow({
    parent: janela, modal: true, width: 520, height: 230, resizable: false,
    title: "Endereço do servidor", autoHideMenuBar: true, icon: path.join(__dirname, "icon.png"),
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
    else if (ctrl && i.shift && tecla === "i") { e.preventDefault(); wc.toggleDevTools(); }
    else if (tecla === "f11") { e.preventDefault(); janela.setFullScreen(!janela.isFullScreen()); }
    else if (ctrl && i.shift && tecla === "e") { e.preventDefault(); pedirEndereco(); }
    else if (ctrl && (tecla === "+" || tecla === "=")) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() + 0.5); }
    else if (ctrl && (tecla === "-" || tecla === "_")) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() - 0.5); }
    else if (ctrl && tecla === "0") { e.preventDefault(); wc.setZoomLevel(0); }
  });
}

// ─── Cópia local dos catálogos ─────────────────────────────────────────────────
// <dados do programa>/catalogos/<fabricante>.pdf + .json (versão do servidor).
let pastaCriada = false;
function pastaCatalogosLocais() {
  const d = path.join(app.getPath("userData"), "catalogos");
  if (!pastaCriada) { fs.mkdirSync(d, { recursive: true }); pastaCriada = true; }
  return d;
}
function arquivoCatalogoLocal(chave) {
  const txt = String(chave || "");
  const slug = txt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "catalogo";
  const hash = crypto.createHash("md5").update(txt).digest("hex").slice(0, 6);
  return path.join(pastaCatalogosLocais(), `${slug}-${hash}`);
}
ipcMain.handle("catalogo-local:ler", (_e, chave) => {
  try {
    const base = arquivoCatalogoLocal(chave);
    const meta = JSON.parse(fs.readFileSync(base + ".json", "utf8"));
    const bytes = fs.readFileSync(base + ".pdf");
    if (!bytes.length) return null;
    return { versao: String(meta.versao || ""), bytes: new Uint8Array(bytes) };
  } catch {
    return null;
  }
});
function gravarCatalogoLocal(chave, versao, bytes, nome) {
  try {
    const base = arquivoCatalogoLocal(chave);
    const dados = Buffer.from(bytes);
    if (!dados.length) return false;
    fs.writeFileSync(base + ".pdf.tmp", dados);
    fs.renameSync(base + ".pdf.tmp", base + ".pdf");
    fs.writeFileSync(base + ".json", JSON.stringify({ versao: String(versao || ""), chave: String(chave || ""), nome: String(nome || chave || ""), salvoEm: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}
ipcMain.handle("catalogo-local:apagar", (_e, chave) => {
  try { const b = arquivoCatalogoLocal(chave); fs.rmSync(b + ".pdf", { force: true }); fs.rmSync(b + ".json", { force: true }); return true; } catch { return false; }
});
ipcMain.handle("catalogo-local:salvar", (_e, chave, versao, bytes, nome) => gravarCatalogoLocal(chave, versao, bytes, nome));

// Lista os catálogos salvos (para a tela "servidor fora do ar") e abre no leitor de PDF do Windows.
ipcMain.handle("catalogo-local:listar", () => {
  try {
    const d = pastaCatalogosLocais();
    return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => {
      const id = f.slice(0, -5);
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
        if (!fs.existsSync(path.join(d, id + ".pdf"))) return null;
        return { id, nome: m.nome || id, chave: m.chave || "", salvoEm: m.salvoEm || "" };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  } catch { return []; }
});
ipcMain.handle("catalogo-local:ler-id", (_e, id) => {
  if (!/^[a-z0-9-]+$/.test(String(id || ""))) return null;
  try { return new Uint8Array(fs.readFileSync(path.join(pastaCatalogosLocais(), id + ".pdf"))); } catch { return null; }
});
ipcMain.handle("catalogo-local:abrir", async (_e, id) => {
  if (!/^[a-z0-9-]+$/.test(String(id || ""))) return false;
  const arq = path.join(pastaCatalogosLocais(), id + ".pdf");
  if (!fs.existsSync(arq)) return false;
  return (await shell.openPath(arq)) === "";
});

ipcMain.handle("config:ler", () => lerConfig());
ipcMain.handle("config:salvar", (_e, txt) => {
  try {
    const url = urlNormalizada(txt);
    salvarConfig({ ...lerConfig(), url });
    BrowserWindow.getAllWindows().forEach((w) => { if (w !== janela) w.close(); });
    carregar();
    return { ok: true, url };
  } catch {
    return { ok: false, erro: "Endereço inválido. Exemplo: http://192.168.0.2:3001" };
  }
});
ipcMain.handle("app:recarregar", () => carregar());


// ─── Atualização automática dos catálogos salvos (meia-noite) ──────────────────
// Todo dia por volta de 00:00 (com atraso aleatório de até 20 min, para as máquinas não
// pedirem juntas) o programa compara a versão de cada catálogo com a do servidor e baixa
// só o que faltar ou estiver desatualizado, um por vez. Se o servidor estiver fora do ar,
// tenta de novo a cada 30 min. Se o computador estava desligado à meia-noite, atualiza
// assim que o programa abrir no dia seguinte.
const arquivoSync = () => path.join(app.getPath("userData"), "sync-catalogos.json");
function lerSync() { try { return JSON.parse(fs.readFileSync(arquivoSync(), "utf8")); } catch { return {}; } }
function gravarSync(o) { try { fs.writeFileSync(arquivoSync(), JSON.stringify({ ...lerSync(), ...o })); } catch { /* ignora */ } }
const ultimaMeiaNoite = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const proximaMeiaNoite = () => ultimaMeiaNoite() + 24 * 3600 * 1000 + Math.floor(Math.random() * 20 * 60 * 1000);

let sincronizando = false;
let proximaSync = 0;

function buscarServidor(rota, binario) {
  const alvo = new URL(lerConfig().url + rota);
  const lib = alvo.protocol === "https:" ? require("https") : require("http");
  return new Promise((resolve, reject) => {
    const req = lib.get(alvo, { headers: { "X-Consulta-Catalogo": "1" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); const e = new Error("HTTP " + res.statusCode); e.statusCode = res.statusCode; return reject(e); }
      const partes = [];
      res.on("data", (c) => partes.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(partes);
        if (!binario) { try { return resolve(JSON.parse(buf.toString("utf8"))); } catch (e) { return reject(e); } }
        resolve({ buf, versao: res.headers["x-catalogo-versao"] || "" });
      });
      res.on("error", reject);
    });
    req.setTimeout(binario ? 600000 : 15000, () => req.destroy(new Error("tempo esgotado")));
    req.on("error", reject);
  });
}

async function sincronizarCatalogos() {
  if (sincronizando) return false;
  gravarSync({ iniciouEm: Date.now() });
  sincronizando = true;
  let servidorOk = false;
  let baixados = 0, falhas = 0, vazios = 0;
  try {
    const lista = await buscarServidor("/api/catalogo/fabricantes-completo");
    const versao = String((await buscarServidor("/api/catalogo/pronto-versao")).versao || "");
    servidorOk = true;
    const limite = Number(process.env.CATALOGO_SYNC_LIMITE) || Infinity; // só para testes
    for (const o of (lista.opcoes || []).slice(0, limite)) {
      try {
        const base = arquivoCatalogoLocal(o.value);
        let atual = "";
        try { if (fs.existsSync(base + ".pdf")) atual = String(JSON.parse(fs.readFileSync(base + ".json", "utf8")).versao || ""); } catch { /* refaz */ }
        if (atual && versao && atual === versao) continue;
        const r = await buscarServidor("/api/catalogo/exportar-pdf?fabricante=" + encodeURIComponent(o.value), true);
        if (gravarCatalogoLocal(o.value, r.versao || versao, r.buf, o.label)) baixados++; else falhas++;
      } catch (e) {
        // 404 = o servidor não tem nenhuma peça para este catálogo (sem preço e sem estoque): não é falha.
        // Apaga a cópia antiga, se existir, para não mostrar catálogo desatualizado.
        if (e && e.statusCode === 404) {
          vazios++;
          try { const b = arquivoCatalogoLocal(o.value); fs.rmSync(b + ".pdf", { force: true }); fs.rmSync(b + ".json", { force: true }); } catch { /* ignora */ }
          continue;
        }
        falhas++; gravarSync({ erroItem: o.value + ": " + String((e && e.message) || e) }); }
    }
  } catch (e) { gravarSync({ erro: String((e && e.message) || e), erroEm: Date.now() }); /* servidor fora do ar */ }
  sincronizando = false;
  if (servidorOk) gravarSync({ ultima: Date.now(), baixados, falhas, vazios, erroItem: falhas ? lerSync().erroItem : "" });
  return servidorOk && falhas === 0;
}

function agendarSync() {
  const ult = lerSync().ultima || 0;
  // Primeira instalação (sem histórico): só na próxima meia-noite. Já teve sincronização e perdeu a
  // meia-noite (computador desligado): atualiza logo que o programa abrir.
  proximaSync = !ult || ult >= ultimaMeiaNoite() ? proximaMeiaNoite() : Date.now() + 20000;
  setInterval(async () => {
    if (sincronizando || Date.now() < proximaSync) return;
    const ok = await sincronizarCatalogos();
    proximaSync = ok ? proximaMeiaNoite() : Date.now() + 30 * 60 * 1000;
  }, 60000);
}

// ─── Aviso de nova versão do programa ──────────────────────────────────────────
// Ao abrir (e a cada 6 h) pergunta ao servidor qual a versão mais nova do instalador. Se for maior que
// a deste programa, a tela mostra "Baixar nova versão"; o clique baixa o instalador e já o abre.
let novaVersao = null;
const versaoMaior = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function verificarAtualizacao() {
  try {
    const i = await buscarServidor("/api/catalogo/exe-versao");
    if (i && versaoMaior(i.versao, app.getVersion())) {
      novaVersao = { versao: i.versao, notas: i.notas || "" };
      if (janela && !janela.isDestroyed()) janela.webContents.send("app:nova-versao", novaVersao);
    } else novaVersao = null;
  } catch { /* servidor fora do ar: tenta na próxima */ }
}
ipcMain.handle("app:versao-nova", () => novaVersao);
ipcMain.handle("app:atualizar", async () => {
  try {
    const alvo = new URL(lerConfig().url + "/api/catalogo/exe-download");
    const lib = alvo.protocol === "https:" ? require("https") : require("http");
    const destino = path.join(app.getPath("temp"), "Catalogo Rildon Setup.exe");
    await new Promise((resolve, reject) => {
      const req = lib.get(alvo, { headers: { "X-Consulta-Catalogo": "1" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
        const total = Number(res.headers["content-length"]) || 0; let lido = 0;
        const saida = fs.createWriteStream(destino);
        res.on("data", (c) => { lido += c.length; if (total && janela && !janela.isDestroyed()) janela.webContents.send("app:progresso-atualizacao", Math.round(lido * 100 / total)); });
        res.pipe(saida);
        saida.on("finish", () => saida.close(resolve));
        saida.on("error", reject); res.on("error", reject);
      });
      req.setTimeout(600000, () => req.destroy(new Error("tempo esgotado")));
      req.on("error", reject);
    });
    const erro = await shell.openPath(destino);
    if (erro) return { ok: false, erro };
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (e) { return { ok: false, erro: String((e && e.message) || e) }; }
});
function agendarAtualizacao() { setTimeout(verificarAtualizacao, 8000); setInterval(verificarAtualizacao, 6 * 3600 * 1000); }

// Só uma janela do programa por vez.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); } });
  app.whenReady().then(() => { app.setAppUserModelId("br.com.rildon.catalogo.loja"); servirArquivosDoPrograma(); liberarConsultaSemLogin(); montarMenu(); criarJanela(); agendarSync(); agendarAtualizacao(); });
  app.on("window-all-closed", () => app.quit());
}
