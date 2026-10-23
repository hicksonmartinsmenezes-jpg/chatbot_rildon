// 18-catalogo.js
// Painel "Catálogo de Produtos" (pedido do usuário, 2026-07-21): o atendente
// digita marca/modelo/ano do veículo do cliente (+ categoria opcional) e
// busca no catálogo real (~17.400 produtos, ver catalogo-x2.service.js) sem
// precisar que o cliente já tenha mandado isso numa mensagem de chat.
// Objetivo confirmado com o usuário: só checar SE a peça existe/serve —
// preço e disponibilidade o atendente confere depois no ERP (ver botão de
// copiar código abaixo, que existe justamente pra agilizar essa ponte).

let _catalogoSecoesCarregadas = false;
let _catalogoFabricantesCarregados = false;
// Cache da lista crua de fabricantes (2026-08-26, aba "Catálogo Completo")
// — reusada tanto pelo dropdown de filtro (catalogo-fabricante) quanto pelo
// novo dropdown da aba de exportação completa (catalogo-fabricante-completo),
// pra não duplicar a chamada a /api/catalogo/fabricantes.
let _catalogoFabricantesLista = null;

// BUG REAL corrigido 2026-09-02 (testado ao vivo: trocar a foto principal
// funciona na hora, mas some depois de recarregar a página): não basta
// mandar Cache-Control novo — qualquer navegador que já tinha visto
// /fotos/0 daquele produto ANTES desse fix guardou a resposta em disco com
// a validade antiga (24h) e nunca mais pergunta pro servidor, nem com
// refresh forçado (Ctrl+Shift+R não limpa fotos carregadas via busca, só
// recurso da carga inicial da página). A única forma de garantir um pedido
// novo é a URL em si mudar. _catalogoFotoVersao é buscado uma vez (GET
// /api/catalogo/fotos-versao, ver versaoFotosHandler) e embutido como
// ?v=<versao> em toda URL de foto do painel via _catalogoFotoUrl — trocar
// uma preferência muda a versão no servidor, o que muda a URL na próxima
// renderização, o que força um pedido de verdade não importa o que já
// esteja cacheado.
let _catalogoFotoVersao = null;

(async function _catalogoCarregarFotoVersaoInicial() {
  try {
    const res = await apiFetch("/api/catalogo/fotos-versao");
    if (res.ok) {
      const data = await res.json();
      _catalogoFotoVersao = data.versao ?? null;
    }
  } catch (err) {
    console.warn("[catalogo] falha ao carregar versão de fotos:", err.message);
  }
})();

function _catalogoFotoUrl(codigo, indice = 0) {
  const base = `/api/catalogo/produtos/${encodeURIComponent(codigo)}/fotos/${indice}`;
  return _catalogoFotoVersao !== null ? `${base}?v=${_catalogoFotoVersao}` : base;
}

// Igual _catalogoFotoUrl acima, mas por NOME de arquivo — usada só pra
// miniatura de foto OCULTA no modal "Escolher foto principal" (pedido do
// usuário, 2026-09-02): foto oculta não tem índice estável na lista
// visível, então /fotos/:indice não serve pra ela (ver
// servirFotoPorNomeHandler/catalogo.controller.js).
function _catalogoFotoUrlPorNome(codigo, nomeArquivo) {
  const base = `/api/catalogo/produtos/${encodeURIComponent(codigo)}/fotos/nome/${encodeURIComponent(nomeArquivo)}`;
  return _catalogoFotoVersao !== null ? `${base}?v=${_catalogoFotoVersao}` : base;
}

async function _catalogoBuscarFabricantesLista() {
  if (_catalogoFabricantesLista) return _catalogoFabricantesLista;
  try {
    const res = await apiFetch("/api/catalogo/fabricantes");
    if (!res.ok) return [];
    const data = await res.json();
    _catalogoFabricantesLista = Array.isArray(data.fabricantes) ? data.fabricantes : [];
    return _catalogoFabricantesLista;
  } catch (err) {
    console.warn("[catalogo] falha ao carregar fabricantes:", err.message);
    return [];
  }
}

// Carrega as 26 categorias reais uma única vez, pra popular o dropdown
// "Seção" (estilo "Localização do Produto" do ERP da loja).
async function loadCatalogoSecoes() {
  if (_catalogoSecoesCarregadas) return;
  try {
    const res = await apiFetch("/api/catalogo/secoes");
    if (!res.ok) return;
    const data = await res.json();
    const select = document.getElementById("catalogo-secao");
    if (select && Array.isArray(data.secoes)) {
      select.innerHTML = '<option value="">Todas</option>' +
        data.secoes.map(s => `<option value="${safe(s)}">${safe(s)}</option>`).join("");
    }
    _catalogoSecoesCarregadas = true;
  } catch (err) {
    console.warn("[catalogo] falha ao carregar seções:", err.message);
  }
}

// Carrega o dropdown opcional "Fabricante" (Task #250-253, pedido do usuário
// em 2026-07-23). Fabricante não é campo estruturado no catálogo real — é
// extraído do nome do produto e só entra aqui quem passou de um mínimo de
// ocorrências (ver FABRICANTE_MIN_OCORRENCIAS em catalogo-x2.service.js),
// pra não poluir o dropdown com ruído de parsing.
async function loadCatalogoFabricantes() {
  if (_catalogoFabricantesCarregados) return;
  const fabricantes = await _catalogoBuscarFabricantesLista();
  const select = document.getElementById("catalogo-fabricante");
  if (select && fabricantes.length) {
    select.innerHTML = '<option value="">Todos</option>' +
      fabricantes.map(f => `<option value="${safe(f)}">${safe(f)}</option>`).join("");
  }
  _catalogoFabricantesCarregados = true;
}

// PEDIDO DO USUÁRIO (2026-09-04, referência do concorrente KKI Vendas):
// sugestões (datalist) pro campo "Montadora" — texto livre continua
// funcionando igual antes (a busca no backend não muda), isso só ajuda o
// atendente a acertar a grafia mais rápido. Lista curada com dado real do
// catálogo (ver MARCAS_VEICULO_CONHECIDAS/listarMarcasVeiculoConhecidas em
// catalogo-x2.service.js), não uma lista inventada à parte.
let _catalogoMontadorasCarregadas = false;
async function loadCatalogoMontadoras() {
  if (_catalogoMontadorasCarregadas) return;
  try {
    const res = await apiFetch("/api/catalogo/montadoras");
    if (res.ok) {
      const data = await res.json();
      const lista = Array.isArray(data.montadoras) ? data.montadoras : [];
      const datalist = document.getElementById("catalogo-montadoras-list");
      if (datalist) {
        datalist.innerHTML = lista.map(m => `<option value="${safe(m)}"></option>`).join("");
      }
    }
    _catalogoMontadorasCarregadas = true;
  } catch (err) {
    console.warn("[catalogo] falha ao carregar montadoras:", err.message);
  }
}

// Aba "Catálogo Completo" (pedido do usuário, 2026-08-26): dropdown
// separado, sem opção "Todos" — aqui o atendente precisa escolher UM
// fabricante específico pra gerar o PDF do catálogo inteiro dele, não faz
// sentido "todos os fabricantes" numa exportação só.
//
// 2026-09-03 (pedido do usuário: "temos a divisão de peças cadastradas
// como mecânica para esses catálogos [...] preciso que faça a separação
// das que são elétricas e mecânicas [...] algo como Perfect - Mecânica"):
// esse dropdown passou a usar um endpoint PRÓPRIO
// (/api/catalogo/fabricantes-completo, não mais _catalogoBuscarFabricantesLista
// compartilhado) que devolve "opções" já separadas por tipo quando o
// fabricante tem peça em MECÂNICA e fora dela ao mesmo tempo — o `value`
// de cada <option> vem pronto pra mandar direto pros endpoints de
// contagem/exportação (ver decodificarFabricanteCompleto no backend), o
// frontend só trata como string opaca, igual sempre tratou.
let _catalogoFabricantesCompletoCarregados = false;
let _catalogoFabricantesCompletoOpcoes = null;

async function _catalogoBuscarFabricantesCompletoOpcoes() {
  if (_catalogoFabricantesCompletoOpcoes) return _catalogoFabricantesCompletoOpcoes;
  try {
    const res = await apiFetch("/api/catalogo/fabricantes-completo");
    if (!res.ok) return [];
    const data = await res.json();
    _catalogoFabricantesCompletoOpcoes = Array.isArray(data.opcoes) ? data.opcoes : [];
    return _catalogoFabricantesCompletoOpcoes;
  } catch (err) {
    console.warn("[catalogo] falha ao carregar fabricantes do Catálogo Completo:", err.message);
    return [];
  }
}

async function loadCatalogoFabricantesCompleto() {
  if (_catalogoFabricantesCompletoCarregados) return;
  const opcoes = await _catalogoBuscarFabricantesCompletoOpcoes();
  const select = document.getElementById("catalogo-fabricante-completo");
  if (select && opcoes.length) {
    select.innerHTML = '<option value="">Selecione um fabricante...</option>' +
      opcoes.map(o => `<option value="${safe(o.value)}">${safe(o.label)}</option>`).join("");
  }
  _catalogoFabricantesCompletoCarregados = true;
}

// Dropdown dependente: só habilita "Linha" depois que uma Seção é escolhida
// (mesmo comportamento do ERP da loja que serviu de referência visual).
async function onCatalogoSecaoChange() {
  const secaoEl = document.getElementById("catalogo-secao");
  const linhaEl = document.getElementById("catalogo-linha");
  if (!secaoEl || !linhaEl) return;

  const secao = secaoEl.value;
  if (!secao) {
    linhaEl.innerHTML = '<option value="">Todas</option>';
    linhaEl.disabled = true;
    return;
  }

  linhaEl.disabled = true;
  linhaEl.innerHTML = '<option value="">Carregando...</option>';
  try {
    const res = await apiFetch(`/api/catalogo/linhas?secao=${encodeURIComponent(secao)}`);
    const data = res.ok ? await res.json() : { linhas: [] };
    const linhas = Array.isArray(data.linhas) ? data.linhas : [];
    linhaEl.innerHTML = '<option value="">Todas</option>' +
      linhas.map(l => `<option value="${safe(l)}">${safe(l)}</option>`).join("");
    linhaEl.disabled = false;
  } catch (err) {
    linhaEl.innerHTML = '<option value="">Todas</option>';
    linhaEl.disabled = false;
    console.warn("[catalogo] falha ao carregar linhas:", err.message);
  }
}

// O bundle carrega no fim do <body> (DOM já pronto), mesmo padrão de
// initDateFilters em 13-main.js — liga o listener direto, sem esperar
// DOMContentLoaded.
document.getElementById("catalogo-secao")?.addEventListener("change", onCatalogoSecaoChange);

function _catalogoEmptyState(icon, mensagem, extraClass = "") {
  return `
    <div class="catalogo-empty-state ${extraClass}">
      <i class="fa-solid ${icon}"></i>
      <p>${mensagem}</p>
    </div>
  `;
}

// Botão "Exportar catálogo expresso" (pedido do usuário, 2026-07-28): sai em
// PDF com foto, trazendo TODOS os resultados do filtro atual — não só os que
// estão na tela. Os critérios da busca ficam em wrap.dataset.exportQuery
// (setado logo depois de renderizar o resultado, em buscarCatalogo/
// buscarCatalogoPorCodigo), então o botão não precisa saber a origem.
function _catalogoExportBtnHTML() {
  return `
    <button type="button" class="catalogo-export-btn" onclick="exportarCatalogoPDF(this)">
      <i class="fa-solid fa-file-pdf"></i> Exportar catálogo (PDF)
    </button>
  `;
}

