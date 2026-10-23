// Catálogo Rildon (programa da loja) — peças que o programa precisa e que antes vinham do painel.
// Este programa é independente do painel de atendimento: só conversa com o servidor para
// buscar catálogos, produtos e fotos (rotas /api/catalogo/*, somente leitura).
(function () {
  "use strict";
  let BASE = "http://192.168.0.2:3001";
  const fetchOriginal = window.fetch.bind(window);

  window.MODO_CONSULTA_CATALOGO = true;
  // Fotos: passam pelo próprio programa (ver servirArquivosDoPrograma no main.js),
  // senão o servidor as bloqueia por virem de outra origem.
  window.servidorBase = () => (window.catalogoLoja ? "/servidor" : BASE);
  window.servidorOnline = null; // null = ainda verificando

  // Pedidos "/api/..." vão para o servidor da loja.
  // Downloads de PDF em andamento: o servidor fica ocupado gerando o catálogo e demora a responder
  // à checagem — isso não é "servidor desligado".
  let pdfsEmAndamento = 0;
  window.fetch = (entrada, opcoes) => {
    if (typeof entrada === "string" && entrada.startsWith("/api/")) entrada = BASE + entrada;
    if (typeof entrada === "string" && entrada.includes("/exportar-pdf")) {
      pdfsEmAndamento++;
      return fetchOriginal(entrada, opcoes).finally(() => { pdfsEmAndamento--; ultimoOkAgora(); });
    }
    return fetchOriginal(entrada, opcoes);
  };
  let ultimoOkAgora = () => {};

  // Mesma assinatura usada pelo catálogo: timeout e JSON de erro padronizados.
  window.apiFetch = async function (url, opcoes = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Number(opcoes.timeoutMs || 20000));
    try {
      return await fetch(url, { ...opcoes, signal: opcoes.signal || ctl.signal });
    } finally { clearTimeout(t); }
  };

  // ─── Servidor ligado? (verifica de 5 em 5 s, sem sobrepor checagens) ─────────
  // Servidor LENTO não é servidor DESLIGADO. Erro de rede (cabo/endereço inalcançável) vale
  // "sem servidor" após 2 falhas seguidas; só demora (timeout) exige 60 s sem nenhuma resposta.
  let falhasRede = 0;
  let ultimoOk = Date.now();
  ultimoOkAgora = () => { ultimoOk = Date.now(); };
  async function verificar() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    let ok = false, lento = false;
    try { await fetchOriginal(BASE + "/api/catalogo/pronto-versao", { cache: "no-store", signal: ctl.signal }); /* qualquer resposta HTTP = servidor ligado */ ok = true; }
    catch (e) { lento = !!(e && e.name === "AbortError"); window.servidorUltimoErro = (e && (e.name + ": " + e.message)) || "erro"; }
    clearTimeout(t);
    if (ok) { falhasRede = 0; ultimoOk = Date.now(); }
    else if (!lento) falhasRede++;
    let online = window.servidorOnline;
    if (ok) online = true;
    else if (online === null) online = lento; // 1ª checagem: erro de rede = sem servidor; só lento = ligado
    else if (lento ? (pdfsEmAndamento === 0 && Date.now() - ultimoOk > 60000) : falhasRede >= 2) online = false;
    if (online !== window.servidorOnline) {
      const antes = window.servidorOnline;
      window.servidorOnline = online;
      document.documentElement.classList.toggle("servidor-offline", !online);
      document.dispatchEvent(new CustomEvent("servidor-status", { detail: { online, antes } }));
    }
  }
  window.verificarServidor = verificar;

  window.iniciarShim = async function () {
    try {
      const c = await window.catalogoLoja?.lerConfig?.();
      if (c && c.url) BASE = String(c.url).replace(/\/+$/, "");
    } catch (_) { /* usa o padrão */ }
    // Com o servidor respondendo, basta conferir de 20 em 20 s; sem resposta, volta a 5 s
    // para a tela destravar rápido assim que o servidor religar.
    const ciclo = async () => {
      try { await verificar(); } finally { setTimeout(ciclo, window.servidorOnline ? 20000 : 5000); }
    };
    await verificar();
    setTimeout(ciclo, window.servidorOnline ? 20000 : 5000);
  };
})();