async function exportarCatalogoPDF(btnEl) {
  const wrap = document.getElementById("catalogo-resultados");
  const query = wrap?.dataset.exportQuery || "";
  if (!query) return;

  const original = btnEl?.innerHTML;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando PDF...';
  }

  try {
    const res = await fetch(`/api/catalogo/exportar-pdf?${query}`, { credentials: "include" });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Erro ao gerar PDF do catálogo.");
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `catalogo-expresso-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast?.(err.message || "Erro ao exportar catálogo em PDF.", "error");
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = original;
    }
  }
}

// Aba "Catálogo Completo" (pedido do usuário, 2026-08-26): "aqui eu
// selecionaria qual fabricante queremos o catálogo inteiro e colocamos em
// pdf". Ao trocar o fabricante, mostra quantas peças ele tem ANTES de
// gerar o PDF (reusa GET /api/catalogo/buscar em modo navegação — mesmo
// endpoint do dropdown "Localização do Produto", só com fabricante
// isolado — `total` já vem certo mesmo com o `produtos` array limitado a
// 200 pela API, ver buscarProdutosPainel). Isso evita o atendente clicar
// "gerar PDF" às cegas sem saber se são 10 ou 900 peças.
async function onCatalogoFabricanteCompletoChange() {
  const select = document.getElementById("catalogo-fabricante-completo");
  const contagemEl = document.getElementById("catalogo-completo-contagem");
  const btn = document.getElementById("catalogo-completo-gerar-btn");
  const fabricante = select?.value || "";

  if (!fabricante) {
    contagemEl?.classList.add("hidden");
    if (btn) btn.disabled = true;
    _atualizarPreviewCatalogoCompleto("");
    return;
  }

  if (contagemEl) {
    contagemEl.classList.remove("hidden");
    contagemEl.textContent = "Contando produtos...";
  }
  if (btn) btn.disabled = true;

  try {
    const res = await apiFetch(`/api/catalogo/buscar?fabricante=${encodeURIComponent(fabricante)}`);
    const data = res.ok ? await res.json() : { total: 0 };
    const total = Number(data.total) || 0;
    if (contagemEl) {
      contagemEl.textContent = total
        ? `${total} produto${total === 1 ? "" : "s"} encontrado${total === 1 ? "" : "s"} dessa marca.`
        : "Nenhum produto encontrado pra esse fabricante.";
    }
    if (btn) btn.disabled = total === 0;
    // Issue #22 (pedido do usuário, 2026-08-26): pré-visualização aparece
    // sozinha assim que o fabricante é selecionado — sem esperar clique em
    // "Gerar catálogo completo (PDF)".
    _atualizarPreviewCatalogoCompleto(total > 0 ? fabricante : "");
  } catch (err) {
    if (contagemEl) contagemEl.textContent = "Erro ao contar produtos dessa marca.";
    if (btn) btn.disabled = true;
    console.warn("[catalogo] falha ao contar produtos do fabricante:", err.message);
    _atualizarPreviewCatalogoCompleto("");
  }
}

// Issue #22 (pedido do usuário, 2026-08-26): "preciso que a pré
// visualização de como vai ficar o catalogo no painel de Catalogo Completo
// fique visível embaixo". Reusa o MESMO endpoint /api/catalogo/exportar-pdf
// já usado pelo botão de download (gerarCatalogoCompletoPDF) — a única
// diferença é que aqui o blob vira `src` de um <iframe> em vez de acionar
// um <a download>, então o navegador renderiza o PDF inline (visualizador
// nativo) em vez de baixar o arquivo.
// _catalogoCompletoPreviewUrl guarda a Object URL atual pra poder liberar
// (URL.revokeObjectURL) antes de criar a próxima — sem isso, cada troca de
// fabricante vazaria memória seguindo o blob anterior preso vivo.
let _catalogoCompletoPreviewUrl = null;

// Programa .exe da loja: o 1º clique baixa o catálogo e guarda uma cópia na
// própria máquina; nos cliques seguintes abre a cópia local na hora. Só baixa
// de novo quando o servidor avisa que mudou (versão diferente) — ver
// /api/catalogo/pronto-versao. Sem o programa (navegador comum), baixa sempre.
async function _catalogoPdfComCopiaLocal(fabricante, statusEl) {
  const app = window.catalogoLoja;
  const temCopia = !!(app && app.catalogoLocalLer && app.catalogoLocalSalvar);
  let versaoServidor = null;
  let local = null;
  if (temCopia) {
    try {
      const r = await fetch("/api/catalogo/pronto-versao", { credentials: "include" });
      if (r.ok) versaoServidor = String((await r.json()).versao || "") || null;
    } catch (_) { /* servidor fora do ar: usa a cópia local, se houver */ }
    try { local = await app.catalogoLocalLer(fabricante); } catch (_) { local = null; }
    if (local && local.bytes && (!versaoServidor || local.versao === versaoServidor)) {
      return new Blob([local.bytes], { type: "application/pdf" });
    }
    if (statusEl) statusEl.textContent = "Baixando o catálogo (só na primeira vez ou quando houver atualização)...";
  }
  const res = await fetch(`/api/catalogo/exportar-pdf?fabricante=${encodeURIComponent(fabricante)}`, { credentials: "include" });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || "Erro ao gerar pré-visualização.");
  }
  const buf = await res.arrayBuffer();
  if (temCopia) {
    const versao = res.headers.get("X-Catalogo-Versao") || versaoServidor || "";
    const opt = document.querySelector(`#catalogo-fabricante-completo option[value="${String(fabricante).replace(/"/g, '\\"')}"]`);
    app.catalogoLocalSalvar(fabricante, versao, new Uint8Array(buf), opt ? opt.textContent.trim() : fabricante).catch(() => {});
  }
  return new Blob([buf], { type: "application/pdf" });
}

async function _atualizarPreviewCatalogoCompleto(fabricante) {
  const wrap = document.getElementById("catalogo-completo-preview");
  const frame = document.getElementById("catalogo-completo-preview-frame");
  const statusEl = document.getElementById("catalogo-completo-preview-status");

  if (_catalogoCompletoPreviewUrl) {
    URL.revokeObjectURL(_catalogoCompletoPreviewUrl);
    _catalogoCompletoPreviewUrl = null;
  }

  if (!fabricante) {
    wrap?.classList.add("hidden");
    if (frame) frame.src = "about:blank";
    return;
  }

  wrap?.classList.remove("hidden");
  if (frame) frame.src = "about:blank";
  if (statusEl) {
    statusEl.textContent = "Gerando pré-visualização... (pode levar alguns segundos)";
    statusEl.classList.remove("hidden");
  }

  try {
    const blob = await _catalogoPdfComCopiaLocal(fabricante, statusEl);
    _catalogoCompletoPreviewUrl = URL.createObjectURL(blob);
    if (frame) frame.src = _catalogoCompletoPreviewUrl + (document.documentElement.classList.contains("modo-consulta-catalogo") ? "#navpanes=0&view=Fit" : "");
    if (statusEl) statusEl.classList.add("hidden");
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || "Não foi possível carregar a pré-visualização.";
      statusEl.classList.remove("hidden");
    }
    console.warn("[catalogo] falha ao carregar preview do catálogo completo:", err.message);
  }
}

async function gerarCatalogoCompletoPDF(btnEl) {
  const fabricante = document.getElementById("catalogo-fabricante-completo")?.value || "";
  if (!fabricante) return;

  const original = btnEl?.innerHTML;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando PDF...';
  }

  try {
    const res = await fetch(`/api/catalogo/exportar-pdf?fabricante=${encodeURIComponent(fabricante)}`, { credentials: "include" });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Erro ao gerar PDF do catálogo completo.");
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    // fabricante pode vir como "PERFECT::mecanica" (ver
    // listarFabricantesCatalogoCompleto/decodificarFabricanteCompleto no
    // backend) — troca "::" por "-" só aqui, pro nome do arquivo baixado
    // não sair com caracteres estranhos ("perfect--mecanica" em vez de
    // "perfect::mecanica").
    const nomeArquivo = fabricante.toLowerCase().replace(/::/g, "-").replace(/\s+/g, "-");
    a.download = `catalogo-completo-${nomeArquivo}-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast?.(err.message || "Erro ao gerar catálogo completo em PDF.", "error");
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = original;
    }
  }
}

// Três sub-abas dentro do painel (Task #250-253, + "Busca por Nome" pedida
// pelo usuário em 2026-08-14): "Critérios de Pesquisa" (marca/modelo/ano/
// seção/linha/fabricante), "Busca por Código" (código isolado, sem depender
// de veículo nenhum — cliente às vezes só tem o número gravado na peça
// antiga) e "Busca por Nome" (nome/descrição da peça, quando o cliente só
// sabe dizer o nome). Só uma fica visível por vez, mesmo padrão visual da
// tab strip estilo ERP já usado no painel.
function _catalogoEsconderTodasAbas() {
  document.getElementById("catalogo-tab-veiculo")?.classList.remove("active");
  document.getElementById("catalogo-tab-codigo")?.classList.remove("active");
  document.getElementById("catalogo-tab-nome")?.classList.remove("active");
  document.getElementById("catalogo-tab-completo")?.classList.remove("active");
  document.getElementById("catalogo-tab-promocional")?.classList.remove("active");
  document.getElementById("catalogo-form")?.classList.add("hidden");
  document.getElementById("catalogo-form-codigo")?.classList.add("hidden");
  document.getElementById("catalogo-form-nome")?.classList.add("hidden");
  document.getElementById("catalogo-form-completo")?.classList.add("hidden");
  document.getElementById("catalogo-form-promocional")?.classList.add("hidden");
  document.getElementById("catalogo-hint-veiculo")?.classList.add("hidden");
  document.getElementById("catalogo-hint-codigo")?.classList.add("hidden");
  document.getElementById("catalogo-hint-nome")?.classList.add("hidden");
}

function catalogoMostrarAbaVeiculo() {
  _catalogoEsconderTodasAbas();
  document.getElementById("catalogo-tab-veiculo")?.classList.add("active");
  document.getElementById("catalogo-form")?.classList.remove("hidden");
  document.getElementById("catalogo-hint-veiculo")?.classList.remove("hidden");
  document.getElementById("catalogo-resultados")?.classList.remove("hidden");
}

function catalogoMostrarAbaCodigo() {
  _catalogoEsconderTodasAbas();
  document.getElementById("catalogo-tab-codigo")?.classList.add("active");
  document.getElementById("catalogo-form-codigo")?.classList.remove("hidden");
  document.getElementById("catalogo-hint-codigo")?.classList.remove("hidden");
  document.getElementById("catalogo-codigo-busca")?.focus();
  document.getElementById("catalogo-resultados")?.classList.remove("hidden");
}

function catalogoMostrarAbaNome() {
  _catalogoEsconderTodasAbas();
  document.getElementById("catalogo-tab-nome")?.classList.add("active");
  document.getElementById("catalogo-form-nome")?.classList.remove("hidden");
  document.getElementById("catalogo-hint-nome")?.classList.remove("hidden");
  document.getElementById("catalogo-nome-busca")?.focus();
  document.getElementById("catalogo-resultados")?.classList.remove("hidden");
}

// Aba "Catálogo Completo" (pedido do usuário, 2026-08-26): não usa a grid
// de resultados (#catalogo-resultados) — é só um dropdown de Fabricante +
// botão de gerar o PDF do catálogo inteiro dele, então a área de resultados
// fica escondida enquanto essa aba está ativa.
function catalogoMostrarAbaCompleto() {
  _catalogoEsconderTodasAbas();
  document.getElementById("catalogo-tab-completo")?.classList.add("active");
  document.getElementById("catalogo-form-completo")?.classList.remove("hidden");
  document.getElementById("catalogo-resultados")?.classList.add("hidden");
  loadCatalogoFabricantesCompleto();
}

// Aba "Catálogo Promocional" (nova função, pedido do usuário 2026-08-29):
// mesmo padrão da aba Catálogo Completo — não usa a grid de resultados
// compartilhada (#catalogo-resultados), tem sua própria mini-busca+lista de
// selecionados dentro do próprio formulário.
function catalogoMostrarAbaPromocional() {
  _catalogoEsconderTodasAbas();
  document.getElementById("catalogo-tab-promocional")?.classList.add("active");
  document.getElementById("catalogo-form-promocional")?.classList.remove("hidden");
  document.getElementById("catalogo-resultados")?.classList.add("hidden");
  document.getElementById("catalogo-promo-busca")?.focus();
}

// Limpa os campos do formulário e volta o painel de resultados pro estado
// inicial — atalho pra começar uma nova busca do zero (pedido de UX).
function limparCatalogoForm() {
  ["catalogo-marca", "catalogo-modelo", "catalogo-ano-inicio", "catalogo-ano-fim", "catalogo-motor"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  const secaoEl = document.getElementById("catalogo-secao");
  if (secaoEl) secaoEl.value = "";
  const linhaEl = document.getElementById("catalogo-linha");
  if (linhaEl) {
    linhaEl.innerHTML = '<option value="">Todas</option>';
    linhaEl.disabled = true;
  }
  const fabricanteEl = document.getElementById("catalogo-fabricante");
  if (fabricanteEl) fabricanteEl.value = "";

  const wrap = document.getElementById("catalogo-resultados");
  if (wrap) {
    wrap.innerHTML = _catalogoEmptyState("fa-magnifying-glass-chart", "Preencha montadora/modelo pra buscar por veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo.");
  }
  document.getElementById("catalogo-marca")?.focus();
}

// Limpa só a aba de busca por código (aba separada, resultado independente).
function limparCatalogoFormCodigo() {
  const el = document.getElementById("catalogo-codigo-busca");
  if (el) el.value = "";

  const wrap = document.getElementById("catalogo-resultados");
  if (wrap) {
    wrap.innerHTML = _catalogoEmptyState("fa-barcode", "Informe o código de fabricante, referência ou código interno da peça.");
  }
  el?.focus();
}

// Limpa só a aba de busca por nome (aba separada, resultado independente).
function limparCatalogoFormNome() {
  const el = document.getElementById("catalogo-nome-busca");
  if (el) el.value = "";

  const wrap = document.getElementById("catalogo-resultados");
  if (wrap) {
    wrap.innerHTML = _catalogoEmptyState("fa-font", "Informe o nome ou parte do nome da peça (ex: correia dentada, alternador).");
  }
  el?.focus();
}

// Copia o código do produto pro clipboard — é a ponte direta pro próximo
// passo do atendente (conferir preço/estoque no ERP com esse código).
// Fallback pra quando navigator.clipboard não existe/falha — é o caso do
// painel rodando em HTTP puro no IP da rede local (não é localhost nem
// HTTPS), onde todo navegador bloqueia a Clipboard API por ser contexto
// não seguro. document.execCommand("copy") é deprecated mas ainda
// funciona em qualquer contexto, então serve de rede de segurança aqui.
function _copiarTextoFallback(texto) {
  const textarea = document.createElement("textarea");
  textarea.value = texto;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, texto.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

async function copiarCodigoCatalogo(codigo, btnEl) {
  const texto = String(codigo);
  let copiado = false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(texto);
      copiado = true;
    } catch (err) {
      copiado = false; // cai pro fallback abaixo (contexto não seguro, permissão negada, etc.)
    }
  }

  if (!copiado) copiado = _copiarTextoFallback(texto);

  if (!copiado) {
    showToast?.("Não foi possível copiar o código.", "error");
    return;
  }

  showToast?.(`Código ${codigo} copiado`, "success");
  if (btnEl) {
    const original = btnEl.innerHTML;
    btnEl.classList.add("catalogo-copy-btn-done");
    btnEl.innerHTML = '<i class="fa-solid fa-check"></i> Copiado';
    setTimeout(() => {
      btnEl.classList.remove("catalogo-copy-btn-done");
      btnEl.innerHTML = original;
    }, 1400);
  }
}

// Pedido do usuário (2026-07-30): clicar no nome de um produto equivalente
// (dentro do card com foto) deve abrir esse produto direto, sem precisar
// pesquisar de novo manualmente. Reaproveita a aba "Busca por Código" já
// existente (buscarCatalogoPorCodigo), só preenchendo o campo e disparando
// a busca pelo código interno do produto encontrado. Depois de encontrado,
// já abre o modal de detalhe desse produto (2026-09-04: antes abria o
// painel "Ver referências" inline, que deixou de existir — ver
// abrirModalDetalheProduto) — sem isso o usuário chegava no produto sem
// nenhum contexto extra, precisando clicar de novo pra continuar navegando
// pela cadeia de equivalentes.
async function catalogoAbrirProdutoEquivalente(codigo) {
  catalogoMostrarAbaCodigo();
  const input = document.getElementById("catalogo-codigo-busca");
  if (input) input.value = codigo;
  await buscarCatalogoPorCodigo();

  const wrap = document.getElementById("catalogo-resultados");
  wrap?.scrollIntoView({ behavior: "smooth", block: "start" });

  abrirModalDetalheProduto(codigo);
}

// ─── Modal de detalhe do produto (pedido do usuário, 2026-09-04, referência
// direta do concorrente KKI Vendas) ────────────────────────────────────────
// Clicar em qualquer parte do card abre esse modal com as mesmas 3 abas do
// site de referência: Aplicação / Produtos Similares / Especificação
// Técnica. Substitui os 3 controles que existiam soltos no card (toggle de
// texto de aplicação, botão "Ver aplicação em tabela", "Ver referências") —
// decisão do usuário: card fica limpo, tudo concentrado aqui agora.

// Tabela "Produtos Similares" — reaproveita o mesmo dado de equivalentes já
// indexado no backend (equivalentesDetalhados, ver _detalharEquivalentes em
// catalogo-x2.service.js). Só tem Código/Cód. Fornecedor porque é o que esse
// dado carrega hoje — o catálogo real não tem fabricante/estoque/preço por
// equivalente como o KKI mostra (dado que não existe na base). Coluna
// Descrição removida a pedido do usuário (2026-09-04).
function _catalogoSimilaresTabelaHTML(produto) {
  const equivalentes = Array.isArray(produto.equivalentes) ? produto.equivalentes : [];
  const detalhes = Array.isArray(produto.equivalentesDetalhados) && produto.equivalentesDetalhados.length
    ? produto.equivalentesDetalhados
    : equivalentes.map(codigo => ({ codigo, produto: null }));

  if (!detalhes.length) {
    return '<p class="catalogo-aplicacao-tabela-vazio">Nenhum produto similar cadastrado pra essa peça.</p>';
  }

  const linhasHTML = detalhes.map(det => {
    if (det.produto) {
      return `
        <tr class="catalogo-modal-similar-linha" onclick="catalogoAbrirProdutoEquivalente('${escapeAttr(det.produto.codigo)}')" title="Abrir esse produto">
          <td><strong>${safe(det.produto.codigo)}</strong></td>
          <td>${det.produto.referencia ? safe(det.produto.referencia) : "—"}</td>
        </tr>
      `;
    }
    return `
      <tr>
        <td>${safe(det.codigo)}</td>
        <td class="catalogo-modal-similar-nao-cadastrado">Não vendido pela loja</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="catalogo-aplicacao-tabela">
      <thead><tr><th>Código</th><th>Cód. Fornecedor</th></tr></thead>
      <tbody>${linhasHTML}</tbody>
    </table>
  `;
}

// Troca de aba dentro do modal de detalhe — mesmo padrão simples de
// toggle usado no resto do arquivo, sem nenhuma lib de tabs.
function catalogoModalTrocarAba(btnEl, aba) {
  const container = btnEl.closest(".catalogo-modal-tabs");
  if (!container) return;
  container.querySelectorAll(".catalogo-modal-tab-btn").forEach(b => b.classList.toggle("active", b === btnEl));
  container.querySelectorAll(".catalogo-modal-tab-panel").forEach(p => p.classList.toggle("hidden", p.dataset.aba !== aba));
}

// Campo "Pesquisar..." de cada aba (igual ao KKI) — filtro client-side puro
// por texto visível da linha, sem chamada nenhuma (os dados já estão todos
// no DOM da aba).
function _catalogoModalFiltrarTabela(inputEl) {
  const panel = inputEl.closest(".catalogo-modal-tab-panel");
  const termo = inputEl.value.trim().toLowerCase();
  panel?.querySelectorAll("tbody tr").forEach(row => {
    row.classList.toggle("hidden", termo !== "" && !row.textContent.toLowerCase().includes(termo));
  });
}

// Abre o modal de detalhe — recebe só o código porque o produto completo já
// está em memória (ver _catalogoIndexarProdutos, chamado toda vez que um
// resultado de busca é renderizado), sem precisar de chamada nova ao
// backend nem duplicar o objeto inteiro em atributos data-* do card.
function abrirModalDetalheProduto(codigo) {
  const produto = _catalogoProdutosPorCodigo.get(String(codigo));
  if (!produto) {
    showToast?.("Não foi possível abrir os detalhes desse produto.", "error");
    return;
  }

  const aplicacaoTexto = produto.aplicacaoOrganizada || produto.aplicacao || "";

  const badges = [];
  if (produto.anoCompativel) badges.push('<span class="catalogo-badge catalogo-badge-ano"><i class="fa-solid fa-check"></i> Ano compatível</span>');

  _openModal(`
    <div class="modal-header">
      <strong>${safe(produto.nome)}</strong>
      <button class="modal-close-btn" type="button" data-modal-close aria-label="Fechar modal">&times;</button>
    </div>
    <div class="modal-body catalogo-modal-detalhe">
      <div class="catalogo-modal-info">
        <div class="catalogo-modal-photo" data-foto-codigo="${escapeAttr(produto.codigo)}">
          <i class="fa-solid fa-image catalogo-card-photo-fallback"></i>
          <span class="catalogo-modal-photo-legenda hidden">Sem foto cadastrada</span>
          <!-- BUG REAL corrigido 2026-09-04 (usuário reportou 'a foto tá baixada e
               aparece certinho no card, mas no modal não aparece nada' — testado com
               produto 126630, foto confirmada existir e renderizar no card): SEM
               loading=lazy aqui de propósito. _openModal() (15-modal.js) faz
               overlay.innerHTML = ... (cria esta img com o ancestral
               #_global-modal-overlay ainda display:none) e só DEPOIS adiciona a
               classe que muda pra display:flex. Carregamento nativo 'lazy' de
               imagem inserida num ancestral escondido nunca dispara o fetch nesse
               momento — e como o modal não tem scroll nem outro evento de layout
               que reavalie depois, a imagem fica pra sempre sem carregar, mesmo com
               o arquivo existindo e a MESMA URL funcionando perfeitamente no card
               (fora do modal, sempre visível). Lazy loading não faz sentido aqui
               mesmo: o modal mostra 1 foto só, sob demanda — sem a lista de 200+
               cards que justifica adiar o carregamento na grade. -->
          <img
            src="${_catalogoFotoUrl(produto.codigo)}"
            alt="${safe(produto.nome)}"
            onerror="this.remove(); this.parentElement.querySelector('.catalogo-modal-photo-legenda')?.classList.remove('hidden');"
            onclick="window.open(this.currentSrc || this.src, '_blank');"
            title="Clique pra abrir a foto em outra página"
          >
          <button
            type="button"
            class="catalogo-card-photo-trocar"
            title="Essa não é a foto certa? Trocar foto principal"
            onclick="abrirSeletorFotoCatalogo('${escapeAttr(produto.codigo)}');"
          >
            <i class="fa-solid fa-arrows-rotate"></i> Trocar foto
          </button>
        </div>

        <div class="catalogo-modal-info-identidade">
          <button
            type="button"
            class="catalogo-copy-btn"
            title="Copiar código pra conferir no ERP"
            onclick="copiarCodigoCatalogo('${escapeAttr(produto.codigo)}', this)"
          >
            <i class="fa-regular fa-copy"></i> ${safe(produto.codigo)}
          </button>
          ${produto.referencia ? `<span class="catalogo-card-ref">Ref: ${safe(produto.referencia)}</span>` : ""}
          ${produto.fabricante ? `<span class="catalogo-card-fabricante"><i class="fa-solid fa-industry"></i> ${safe(produto.fabricante)}</span>` : ""}
          <div class="catalogo-modal-secao-row">
            <span class="catalogo-modal-secao">${safe(produto.secao || "")}${produto.linha ? " · " + safe(produto.linha) : ""}</span>
            <!-- Editar categoria (pedido do usuário, 2026-09-05 — achado real:
                 M02051/M02038 cadastrados como "AMPERÍMETRO" em vez de
                 "MANÔMETRO DO ÓLEO"): corrige só a Linha, sem editar dentro do
                 PDF (o PDF é gerado, não editável) — ver
                 abrirEditorCategoriaCatalogo/definirLinhaProduto. -->
            <button
              type="button"
              class="catalogo-modal-editar-categoria-btn"
              title="Linha errada? Corrigir Seção/Linha desse produto"
              onclick="abrirEditorCategoriaCatalogo('${escapeAttr(produto.codigo)}')"
            >
              <i class="fa-solid fa-pen"></i>
            </button>
          </div>
        </div>

        <div class="catalogo-modal-info-comercial">
          ${badges.length ? `<div class="catalogo-card-badges">${badges.join("")}</div>` : ""}
          ${_catalogoEstoqueHTML(produto.estoque)}
        </div>
      </div>

      <div class="catalogo-modal-tabs">
        <div class="catalogo-modal-tab-strip">
          <button type="button" class="catalogo-modal-tab-btn active" onclick="catalogoModalTrocarAba(this, 'aplicacao')">Aplicação</button>
          <button type="button" class="catalogo-modal-tab-btn" onclick="catalogoModalTrocarAba(this, 'similares')">Produtos Similares</button>
          <button type="button" class="catalogo-modal-tab-btn" onclick="catalogoModalTrocarAba(this, 'especificacao')">Especificação Técnica</button>
        </div>

        <div class="catalogo-modal-tab-panel" data-aba="aplicacao">
          ${aplicacaoTexto
            ? `<p class="catalogo-modal-aplicacao-texto">${safe(aplicacaoTexto)}</p>`
            : '<p class="catalogo-aplicacao-tabela-vazio">Nenhuma aplicação cadastrada pra esse produto.</p>'}
        </div>

        <div class="catalogo-modal-tab-panel hidden" data-aba="similares">
          <div class="catalogo-modal-tab-busca">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="text" placeholder="Pesquisar..." oninput="_catalogoModalFiltrarTabela(this)">
          </div>
          ${_catalogoSimilaresTabelaHTML(produto)}
        </div>

        <div class="catalogo-modal-tab-panel hidden" data-aba="especificacao">
          ${produto.dadosTecnicos
            ? `<p class="catalogo-modal-aplicacao-texto">${safe(produto.dadosTecnicos)}</p>`
            : '<p class="catalogo-aplicacao-tabela-vazio">Sem dados técnicos cadastrados pra essa peça.</p>'}
        </div>
      </div>
    </div>
  `);

  // O modal padrão nasce estreito (pensado pra confirm/prompt, ver
  // 15-modal.js) — esse aqui tem 2 colunas + tabela, precisa de bem mais espaço.
  const box = document.querySelector("#_global-modal-overlay ._modal-box");
  if (box) box.style.width = "min(920px, 96vw)";
}

// ─── Editor de categoria (Seção/Linha) — pedido do usuário, 2026-09-05 ────
// Achado real durante uma revisão: M02051/M02038 (Manômetro do óleo, X2)
// apareciam agrupados sob a Linha "AMPERÍMETRO" no Catálogo Completo. Em vez
// de "editar dentro do PDF" (o PDF é gerado a partir do JSON, não é editável
// diretamente — expliquei isso ao usuário antes de implementar), essa tela
// corrige a Linha na origem dos dados via overlay não-destrutivo (mesmo
// padrão de fotos-preferencias.json — ver definirLinhaProduto/
// catalogo-x2.service.js): nunca mexe no JSON bruto do X2, só sobrepõe na
// leitura, e sobrevive a um re-sync do X2 (que só ACRESCENTA produto novo,
// nunca corrige um já existente).
async function abrirEditorCategoriaCatalogo(codigo) {
  const produto = _catalogoProdutosPorCodigo.get(String(codigo));
  if (!produto) {
    showToast?.("Não foi possível abrir o editor de categoria.", "error");
    return;
  }

  let secoes = [];
  try {
    const res = await fetch("/api/catalogo/categoria-linhas", { credentials: "include" });
    if (!res.ok) throw new Error("Erro ao carregar a lista de Seções/Linhas.");
    const data = await res.json();
    secoes = data.secoes || [];
  } catch (err) {
    showToast?.(err.message || "Erro ao carregar a lista de Seções/Linhas.", "error");
    return;
  }

  const secaoAtual = produto.secao || "";
  const linhaAtual = produto.linha || "";
  // Datalist com as Linhas já cadastradas na MESMA Seção do produto — texto
  // livre continua aceito (ex: Linha nova, ou nome de Linha escrito
  // diferente do X2), evita só digitar errado uma Linha que já existe.
  const linhasDaSecao = (secoes.find(s => s.secao === secaoAtual)?.linhas) || [];

  _openModal(`
    <div class="modal-header">
      <strong>Corrigir Seção/Linha</strong>
      <button class="modal-close-btn" type="button" data-modal-close aria-label="Fechar modal">&times;</button>
    </div>
    <div class="modal-body">
      <p style="margin-bottom:12px;">
        Corrige só a Linha desse produto aqui no painel — não altera nada no X2. Use quando
        o produto aparece agrupado na Linha errada (ex: "AMPERÍMETRO" em vez de
        "MANÔMETRO DO ÓLEO"). Fica salvo e sobrevive a uma nova sincronização do catálogo.
      </p>
      <label class="catalogo-editor-categoria-label">
        Seção
        <input type="text" value="${escapeAttr(secaoAtual)}" disabled>
      </label>
      <label class="catalogo-editor-categoria-label">
        Linha correta
        <input
          type="text"
          id="catalogo-editor-categoria-linha"
          list="catalogo-editor-categoria-linhas-lista"
          value="${escapeAttr(linhaAtual)}"
          placeholder="Ex: MANÔMETRO DO ÓLEO"
          autocomplete="off"
        >
        <datalist id="catalogo-editor-categoria-linhas-lista">
          ${linhasDaSecao.map(l => `<option value="${escapeAttr(l)}"></option>`).join("")}
        </datalist>
      </label>
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" type="button" data-modal-close>Cancelar</button>
      <button class="modal-btn modal-btn-primary" type="button" id="catalogo-editor-categoria-salvar">Salvar</button>
    </div>
  `);

  document.getElementById("catalogo-editor-categoria-salvar")?.addEventListener("click", () => {
    const novaLinha = document.getElementById("catalogo-editor-categoria-linha")?.value.trim() || "";
    _salvarCategoriaCatalogo(codigo, novaLinha);
  });
}

async function _salvarCategoriaCatalogo(codigo, novaLinha) {
  if (!novaLinha) {
    showToast?.("Informe a Linha correta (não pode ficar em branco).", "error");
    return;
  }
  const btn = document.getElementById("catalogo-editor-categoria-salvar");
  if (btn) { btn.disabled = true; btn.textContent = "Salvando..."; }
  try {
    const res = await fetch(`/api/catalogo/produtos/${encodeURIComponent(codigo)}/linha`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linha: novaLinha }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Erro ao corrigir a categoria.");

    // Atualiza só o campo `linha` do produto em memória (o resto do objeto —
    // aplicação, estoque, badges já calculados — continua o mesmo; o backend
    // devolve o produto "cru" indexado, não o formato "de painel" usado na
    // busca) — reabre o modal de detalhe já com o valor novo.
    const produtoAtualizado = body.produto;
    if (produtoAtualizado?.codigo) {
      const atual = _catalogoProdutosPorCodigo.get(String(produtoAtualizado.codigo));
      if (atual) atual.linha = produtoAtualizado.linha;
    }

    _closeModal();
    showToast?.("Linha corrigida. O card na lista de busca atualiza numa próxima busca/recarregar.", "success");
    abrirModalDetalheProduto(codigo);
  } catch (err) {
    showToast?.(err.message || "Erro ao corrigir a categoria.", "error");
    if (btn) { btn.disabled = false; btn.textContent = "Salvar"; }
  }
}

// mostrarBadgeNeutro: só faz sentido quando a busca envolveu marca/modelo
// (aí sim vale avisar "confirme com o cliente" quando nada bateu). No modo
// navegação (só Seção/Linha, sem veículo informado) não tem comparação
// nenhuma sendo feita — mostrar o aviso em toda peça listada seria ruído.
// PEDIDO DO USUÁRIO (2026-08-07): "Estoque ao vivo no Catálogo/orçamento" —
// produto.estoque vem null quando o produto não tem dado do Relatório de
// Estoque do X2 — nesse caso não mostra nada (sem dado ≠ zero produtos,
// não dá pra afirmar "sem estoque" sem saber). Cobertura real (export de
// 2026-09-05): 17.569 produtos, 100% com preço — o "~2/3 sem dado" citado
// aqui antes vinha de um export truncado por bug (fixado 2026-08-10) que
// ninguém tinha revalidado ainda; hoje é bem perto do catálogo inteiro,
// mas continua sendo um export do dia, pode variar.
function _formatarPrecoBRL(valor) {
  if (valor === null || valor === undefined) return null;
  return "R$ " + Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _catalogoEstoqueHTML(estoque) {
  if (!estoque) return "";
  const qtd = Number(estoque.qtd) || 0;
  const temEstoque = qtd > 0;
  const badgeClasse = temEstoque ? "catalogo-badge-estoque-ok" : "catalogo-badge-estoque-zero";
  const badgeIcone = temEstoque ? "fa-solid fa-check" : "fa-solid fa-triangle-exclamation";
  const badgeTexto = temEstoque
    ? `${qtd % 1 === 0 ? qtd : qtd.toFixed(2)} em estoque`
    : "Sem estoque";
  const precoVarejo = _formatarPrecoBRL(estoque.precoVarejo);
  const precoAtacado = _formatarPrecoBRL(estoque.precoAtacado);

  // Reorganizado (pedido do usuário, 2026-08-13): antes preço era um texto
  // corrido pequeno e cinza, disputando espaço com o badge de estoque na
  // mesma linha (quebrava de forma inconsistente conforme o tamanho dos
  // números). Agora vira um bloco próprio, com rótulo + valor em linhas
  // separadas e valor em destaque — o badge de estoque continua do lado,
  // mas cada um tem seu espaço.
  const precoLinhas = [
    precoVarejo ? `<div class="catalogo-preco-linha"><span class="catalogo-preco-label">Varejo</span><strong class="catalogo-preco-valor">${precoVarejo}</strong></div>` : "",
    precoAtacado ? `<div class="catalogo-preco-linha"><span class="catalogo-preco-label">Atacado</span><strong class="catalogo-preco-valor">${precoAtacado}</strong></div>` : "",
  ].join("");

  return `
    <div class="catalogo-card-estoque">
      <span class="catalogo-badge ${badgeClasse}"><i class="${badgeIcone}"></i> ${badgeTexto}</span>
      ${precoLinhas ? `<div class="catalogo-card-precos">${precoLinhas}</div>` : ""}
    </div>
  `;
}

// Índice em memória do último(s) conjunto(s) de resultados renderizados —
// pedido do usuário (2026-09-04): clicar no card abre um modal com o
// produto inteiro (aplicação/similares/especificação), então precisamos
// achar o objeto completo de volta a partir só do código (o card não carrega
// o produto inteiro em atributos data-*, custaria caro pra produtos com
// aplicação/equivalentes grandes). Guarda por código normalizado da API —
// cada nova busca reindexada por cima, não cresce sem limite.
let _catalogoProdutosPorCodigo = new Map();

function _catalogoIndexarProdutos(produtos) {
  (produtos || []).forEach(p => { if (p?.codigo) _catalogoProdutosPorCodigo.set(String(p.codigo), p); });
}

// Seleção manual de itens (pedido do usuário, 2026-09-10): "Critérios de
// Pesquisa" (e as abas Código/Nome, que compartilham o mesmo grid
// #catalogo-resultados) só tinham o botão "Exportar catálogo (PDF)" — que
// sempre exporta TODOS os resultados do filtro (ver exportarCatalogoPDF
// acima). Não existia jeito de marcar só ALGUNS itens da busca e exportar
// só esses, igual já era possível na aba "Catálogo Promocional" (busca +
// "Adicionar" um por um). Em vez de duplicar aquele fluxo, este bloco
// reusa o MESMO endpoint do backend (POST /api/catalogo/promocional/
// exportar-pdf, ver exportarPdfPromocionalHandler/catalogo.controller.js)
// passando só a lista de códigos marcados — sem CSV de preço (opcional lá),
// então sai como um catálogo comum, sem selo de preço promocional.
//
// _catalogoSelecaoManual é módulo-level de propósito (não por-busca): marcar
// um item na aba Código e depois trocar pra Critérios de Pesquisa (ou pra
// página 2 dos resultados) não perde a seleção — o atendente pode ir
// combinando itens de buscas diferentes antes de exportar, mesmo padrão de
// "carrinho" que _catalogoPromoSelecionados já usa na aba Promocional.
let _catalogoSelecaoManual = new Set();

function _catalogoBarraSelecaoManualHTML() {
  const n = _catalogoSelecaoManual.size;
  return `
    <div class="catalogo-selecao-bar${n ? "" : " catalogo-selecao-bar--vazia"}">
      <span class="catalogo-selecao-contagem">
        <i class="fa-solid fa-square-check"></i> ${n} selecionado${n === 1 ? "" : "s"}
      </span>
      <div class="catalogo-selecao-acoes">
        <button type="button" class="catalogo-selecao-limpar-btn" onclick="_catalogoLimparSelecaoManual()" ${n ? "" : "disabled"}>
          Limpar seleção
        </button>
        <button type="button" class="catalogo-selecao-export-btn" onclick="_catalogoExportarSelecionadosManual(this)" ${n ? "" : "disabled"}>
          <i class="fa-solid fa-file-pdf"></i> Exportar selecionados (PDF)
        </button>
      </div>
    </div>
  `;
}

// Só atualiza os nós já na tela (contagem + botões) — evita re-renderizar o
// grid inteiro (e perder scroll/estado das fotos) a cada clique de checkbox.
function _catalogoAtualizarBarraSelecaoManual() {
  const n = _catalogoSelecaoManual.size;
  document.querySelectorAll(".catalogo-selecao-bar").forEach(bar => {
    bar.classList.toggle("catalogo-selecao-bar--vazia", n === 0);
    const contagem = bar.querySelector(".catalogo-selecao-contagem");
    if (contagem) contagem.innerHTML = `<i class="fa-solid fa-square-check"></i> ${n} selecionado${n === 1 ? "" : "s"}`;
    const limparBtn = bar.querySelector(".catalogo-selecao-limpar-btn");
    if (limparBtn) limparBtn.disabled = n === 0;
    const exportBtn = bar.querySelector(".catalogo-selecao-export-btn");
    if (exportBtn) exportBtn.disabled = n === 0;
  });
}

function _catalogoToggleSelecaoManual(codigo, marcado) {
  if (marcado) _catalogoSelecaoManual.add(String(codigo));
  else _catalogoSelecaoManual.delete(String(codigo));
  _catalogoAtualizarBarraSelecaoManual();
}

function _catalogoLimparSelecaoManual() {
  _catalogoSelecaoManual.clear();
  document.querySelectorAll(".catalogo-card-select:checked").forEach(cb => { cb.checked = false; });
  _catalogoAtualizarBarraSelecaoManual();
}

async function _catalogoExportarSelecionadosManual(btnEl) {
  const codigos = [..._catalogoSelecaoManual];
  if (!codigos.length) return;

  const original = btnEl?.innerHTML;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando PDF...';
  }

  try {
    // Pedido do usuário (2026-09-19, melhoria "unificar layout"): antes
    // reusava /api/catalogo/promocional/exportar-pdf só porque já resolvia
    // uma lista de códigos soltos — só que aquele endpoint desenha com o
    // cabeçalho/rodapé PRÓPRIOS do Catálogo Promocional (redesign de
    // 2026-08-31), diferentes da arte do Catálogo Completo. Rota dedicada
    // (ver exportarPdfSelecionadosHandler/catalogo.controller.js) gera com
    // o MESMO layout do Catálogo Completo — o usuário pediu que a única
    // diferença entre os modos continuasse sendo "quais produtos entram",
    // não o design. Sem upload de CSV aqui, então body JSON simples em vez
    // de FormData/multipart.
    const res = await fetch("/api/catalogo/exportar-selecionados-pdf", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigos }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Erro ao gerar PDF dos itens selecionados.");
    }

    const naoEncontrados = res.headers.get("X-Catalogo-Codigos-Nao-Encontrados");
    if (naoEncontrados) {
      showToast?.(`Alguns itens selecionados não foram encontrados e ficaram de fora do PDF: ${naoEncontrados}`, "warning");
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `catalogo-selecionados-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast?.(err.message || "Erro ao exportar os itens selecionados em PDF.", "error");
  } finally {
    if (btnEl) {
      btnEl.disabled = _catalogoSelecaoManual.size === 0;
      btnEl.innerHTML = original;
    }
  }
}

function _catalogoCardHTML(produto, mostrarBadgeNeutro) {
  const badges = [];
  if (produto.anoCompativel) {
    badges.push('<span class="catalogo-badge catalogo-badge-ano"><i class="fa-solid fa-check"></i> Ano compatível</span>');
  }
  if (mostrarBadgeNeutro && !produto.marcaCompativel && !produto.anoCompativel) {
    badges.push('<span class="catalogo-badge catalogo-badge-neutro"><i class="fa-solid fa-circle-info"></i> Confirme ano/marca com o cliente</span>');
  }

  // Card enxuto (pedido do usuário, 2026-09-04, referência KKI Vendas):
  // aplicação/similares/especificação saíram do card e foram pro modal de
  // detalhe (clique em qualquer parte do card abre — ver
  // abrirModalDetalheProduto). Foto/trocar-foto/copiar-código continuam com
  // stopPropagation pra não abrir o modal por engano num clique que já tem
  // ação própria.
  // Checkbox de seleção manual (pedido do usuário, 2026-09-10, ver
  // _catalogoSelecaoManual acima) — sempre visível (ao contrário do botão
  // "Trocar foto", que só aparece no hover), porque o atendente precisa
  // conseguir ver de relance quais itens já marcou rolando a lista.
  // stopPropagation nos dois níveis (label E input) porque o card inteiro é
  // clicável (abre o modal de detalhe) — sem isso, marcar o checkbox também
  // abriria o modal por cima.
  const marcado = _catalogoSelecaoManual.has(String(produto.codigo));
  const checkboxHTML = `
    <label class="catalogo-card-select-wrap" onclick="event.stopPropagation()" title="Marcar pra exportar junto com outros itens selecionados">
      <input
        type="checkbox"
        class="catalogo-card-select"
        data-codigo-select="${escapeAttr(produto.codigo)}"
        ${marcado ? "checked" : ""}
        onclick="event.stopPropagation()"
        onchange="_catalogoToggleSelecaoManual('${produto.codigo}', this.checked)"
      >
      <span class="catalogo-card-select-box"><i class="fa-solid fa-check"></i></span>
    </label>
  `;

  return `
    <article class="catalogo-card" onclick="abrirModalDetalheProduto('${escapeAttr(produto.codigo)}')" title="Ver detalhes desse produto">
      <div class="catalogo-card-photo${produto.duasFotos ? " catalogo-card-photo--dupla" : ""}" data-foto-codigo="${escapeAttr(produto.codigo)}">
        ${checkboxHTML}
        <i class="fa-solid fa-image catalogo-card-photo-fallback"></i>
        <img
          src="${_catalogoFotoUrl(produto.codigo, 0)}"
          alt="${safe(produto.nome)}"
          loading="lazy"
          onerror="this.remove();"
          onclick="event.stopPropagation(); window.open(this.currentSrc || this.src, '_blank');"
          title="Clique pra abrir a foto em outra página"
        >
        ${produto.duasFotos ? `
        <img
          src="${_catalogoFotoUrl(produto.codigo, 1)}"
          alt="${safe(produto.nome)}"
          loading="lazy"
          onerror="this.remove();"
          onclick="event.stopPropagation(); window.open(this.currentSrc || this.src, '_blank');"
          title="Clique pra abrir a foto em outra página"
        >` : ""}
        <button
          type="button"
          class="catalogo-card-photo-trocar"
          title="Essa não é a foto certa? Trocar foto principal"
          onclick="event.stopPropagation(); abrirSeletorFotoCatalogo('${produto.codigo}');"
        >
          <i class="fa-solid fa-arrows-rotate"></i> Trocar foto
        </button>
      </div>
      <div class="catalogo-card-body">
        <div class="catalogo-card-head">
          <span class="catalogo-card-secao">${safe(produto.secao)}${produto.linha ? " · " + safe(produto.linha) : ""}</span>
          <button
            type="button"
            class="catalogo-copy-btn"
            title="Copiar código pra conferir no ERP"
            onclick="event.stopPropagation(); copiarCodigoCatalogo('${produto.codigo}', this)"
          >
            <i class="fa-regular fa-copy"></i> ${safe(produto.codigo)}
          </button>
        </div>

        <h4 class="catalogo-card-nome">${safe(produto.nome)}</h4>
        ${produto.referencia ? `<span class="catalogo-card-ref">Ref: ${safe(produto.referencia)}</span>` : ""}
        ${produto.fabricante ? `<span class="catalogo-card-fabricante"><i class="fa-solid fa-industry"></i> ${safe(produto.fabricante)}</span>` : ""}

        <div class="catalogo-card-badges">${badges.join("")}</div>
        ${_catalogoEstoqueHTML(produto.estoque)}
      </div>
    </article>
  `;
}

// Pedido do usuário (2026-09-02): quando a foto que aparece em 1º lugar é
// uma ficha técnica/desenho em vez da foto real do produto (a ordenação
// automática por tamanho de arquivo não distingue quando as duas vêm na
// mesma resolução — ver catalogo-fotos.service.js), o atendente escolhe
// manualmente qual das fotos cadastradas do produto é a principal, direto
// no card de busca. Reusa o modal genérico (_openModal/15-modal.js).
async function abrirSeletorFotoCatalogo(codigo) {
  let data;
  try {
    // incluirOcultas=1: esse modal é o único lugar do painel que precisa
    // ver as fotos OCULTAS também (pra dar pra restaurar, ver
    // ocultarFotoHandler/catalogo.controller.js) — card e PDF nunca pedem
    // isso, só veem as visíveis.
    const res = await fetch(`/api/catalogo/produtos/${encodeURIComponent(codigo)}/fotos?incluirOcultas=1`, { credentials: "include" });
    if (!res.ok) throw new Error("Erro ao carregar fotos do produto.");
    data = await res.json();
  } catch (err) {
    showToast?.(err.message || "Erro ao carregar fotos do produto.", "error");
    return;
  }

  // 2026-09-08 (pedido do usuário: "criar possibilidade de adicionar
  // foto"): modal agora abre mesmo com 1 foto só (ou nenhuma) — antes
  // bloqueava com um toast, mas "adicionar uma 2ª foto" é exatamente o
  // caso de produto com 1 foto só. O tile "Adicionar foto" (sempre
  // presente) é o motivo de abrir mesmo sem nada pra trocar ainda.
  const fotos = data.fotos || [];
  const grade = fotos.map(f => f.oculta ? _catalogoFotoOpcaoOcultaHTML(codigo, f) : _catalogoFotoOpcaoHTML(codigo, f)).join("") + _catalogoFotoOpcaoAdicionarHTML();

  _openModal(`
    <div class="modal-header">
      <strong>Fotos do produto</strong>
      <button class="modal-close-btn" type="button" data-modal-close aria-label="Fechar modal">&times;</button>
    </div>
    <div class="modal-body">
      <p style="margin-bottom:12px;">Clique na foto certa pra usar como principal, no ícone de lixeira pra ocultar uma foto errada (não apaga do X2 — dá pra restaurar depois), ou em "Adicionar foto" pra enviar uma foto do seu computador.</p>
      <div class="catalogo-foto-opcoes-grid">${grade}</div>
      <input type="file" accept="image/jpeg,image/png" class="catalogo-foto-upload-input" style="display:none;">
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" type="button" data-modal-close>Fechar</button>
    </div>
  `);

  document.querySelectorAll(".catalogo-foto-opcao-escolher").forEach(btn => {
    btn.addEventListener("click", () => _definirFotoPreferidaCatalogo(codigo, btn.dataset.nomeArquivo));
  });
  document.querySelectorAll(".catalogo-foto-opcao-ocultar").forEach(btn => {
    btn.addEventListener("click", () => _ocultarFotoCatalogo(codigo, btn.dataset.nomeArquivo, true));
  });
  document.querySelectorAll(".catalogo-foto-opcao-restaurar").forEach(btn => {
    btn.addEventListener("click", () => _ocultarFotoCatalogo(codigo, btn.dataset.nomeArquivo, false));
  });

  const inputUpload = document.querySelector(".catalogo-foto-upload-input");
  document.querySelector(".catalogo-foto-opcao-adicionar")?.addEventListener("click", () => inputUpload?.click());
  inputUpload?.addEventListener("change", () => {
    const file = inputUpload.files?.[0];
    if (file) _adicionarFotoCatalogo(codigo, file);
  });

  // BUG REAL corrigido 2026-09-02 (usuário reportou "não vejo fotos
  // cadastradas quando vou trocar" — reproduzido ao vivo): toda <img
  // loading="lazy"> no painel nasce com opacity:0 (ver 19-motion.css) e só
  // fica visível quando o JS adiciona a classe .is-loaded, via
  // bindLazyImageFade (01-utils.js) — a grade de busca normal chama isso
  // depois de renderizar (buscarCatalogo/buscarCatalogoPorCodigo), mas essa
  // chamada faltava aqui. As fotos carregavam plenamente (confirmado via
  // canvas: bytes e pixels corretos) só que ficavam brancas pra sempre.
  bindLazyImageFade(document.getElementById("_global-modal-overlay"));
}

function _catalogoFotoOpcaoHTML(codigo, f) {
  return `
    <div class="catalogo-foto-opcao ${f.indice === 0 ? "catalogo-foto-opcao-atual" : ""}">
      <button
        type="button"
        class="catalogo-foto-opcao-escolher"
        data-nome-arquivo="${escapeAttr(f.nomeArquivo)}"
        title="${f.indice === 0 ? "Foto atual" : "Usar essa como foto principal"}"
      >
        <img src="${_catalogoFotoUrl(codigo, f.indice)}" alt="Opção de foto ${f.indice + 1}" loading="lazy">
        ${f.indice === 0 ? '<span class="catalogo-foto-opcao-badge">Atual</span>' : ""}
      </button>
      <button
        type="button"
        class="catalogo-foto-opcao-ocultar"
        data-nome-arquivo="${escapeAttr(f.nomeArquivo)}"
        title="Ocultar essa foto (não aparece mais pro cliente nem no PDF)"
      >
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;
}

function _catalogoFotoOpcaoOcultaHTML(codigo, f) {
  return `
    <div class="catalogo-foto-opcao catalogo-foto-opcao-oculta" title="Foto oculta — não aparece pro cliente nem no PDF">
      <img src="${_catalogoFotoUrlPorNome(codigo, f.nomeArquivo)}" alt="Foto oculta" loading="lazy">
      <span class="catalogo-foto-opcao-badge catalogo-foto-opcao-badge-oculta">Oculta</span>
      <button
        type="button"
        class="catalogo-foto-opcao-restaurar"
        data-nome-arquivo="${escapeAttr(f.nomeArquivo)}"
        title="Restaurar essa foto"
      >
        <i class="fa-solid fa-rotate-left"></i>
      </button>
    </div>
  `;
}

// Tile "Adicionar foto" (2026-09-08) — sempre o último item da grade.
// Clicar dispara o <input type="file"> escondido (ver
// abrirSeletorFotoCatalogo); a foto escolhida vai pra _adicionarFotoCatalogo.
function _catalogoFotoOpcaoAdicionarHTML() {
  return `
    <button type="button" class="catalogo-foto-opcao catalogo-foto-opcao-adicionar" title="Enviar uma foto do seu computador">
      <i class="fa-solid fa-plus"></i>
      <span>Adicionar foto</span>
    </button>
  `;
}

// Card na grade de busca pode estar mostrando fotos desatualizadas depois
// de trocar/ocultar/adicionar — reusado pelas 3 ações (2026-09-08: antes
// cada uma tinha seu próprio forEach setando TODAS as <img> do card pro
// MESMO índice 0, o que quebrava o layout de 2 fotos lado a lado — ver
// .catalogo-card-photo--dupla — sobrescrevendo a 2ª foto com a 1ª. Agora
// cada <img> dentro do card recebe o índice da SUA posição entre os
// irmãos, certo tanto pra card de 1 foto quanto de 2.
function _catalogoAtualizarFotosCard(codigo) {
  document.querySelectorAll(`.catalogo-card-photo[data-foto-codigo="${CSS.escape(String(codigo))}"]`).forEach(wrap => {
    wrap.querySelectorAll("img").forEach((img, i) => {
      img.src = _catalogoFotoUrl(codigo, i);
    });
  });
}

// Ocultar é uma ação que muda o que o cliente vê — pede confirmação (modal
// genérico, ver 15-modal.js). Restaurar é reversível na hora e sem
// consequência pro cliente, não precisa confirmar.
function _ocultarFotoCatalogo(codigo, nomeArquivo, oculta) {
  if (!oculta) {
    _executarOcultarFotoCatalogo(codigo, nomeArquivo, false);
    return;
  }
  showConfirmModal({
    title: "Ocultar foto",
    message: "Essa foto deixa de aparecer no card, pro cliente e no PDF do catálogo. Não apaga nada do X2 — dá pra restaurar depois. Confirma?",
    confirmText: "Ocultar",
    danger: true,
    onConfirm: () => _executarOcultarFotoCatalogo(codigo, nomeArquivo, true),
  });
}

async function _executarOcultarFotoCatalogo(codigo, nomeArquivo, oculta) {
  try {
    const res = await fetch(`/api/catalogo/produtos/${encodeURIComponent(codigo)}/foto-ocultar`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nomeArquivo, oculta }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Erro ao ocultar foto.");

    showToast?.(oculta ? "Foto ocultada." : "Foto restaurada.", "success");
    if (body.versao !== undefined) _catalogoFotoVersao = body.versao;
    _catalogoAtualizarFotosCard(codigo);
  } catch (err) {
    showToast?.(err.message || "Erro ao ocultar foto.", "error");
  } finally {
    // Reabre o modal já com o estado real vindo do servidor — funciona
    // tanto no sucesso (foto migrou de seção visível<->oculta) quanto no
    // erro (ex: última foto visível — o modal volta do jeito que estava,
    // sem fingir que a ação deu certo).
    abrirSeletorFotoCatalogo(codigo);
  }
}

async function _definirFotoPreferidaCatalogo(codigo, nomeArquivo) {
  try {
    const res = await fetch(`/api/catalogo/produtos/${encodeURIComponent(codigo)}/foto-preferida`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nomeArquivo }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Erro ao trocar a foto.");

    _closeModal();
    showToast?.("Foto principal atualizada.", "success");

    // Atualiza a versão local com a que o servidor acabou de gerar (ver
    // _catalogoFotoVersao/_catalogoFotoUrl no topo do arquivo) — troca a URL
    // de TODA foto do painel a partir de agora, não só desse produto, o que
    // garante que nenhuma renderização futura na sessão reuse cache velho,
    // nem daquela mesma foto vista antes desse fix existir.
    if (body.versao !== undefined) _catalogoFotoVersao = body.versao;
    _catalogoAtualizarFotosCard(codigo);
  } catch (err) {
    showToast?.(err.message || "Erro ao trocar a foto.", "error");
  }
}

// 2026-09-08 (pedido do usuário: "criar possibilidade de adicionar foto") —
// envia o arquivo escolhido no <input type="file"> do modal via multipart.
// Decisão do usuário: a foto enviada só ENTRA na lista (não vira principal
// sozinha) — por isso não fecha o modal nem mexe em preferência aqui, só
// reabre o seletor já com a foto nova disponível pra escolher depois.
async function _adicionarFotoCatalogo(codigo, file) {
  try {
    const formData = new FormData();
    formData.append("foto", file);
    const res = await fetch(`/api/catalogo/produtos/${encodeURIComponent(codigo)}/fotos/upload`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Erro ao adicionar foto.");

    showToast?.("Foto adicionada. Escolha uma foto pra usar como principal, se quiser.", "success");
    if (body.versao !== undefined) _catalogoFotoVersao = body.versao;
    _catalogoAtualizarFotosCard(codigo);
  } catch (err) {
    showToast?.(err.message || "Erro ao adicionar foto.", "error");
  } finally {
    // Reabre o modal com o estado real do servidor — mesmo padrão de
    // _executarOcultarFotoCatalogo acima.
    abrirSeletorFotoCatalogo(codigo);
  }
}

async function buscarCatalogo(event) {
  if (event) event.preventDefault();
  const searchBtn = event?.target?.querySelector?.(".catalogo-erp-search-btn");
  setButtonBusy(searchBtn, true, "Buscando...");

  const marca      = document.getElementById("catalogo-marca")?.value.trim()      || "";
  const modelo     = document.getElementById("catalogo-modelo")?.value.trim()     || "";
  // PEDIDO DO USUÁRIO (2026-09-04, referência KKI Vendas): campo único "Ano"
  // virou "Ano Inicial"/"Ano Final" (faixa) + campo novo "Motor".
  const anoInicio  = document.getElementById("catalogo-ano-inicio")?.value.trim() || "";
  const anoFim     = document.getElementById("catalogo-ano-fim")?.value.trim()    || "";
  const motor      = document.getElementById("catalogo-motor")?.value.trim()      || "";

  // Linha (mais específica) tem prioridade sobre Seção quando ambas estão
  // preenchidas — o backend aceita um único parâmetro "categoria" e casa
  // contra seção OU linha (ver catalogo-x2.service.buscarProdutosPainel).
  const secao      = document.getElementById("catalogo-secao")?.value  || "";
  const linha      = document.getElementById("catalogo-linha")?.value  || "";
  const categoria  = linha || secao;
  const fabricante = document.getElementById("catalogo-fabricante")?.value || "";

  const wrap = document.getElementById("catalogo-resultados");
  if (!wrap) { setButtonBusy(searchBtn, false); return; }

  try {

  // Modo navegação (pedido do usuário, 2026-07-22, estendido em 2026-07-23
  // pra fabricante): sem marca/modelo, uma Seção/Linha e/ou Fabricante já
  // bastam pra listar o catálogo inteiro daquele filtro — inclusive peças
  // sem texto de aplicação/veículo (ex: abraçadeira, parafuso), que a busca
  // por veículo abaixo nunca alcançaria.
  if (!marca && !modelo && !categoria && !fabricante) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe montadora/modelo do veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo.", "catalogo-warn-state");
    return;
  }

  // Pedido do usuário (2026-07-31): Modelo é o único campo que o backend usa
  // pra FILTRAR de verdade uma busca por veículo (Montadora só ranqueia
  // depois — ver comentário em buscarProdutosPainel, catalogo-x2.service.js).
  // Buscar só por Montadora (ex: "Ford", sem Modelo) faz a mesma busca ampla
  // contra TODO o texto de aplicação, só que sem nem o Modelo pra restringir
  // — ainda mais resultado solto. Por isso, sempre que Montadora/Ano/Motor
  // forem usados (ou seja, é uma busca por veículo, não navegação por Seção/
  // Fabricante), exige Modelo preenchido também.
  if ((marca || anoInicio || anoFim || motor) && !modelo) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe o Modelo pra buscar por veículo — Montadora/Ano/Motor sozinhos trazem resultado amplo demais.", "catalogo-warn-state");
    return;
  }
  if (anoInicio && anoFim && Number(anoInicio) > Number(anoFim)) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Ano inicial não pode ser maior que o ano final.", "catalogo-warn-state");
    return;
  }

  const modoNavegacao = !marca && !modelo; // só categoria/fabricante — não é busca por veículo

  const params = new URLSearchParams();
  if (marca)      params.set("marca", marca);
  if (modelo)     params.set("modelo", modelo);
  if (anoInicio)  params.set("anoInicio", anoInicio);
  if (anoFim)     params.set("anoFim", anoFim);
  if (motor)      params.set("motor", motor);
  if (categoria)  params.set("categoria", categoria);
  if (fabricante) params.set("fabricante", fabricante);

  await _catalogoExecutarBusca(wrap, params, modoNavegacao);

  } finally {
    setButtonBusy(searchBtn, false);
  }
}

// Pedido do usuário (2026-09-02): "Critérios de Pesquisa" cortava em 200
// sem jeito de ver o resto do resultado. Extraído de dentro de
// buscarCatalogo pra ser reusado tanto pela 1ª busca (sempre página 1,
// implícito — sem "pagina" na URL o backend assume 1) quanto pelos botões
// Anterior/Próxima (_catalogoIrParaPagina abaixo), que só trocam o número
// da página sem o usuário precisar preencher o formulário de novo.
async function _catalogoExecutarBusca(wrap, params, modoNavegacao) {
  wrap.innerHTML = renderSkeletonGrid(8);

  const marca      = params.get("marca") || "";
  const modelo     = params.get("modelo") || "";
  const anoInicio  = params.get("anoInicio") || "";
  const anoFim     = params.get("anoFim") || "";
  const motor      = params.get("motor") || "";
  const categoria  = params.get("categoria") || "";
  const fabricante = params.get("fabricante") || "";

  try {
    const res = await apiFetch(`/api/catalogo/buscar?${params.toString()}`);

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", safe(errBody.error || "Erro ao buscar peças."), "catalogo-error-state");
      return;
    }

    const data = await res.json();
    const produtos = data.produtos || [];

    // Chips mostrando os critérios usados nessa busca — ajuda a lembrar o
    // que foi filtrado ao rolar uma lista longa de resultados.
    const chips = [];
    if (marca)      chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-flag"></i> ${safe(marca)}</span>`);
    if (modelo)     chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-car"></i> ${safe(modelo)}</span>`);
    if (anoInicio || anoFim) {
      const faixaAno = anoInicio && anoFim && anoInicio !== anoFim ? `${anoInicio} – ${anoFim}` : (anoInicio || anoFim);
      chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-calendar-day"></i> ${safe(faixaAno)}</span>`);
    }
    if (motor)      chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-gears"></i> ${safe(motor)}</span>`);
    if (categoria)  chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-table-cells"></i> ${safe(categoria)}</span>`);
    if (fabricante) chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-industry"></i> ${safe(fabricante)}</span>`);
    const chipsHTML = chips.length ? `<div class="catalogo-chips">${chips.join("")}</div>` : "";

    if (!produtos.length) {
      wrap.innerHTML = `${chipsHTML}${_catalogoEmptyState("fa-box-open", "Nenhuma peça encontrada pra esses critérios.")}`;
      return;
    }

    // Paginação de verdade (antes só cortava em 200 sem avisar como ver o
    // resto): total sempre reflete a contagem real, limite/pagina vêm do
    // backend (ver buscarProdutosHandler, LIMITE_PAGINA_PAINEL=400).
    const limite = data.limite || produtos.length;
    const paginaAtual = data.pagina || 1;
    const totalPaginas = Math.max(1, Math.ceil(data.total / limite));

    const totalTexto = `${data.total} peça${data.total === 1 ? "" : "s"} encontrada${data.total === 1 ? "" : "s"}`;
    const recorte = totalPaginas > 1 ? ` — página ${paginaAtual} de ${totalPaginas}` : "";

    const resumoBar = `
      <div class="catalogo-resumo-bar">
        <p class="catalogo-resumo">${totalTexto}${recorte}.</p>
        ${_catalogoExportBtnHTML()}
      </div>
      ${_catalogoBarraSelecaoManualHTML()}
    `;
    _catalogoIndexarProdutos(produtos);
    const grid = `<div class="catalogo-grid">${produtos.map(p => _catalogoCardHTML(p, !modoNavegacao)).join("")}</div>`;
    const pagerHTML = totalPaginas > 1 ? _catalogoPagerHTML(paginaAtual, totalPaginas) : "";
    wrap.innerHTML = resumoBar + grid + pagerHTML;
    // Guarda os critérios desta busca (SEM "pagina") pro botão de exportar
    // (pedido do usuário, 2026-07-28) — exporta TODOS os resultados do
    // filtro, não só a página mostrada na tela (ver MAX_EXPORT_PDF no
    // backend) — e pro pager reconstruir a URL de outra página sem precisar
    // reler o formulário (que pode ter mudado desde essa busca).
    wrap.dataset.exportQuery = params.toString();
    wrap.dataset.modoNavegacao = modoNavegacao ? "1" : "";
    applyStaggerIn(wrap.querySelector(".catalogo-grid"));
    bindLazyImageFade(wrap);
  } catch (err) {
    wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", "Erro ao buscar peças. Tente novamente.", "catalogo-error-state");
  }
}

function _catalogoPagerHTML(paginaAtual, totalPaginas) {
  return `
    <div class="catalogo-pager">
      <button type="button" class="catalogo-pager-btn" ${paginaAtual <= 1 ? "disabled" : ""} onclick="_catalogoIrParaPagina(${paginaAtual - 1})">
        <i class="fa-solid fa-chevron-left"></i> Anterior
      </button>
      <span class="catalogo-pager-info">Página ${paginaAtual} de ${totalPaginas}</span>
      <button type="button" class="catalogo-pager-btn" ${paginaAtual >= totalPaginas ? "disabled" : ""} onclick="_catalogoIrParaPagina(${paginaAtual + 1})">
        Próxima <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>
  `;
}

async function _catalogoIrParaPagina(pagina) {
  const wrap = document.getElementById("catalogo-resultados");
  if (!wrap || !wrap.dataset.exportQuery) return;
  const params = new URLSearchParams(wrap.dataset.exportQuery);
  params.set("pagina", pagina);
  await _catalogoExecutarBusca(wrap, params, wrap.dataset.modoNavegacao === "1");
  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Busca isolada por código de fabricante/referência/código interno (Task
// #250-253, pedido do usuário em 2026-07-23) — aba separada de "Critérios de
// Pesquisa" porque é um modo de busca diferente: exato, sem ranking nem
// badges de marca/ano (não faz sentido comparar contra veículo nenhum aqui).
async function buscarCatalogoPorCodigo(event) {
  if (event) event.preventDefault();
  const searchBtn = event?.target?.querySelector?.(".catalogo-erp-search-btn");
  setButtonBusy(searchBtn, true, "Buscando...");

  const codigo = document.getElementById("catalogo-codigo-busca")?.value.trim() || "";
  const wrap = document.getElementById("catalogo-resultados");
  if (!wrap) { setButtonBusy(searchBtn, false); return; }

  try {

  if (!codigo) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe o código de fabricante, referência ou código interno da peça.", "catalogo-warn-state");
    return;
  }

  wrap.innerHTML = renderSkeletonGrid(8);

  try {
    const res = await apiFetch(`/api/catalogo/buscar-codigo?codigo=${encodeURIComponent(codigo)}`);

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", safe(errBody.error || "Erro ao buscar peça."), "catalogo-error-state");
      return;
    }

    const data = await res.json();
    const produtos = data.produtos || [];
    const chipsHTML = `<div class="catalogo-chips"><span class="catalogo-chip"><i class="fa-solid fa-barcode"></i> ${safe(codigo)}</span></div>`;

    if (!produtos.length) {
      wrap.innerHTML = `${chipsHTML}${_catalogoEmptyState("fa-box-open", "Nenhuma peça encontrada com esse código.")}`;
      return;
    }

    const totalTexto = `${data.total} peça${data.total === 1 ? "" : "s"} encontrada${data.total === 1 ? "" : "s"}`;
    const resumoBar = `
      <div class="catalogo-resumo-bar">
        ${chipsHTML}
        <p class="catalogo-resumo">${totalTexto}.</p>
        ${_catalogoExportBtnHTML()}
      </div>
      ${_catalogoBarraSelecaoManualHTML()}
    `;
    // mostrarBadgeNeutro=false: busca por código é exata, não tem
    // marca/ano pra comparar — o aviso "confirme com o cliente" não se aplica.
    _catalogoIndexarProdutos(produtos);
    const grid = `<div class="catalogo-grid">${produtos.map(p => _catalogoCardHTML(p, false)).join("")}</div>`;
    wrap.innerHTML = resumoBar + grid;
    wrap.dataset.exportQuery = `codigo=${encodeURIComponent(codigo)}`;
    applyStaggerIn(wrap.querySelector(".catalogo-grid"));
    bindLazyImageFade(wrap);
  } catch (err) {
    wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", "Erro ao buscar peça. Tente novamente.", "catalogo-error-state");
  }

  } finally {
    setButtonBusy(searchBtn, false);
  }
}

// Busca isolada por nome/descrição da peça (pedido do usuário, 2026-08-14:
// "gostaria que no meu painel de catálogo também tivesse opção de pesquisar
// por peça nome") — aba separada, mesmo padrão de buscarCatalogoPorCodigo:
// exata quanto à intenção do atendente, sem ranking de marca/ano (não há
// veículo pra comparar aqui).
async function buscarCatalogoPorNome(event) {
  if (event) event.preventDefault();
  const searchBtn = event?.target?.querySelector?.(".catalogo-erp-search-btn");
  setButtonBusy(searchBtn, true, "Buscando...");

  const nome = document.getElementById("catalogo-nome-busca")?.value.trim() || "";
  const wrap = document.getElementById("catalogo-resultados");
  if (!wrap) { setButtonBusy(searchBtn, false); return; }

  try {

  if (!nome) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe o nome ou parte do nome da peça.", "catalogo-warn-state");
    return;
  }

  wrap.innerHTML = renderSkeletonGrid(8);

  try {
    const res = await apiFetch(`/api/catalogo/buscar-nome?nome=${encodeURIComponent(nome)}`);

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", safe(errBody.error || "Erro ao buscar peça."), "catalogo-error-state");
      return;
    }

    const data = await res.json();
    const produtos = data.produtos || [];
    const chipsHTML = `<div class="catalogo-chips"><span class="catalogo-chip"><i class="fa-solid fa-font"></i> ${safe(nome)}</span></div>`;

    if (!produtos.length) {
      wrap.innerHTML = `${chipsHTML}${_catalogoEmptyState("fa-box-open", "Nenhuma peça encontrada com esse nome.")}`;
      return;
    }

    const totalTexto = `${data.total} peça${data.total === 1 ? "" : "s"} encontrada${data.total === 1 ? "" : "s"}`;
    const recorte = data.total > produtos.length ? ` — mostrando as ${produtos.length} mais relevantes` : "";
    const resumoBar = `
      <div class="catalogo-resumo-bar">
        ${chipsHTML}
        <p class="catalogo-resumo">${totalTexto}${recorte}.</p>
        ${_catalogoExportBtnHTML()}
      </div>
      ${_catalogoBarraSelecaoManualHTML()}
    `;
    // mostrarBadgeNeutro=false: busca por nome não tem marca/ano pra
    // comparar — o aviso "confirme com o cliente" não se aplica.
    _catalogoIndexarProdutos(produtos);
    const grid = `<div class="catalogo-grid">${produtos.map(p => _catalogoCardHTML(p, false)).join("")}</div>`;
    wrap.innerHTML = resumoBar + grid;
    wrap.dataset.exportQuery = `nome=${encodeURIComponent(nome)}`;
    applyStaggerIn(wrap.querySelector(".catalogo-grid"));
    bindLazyImageFade(wrap);
  } catch (err) {
    wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", "Erro ao buscar peça. Tente novamente.", "catalogo-error-state");
  }

  } finally {
    setButtonBusy(searchBtn, false);
  }
}

// ─── Aba "Catálogo Promocional" (nova função, pedido do usuário 2026-08-29) ───
// "farei uma nova aba dentro de catalogos de produto, crie Catalogo
// Promocional onde terá a mesma funcionalidade de catalogo completo, porém
// farei lista selecionada de produtos, não precisa subcategorizar, deixa
// como antes e na parte superior direita iremos deixar um espaço para
// preços" — o atendente busca produtos (nome ou código, reusando os mesmos
// endpoints já existentes /catalogo/buscar-codigo e /catalogo/buscar-nome),
// clica "Adicionar" nos que quer, monta a lista manualmente, opcionalmente
// sobe um CSV de preços (código,preço) e gera o PDF via
// POST /api/catalogo/promocional/exportar-pdf.
//
// _catalogoPromoSelecionados: Map código -> {codigo, nome, secao, linha} —
// só os campos usados pra render da lista/lookup, não o produto inteiro
// (nem precisa: o backend resolve o produto de novo a partir do código na
// hora de gerar o PDF, é só a UI que precisa lembrar nome/seção pra mostrar
// a lista).
let _catalogoPromoSelecionados = new Map();
// Cache do ÚLTIMO resultado de busca (código -> produto) — os botões
// "Adicionar" dos resultados chamam catalogoPromoAdicionar(codigo) só com o
// código (mais simples que colocar nome/seção inteiros num atributo HTML
// com aspas/acentos); a função busca os dados completos aqui.
let _catalogoPromoUltimaBusca = new Map();

function _catalogoPromoResultadoHTML(produto) {
  const jaSelecionado = _catalogoPromoSelecionados.has(String(produto.codigo));
  return `
    <div class="catalogo-promo-resultado-item">
      <div class="catalogo-promo-resultado-info">
        <strong>${safe(produto.codigo)}</strong> — ${safe(produto.nome)}
        <span class="catalogo-promo-resultado-meta">${safe(produto.secao || "")}${produto.linha ? " · " + safe(produto.linha) : ""}</span>
      </div>
      <button
        type="button"
        class="catalogo-promo-add-btn"
        ${jaSelecionado ? "disabled" : ""}
        onclick="catalogoPromoAdicionar('${escapeAttr(produto.codigo)}')"
      >
        <i class="fa-solid ${jaSelecionado ? "fa-check" : "fa-plus"}"></i> ${jaSelecionado ? "Adicionado" : "Adicionar"}
      </button>
    </div>
  `;
}

// Busca única (nome OU código): tenta código exato primeiro (mais rápido/
// direto quando o atendente já sabe o número), cai pra busca por nome se
// não achar nada — evita obrigar o atendente a escolher o tipo de busca
// numa aba que já é só um passo intermediário (montar a lista), não o foco
// principal da tela.
async function catalogoPromoBuscar(event) {
  if (event) event.preventDefault();
  const termo = document.getElementById("catalogo-promo-busca")?.value.trim() || "";
  const wrap = document.getElementById("catalogo-promo-resultados");
  if (!wrap) return;

  if (!termo) {
    wrap.innerHTML = "";
    return;
  }

  wrap.innerHTML = `<p class="catalogo-promo-buscando"><i class="fa-solid fa-spinner fa-spin"></i> Buscando...</p>`;

  try {
    let produtos = [];
    const resCodigo = await apiFetch(`/api/catalogo/buscar-codigo?codigo=${encodeURIComponent(termo)}`);
    if (resCodigo.ok) {
      const data = await resCodigo.json();
      produtos = data.produtos || [];
    }
    if (!produtos.length) {
      const resNome = await apiFetch(`/api/catalogo/buscar-nome?nome=${encodeURIComponent(termo)}`);
      if (resNome.ok) {
        const data = await resNome.json();
        produtos = data.produtos || [];
      }
    }

    if (!produtos.length) {
      wrap.innerHTML = `<p class="catalogo-promo-vazio">Nenhum produto encontrado pra "${safe(termo)}".</p>`;
      return;
    }

    _catalogoPromoUltimaBusca = new Map(produtos.map(p => [String(p.codigo), p]));
    wrap.innerHTML = produtos.slice(0, 30).map(_catalogoPromoResultadoHTML).join("");
  } catch (err) {
    wrap.innerHTML = `<p class="catalogo-promo-vazio">Erro ao buscar. Tente novamente.</p>`;
    console.warn("[catalogo-promocional] falha na busca:", err.message);
  }
}

function _catalogoPromoRenderSelecionados() {
  const wrap = document.getElementById("catalogo-promo-selecionados");
  const contagemEl = document.getElementById("catalogo-promo-contagem");
  const gerarBtn = document.getElementById("catalogo-promo-gerar-btn");
  if (!wrap) return;

  const itens = [..._catalogoPromoSelecionados.values()];
  if (contagemEl) contagemEl.textContent = `${itens.length} selecionado${itens.length === 1 ? "" : "s"}`;
  if (gerarBtn) gerarBtn.disabled = itens.length === 0;

  if (!itens.length) {
    wrap.innerHTML = `<p class="catalogo-promo-vazio">Nenhum produto selecionado ainda — busque acima e clique em "Adicionar".</p>`;
    return;
  }

  wrap.innerHTML = itens.map(p => `
    <div class="catalogo-promo-selecionado-item">
      <div class="catalogo-promo-resultado-info">
        <strong>${safe(p.codigo)}</strong> — ${safe(p.nome)}
        <span class="catalogo-promo-resultado-meta">${safe(p.secao || "")}${p.linha ? " · " + safe(p.linha) : ""}</span>
      </div>
      <div class="catalogo-promo-item-right">
        ${p.preco != null ? `<span class="catalogo-badge catalogo-badge-ano" title="Preço importado do arquivo">R$ ${safe(_formatarPrecoBR(p.preco))}</span>` : ""}
        <button type="button" class="catalogo-promo-remove-btn" title="Remover da lista" onclick="catalogoPromoRemover('${escapeAttr(p.codigo)}')">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  `).join("");
}

// Formata número (99.9) pra texto pt-BR ("99,90") — só pro badge de preço
// da lista de selecionados, espelhando o formato que o PDF já usa
// (_formatarPrecoPdf em catalogo-pdf.service.js).
function _formatarPrecoBR(valor) {
  return Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function catalogoPromoAdicionar(codigo) {
  const produto = _catalogoPromoUltimaBusca.get(String(codigo));
  if (!produto) return;
  _catalogoPromoSelecionados.set(String(codigo), {
    codigo: produto.codigo,
    nome: produto.nome,
    secao: produto.secao,
    linha: produto.linha,
  });
  _catalogoPromoRenderSelecionados();

  // Atualiza o botão "Adicionar" pra "Adicionado" sem precisar refazer a
  // busca inteira — os resultados continuam na tela depois de adicionar,
  // pra o atendente poder marcar vários seguidos.
  const wrap = document.getElementById("catalogo-promo-resultados");
  if (wrap) wrap.innerHTML = [..._catalogoPromoUltimaBusca.values()].slice(0, 30).map(_catalogoPromoResultadoHTML).join("");
  _agendarPreviewCatalogoPromocional();
}

function catalogoPromoRemover(codigo) {
  _catalogoPromoSelecionados.delete(String(codigo));
  _catalogoPromoRenderSelecionados();
  // Se o produto removido ainda estiver nos resultados de busca em tela,
  // volta o botão dele pra "Adicionar".
  const wrap = document.getElementById("catalogo-promo-resultados");
  if (wrap && _catalogoPromoUltimaBusca.has(String(codigo))) {
    wrap.innerHTML = [..._catalogoPromoUltimaBusca.values()].slice(0, 30).map(_catalogoPromoResultadoHTML).join("");
  }
  _agendarPreviewCatalogoPromocional();
}

function catalogoPromoLimparSelecao() {
  _catalogoPromoSelecionados.clear();
  _catalogoPromoRenderSelecionados();
  const wrap = document.getElementById("catalogo-promo-resultados");
  if (wrap) wrap.innerHTML = [..._catalogoPromoUltimaBusca.values()].slice(0, 30).map(_catalogoPromoResultadoHTML).join("");
  _agendarPreviewCatalogoPromocional();
}

// Escolher o arquivo de preços JÁ importa os produtos pra lista (pedido do
// usuário, 2026-08-29: "no upload de preços promocionais geralmente vai
// junto ao codigo, dá pra fazer a captação do produto ao mesmo tempo o
// preço no arquivo e inseri-lo no catálogo promocional?") — antes o
// arquivo só dava preço a produtos já adicionados manualmente; agora ele
// também POPULA a lista sozinho, sem precisar buscar código por código.
document.getElementById("catalogo-promo-csv")?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    const statusEl = document.getElementById("catalogo-promo-csv-status");
    statusEl?.classList.add("hidden");
    return;
  }
  catalogoPromoImportarArquivo(file);
});

// Lê o arquivo (CSV/XLS/XLSX) no backend, resolve cada código pro produto
// real e já adiciona tudo em _catalogoPromoSelecionados com o preço
// correspondente — a mesma lista que os botões "Adicionar" manuais
// alimentam, então os dois jeitos convivem (pode importar um arquivo E
// ainda buscar/adicionar produtos avulsos depois, ou vice-versa). Se um
// código do arquivo já estiver selecionado manualmente, só atualiza o
// preço dele (merge, não substitui a lista inteira).
async function catalogoPromoImportarArquivo(file) {
  const statusEl = document.getElementById("catalogo-promo-csv-status");
  if (statusEl) {
    statusEl.textContent = `Lendo ${file.name}...`;
    statusEl.classList.remove("hidden");
  }

  try {
    const formData = new FormData();
    formData.append("csv", file);
    const res = await fetch("/api/catalogo/promocional/importar-arquivo", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao importar o arquivo.");

    const produtos = data.produtos || [];
    produtos.forEach((p) => {
      _catalogoPromoSelecionados.set(String(p.codigo), {
        codigo: p.codigo,
        nome: p.nome,
        secao: p.secao,
        linha: p.linha,
        preco: p.preco,
      });
    });
    _catalogoPromoRenderSelecionados();

    // Se algum dos códigos importados estiver nos resultados de busca em
    // tela, atualiza o botão dele pra "Adicionado".
    const wrap = document.getElementById("catalogo-promo-resultados");
    if (wrap && _catalogoPromoUltimaBusca.size) {
      wrap.innerHTML = [..._catalogoPromoUltimaBusca.values()].slice(0, 30).map(_catalogoPromoResultadoHTML).join("");
    }

    const naoEncontrados = data.naoEncontrados || [];
    if (statusEl) {
      statusEl.textContent = produtos.length
        ? `${produtos.length} produto${produtos.length === 1 ? "" : "s"} importado${produtos.length === 1 ? "" : "s"} de ${file.name}.`
        : `Nenhum produto do arquivo foi encontrado no catálogo.`;
      statusEl.classList.remove("hidden");
    }
    if (naoEncontrados.length) {
      showToast?.(`${naoEncontrados.length} código${naoEncontrados.length === 1 ? "" : "s"} do arquivo não ${naoEncontrados.length === 1 ? "foi encontrado" : "foram encontrados"} no catálogo: ${naoEncontrados.join(", ")}`, "warning");
    }

    _agendarPreviewCatalogoPromocional();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || "Erro ao importar o arquivo.";
      statusEl.classList.remove("hidden");
    }
    showToast?.(err.message || "Erro ao importar o arquivo de preços.", "error");
    console.warn("[catalogo-promocional] falha ao importar arquivo:", err.message);
  }
}

// 2026-08-31 (pedido do usuário: "o catalogo promocional poderá ser por
// linha ou por fabricante"): grupo de radio "catalogo-promo-modo" em
// frontend/index.html — lê o valor marcado, "linha" como default seguro se
// por algum motivo nenhum radio existir/estiver marcado no DOM (nunca
// quebra o preview/export por causa disso). Muda o critério de
// agrupamento E a arte de cabeçalho/rodapé no PDF (ver `modo` em
// gerarPdfCatalogoPromocional, catalogo-pdf.service.js).
function _catalogoPromoModoAtual() {
  const marcado = document.querySelector('input[name="catalogo-promo-modo"]:checked');
  return marcado?.value === "fabricante" ? "fabricante" : "linha";
}

// Trocar o modo (Linha/Fabricante) refaz a pré-visualização — o PDF muda de
// agrupamento E de arte de cabeçalho/rodapé, então a prévia velha ficaria
// enganosa se não recarregasse.
document.querySelectorAll('input[name="catalogo-promo-modo"]').forEach((radio) => {
  radio.addEventListener("change", () => _agendarPreviewCatalogoPromocional());
});

// Pré-visualização automática (pedido do usuário, 2026-08-29): mesmo padrão
// de _atualizarPreviewCatalogoCompleto (blob do PDF vira src de <iframe>),
// mas aqui a "seleção" muda a cada clique de Adicionar/Remover/CSV — sem
// debounce, cada clique dispararia uma geração de PDF completa (inclusive
// chamadas de IA pra aplicação de produtos ainda não cacheados). Por isso
// _agendarPreviewCatalogoPromocional só dispara a geração de fato ~1.2s
// depois da última mudança.
let _catalogoPromoPreviewUrl = null;
let _catalogoPromoPreviewTimer = null;

function _agendarPreviewCatalogoPromocional() {
  if (_catalogoPromoPreviewTimer) clearTimeout(_catalogoPromoPreviewTimer);

  if (!_catalogoPromoSelecionados.size) {
    // Nada selecionado: some com a prévia na hora, sem esperar o debounce.
    _catalogoPromoPreviewTimer = null;
    if (_catalogoPromoPreviewUrl) {
      URL.revokeObjectURL(_catalogoPromoPreviewUrl);
      _catalogoPromoPreviewUrl = null;
    }
    document.getElementById("catalogo-promo-preview")?.classList.add("hidden");
    const frame = document.getElementById("catalogo-promo-preview-frame");
    if (frame) frame.src = "about:blank";
    return;
  }

  const wrap = document.getElementById("catalogo-promo-preview");
  const statusEl = document.getElementById("catalogo-promo-preview-status");
  wrap?.classList.remove("hidden");
  if (statusEl) {
    statusEl.textContent = "Aguardando pausa na seleção pra gerar a pré-visualização...";
    statusEl.classList.remove("hidden");
  }

  _catalogoPromoPreviewTimer = setTimeout(_atualizarPreviewCatalogoPromocional, 1200);
}

async function _atualizarPreviewCatalogoPromocional() {
  const frame = document.getElementById("catalogo-promo-preview-frame");
  const statusEl = document.getElementById("catalogo-promo-preview-status");
  const codigos = [..._catalogoPromoSelecionados.keys()];

  if (_catalogoPromoPreviewUrl) {
    URL.revokeObjectURL(_catalogoPromoPreviewUrl);
    _catalogoPromoPreviewUrl = null;
  }

  if (!codigos.length) return;

  if (frame) frame.src = "about:blank";
  if (statusEl) {
    statusEl.textContent = "Gerando pré-visualização... (pode levar alguns segundos)";
    statusEl.classList.remove("hidden");
  }

  try {
    const formData = new FormData();
    formData.append("codigos", JSON.stringify(codigos));
    formData.append("modo", _catalogoPromoModoAtual());
    const csvFile = document.getElementById("catalogo-promo-csv")?.files?.[0];
    if (csvFile) formData.append("csv", csvFile);

    const res = await fetch("/api/catalogo/promocional/exportar-pdf", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Erro ao gerar pré-visualização.");
    }
    const blob = await res.blob();
    _catalogoPromoPreviewUrl = URL.createObjectURL(blob);
    if (frame) frame.src = _catalogoPromoPreviewUrl;
    if (statusEl) statusEl.classList.add("hidden");
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || "Não foi possível carregar a pré-visualização.";
      statusEl.classList.remove("hidden");
    }
    console.warn("[catalogo] falha ao carregar preview do catálogo promocional:", err.message);
  }
}

async function gerarCatalogoPromocionalPDF(btnEl) {
  const codigos = [..._catalogoPromoSelecionados.keys()];
  if (!codigos.length) return;

  const original = btnEl?.innerHTML;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando PDF...';
  }

  try {
    const formData = new FormData();
    formData.append("codigos", JSON.stringify(codigos));
    formData.append("modo", _catalogoPromoModoAtual());
    const csvFile = document.getElementById("catalogo-promo-csv")?.files?.[0];
    if (csvFile) formData.append("csv", csvFile);

    const res = await fetch("/api/catalogo/promocional/exportar-pdf", {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Erro ao gerar PDF do catálogo promocional.");
    }

    const naoEncontrados = res.headers.get("X-Catalogo-Codigos-Nao-Encontrados");
    if (naoEncontrados) {
      showToast?.(`Alguns códigos não foram encontrados e ficaram de fora do PDF: ${naoEncontrados}`, "warning");
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `catalogo-promocional-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast?.(err.message || "Erro ao gerar catálogo promocional em PDF.", "error");
  } finally {
    if (btnEl) {
      btnEl.disabled = codigos.length === 0;
      btnEl.innerHTML = original;
    }
  }
}


// ─── Modo consulta (programa .exe da loja, ?app=catalogo) ───────────────────
// Duas abas grandes: "Consultar" (as buscas por Critérios/Código/Nome) e
// "Montar Catálogos" (ícones dos catálogos prontos, um por fabricante; o clique
// abre o PDF contínuo na própria janela). Pedido do usuário (2026-10-20).
function catalogoConsultaInicio() {
  document.documentElement.classList.add("consulta-inicio");
}

function catalogoConsultaMostrar(modo) {
  const montar = modo === "montar";
  document.documentElement.classList.remove("consulta-inicio");
  document.documentElement.classList.toggle("consulta-montar", montar);
  document.getElementById("catalogo-consulta-tab-consultar")?.classList.toggle("active", !montar);
  document.getElementById("catalogo-consulta-tab-montar")?.classList.toggle("active", montar);
  if (montar) {
    catalogoMostrarAbaCompleto();
    catalogoMontarVoltar();
    _catalogoMontarRenderGrid();
  } else {
    catalogoMostrarAbaVeiculo();
  }
}

// Logos dos fabricantes (frontend/logos-marcas/<nome>.png). Fabricante sem
// logo continua com o ícone de PDF. O nome do arquivo é o fabricante sem o
// sufixo "::mecanica/eletrica", em minúsculas, sem acento.
const _CATALOGO_LOGOS_MARCAS = new Set(["12m", "3rho", "aeroflex", "almapy", "amefil", "ams", "arielo", "automaxx", "bastos", "bastos-juntas", "bc-cabos", "bobinauto", "bosch", "bzm", "cav", "cemak", "cinap", "cinoy", "d-paula", "delco", "delco-remy", "diretec", "drift", "edanti", "eletricway", "facobras", "fiamm", "filtros-brasil", "fortluz", "frontec", "gauss", "hbr", "iguacu", "ikro", "indebras", "intermec", "katho", "kostal", "ktr", "lucas", "mancal-de-acionamento-mitsubishi", "marflex", "marilia", "marzu", "mecabrazil", "mobensani", "mte", "multilight", "multiqualita", "neolux", "ngk", "nino", "olimpic", "ospina", "osram", "perfect", "polo", "pradolux", "premier-bobinas", "rainha", "recrin", "seg", "siemens", "skf", "speed-brake", "sulcarbon", "tiger", "valeo", "venka", "vetor", "volda", "wega", "willtec", "wisa", "zen", "zwf"]);
function _catalogoMontarLogo(valor) {
  const nome = String(valor || "").split("::")[0].toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return _CATALOGO_LOGOS_MARCAS.has(nome) ? nome : "";
}

// Sem logo: DIVERSOS mecânica ganha engrenagem/chave, DIVERSOS elétrica ganha raio; o resto segue com o ícone de PDF.
function _catalogoMontarIcone(valor) {
  const v = String(valor || "").toUpperCase();
  if (v === "DIVERSOS::MECANICA") return "fa-gear";
  if (v === "DIVERSOS::ELETRICA") return "fa-bolt";
  return "fa-file-pdf";
}

async function _catalogoMontarRenderGrid() {
  const grid = document.getElementById("catalogo-montar-grid");
  if (!grid) return;
  grid.innerHTML = '<p class="catalogo-completo-preview-status">Carregando catálogos...</p>';
  const opcoes = await _catalogoBuscarFabricantesCompletoOpcoes();
  if (!opcoes.length) {
    grid.innerHTML = '<p class="catalogo-completo-preview-status">Nenhum catálogo disponível no momento.</p>';
    return;
  }
  const barra = document.getElementById("catalogo-montar-offline");
  if (barra) barra.classList.toggle("hidden", !(window.catalogoLoja && window.catalogoLoja.catalogoLocalSalvar));
  window._catalogoMontarOpcoes = opcoes;
  grid.innerHTML = opcoes.map(o => {
    const logo = _catalogoMontarLogo(o.value);
    const visual = logo
      ? `<img class="catalogo-montar-logo" src="logos-marcas/${logo}.png" alt="">`
      : `<i class="fa-solid ${_catalogoMontarIcone(o.value)}" aria-hidden="true"></i>`;
    return `<button type="button" class="catalogo-montar-card" role="listitem" data-valor="${safe(o.value)}">` +
      `${visual}<span>${safe(o.label)}</span></button>`;
  }).join("");
  grid.onclick = (ev) => {
    const card = ev.target.closest(".catalogo-montar-card");
    if (card) catalogoMontarAbrir(card.getAttribute("data-valor"));
  };
}

async function catalogoMontarAbrir(valor) {
  await loadCatalogoFabricantesCompleto();
  const select = document.getElementById("catalogo-fabricante-completo");
  if (!select) return;
  select.value = valor;
  document.documentElement.classList.add("montar-aberto");
  onCatalogoFabricanteCompletoChange();
}

function catalogoMontarVoltar() {
  document.documentElement.classList.remove("montar-aberto");
  const select = document.getElementById("catalogo-fabricante-completo");
  if (select && select.value) {
    select.value = "";
    onCatalogoFabricanteCompletoChange();
  }
}

// Programa da loja: baixa (um por vez) todos os catálogos que ainda não estão no computador
// ou estão desatualizados, para poderem ser abertos sem o servidor. Só roda quando a pessoa clica.
async function catalogoSalvarTodosOffline() {
  const btn = document.getElementById("catalogo-montar-offline-btn");
  const st = document.getElementById("catalogo-montar-offline-status");
  const opcoes = window._catalogoMontarOpcoes || [];
  if (!opcoes.length || !btn) return;
  btn.disabled = true;
  let ok = 0, falhas = 0;
  for (let i = 0; i < opcoes.length; i++) {
    if (st) st.textContent = `Salvando ${i + 1} de ${opcoes.length}: ${opcoes[i].label}...`;
    try { await _catalogoPdfComCopiaLocal(opcoes[i].value, null); ok++; } catch (_) { falhas++; }
  }
  btn.disabled = false;
  if (st) st.textContent = falhas ? `${ok} salvos, ${falhas} não puderam ser baixados.` : `Pronto: ${ok} catálogos salvos neste computador.`;
}
