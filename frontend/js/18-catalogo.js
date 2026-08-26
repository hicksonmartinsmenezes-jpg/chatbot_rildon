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

// Aba "Catálogo Completo" (pedido do usuário, 2026-08-26): dropdown
// separado, sem opção "Todos" — aqui o atendente precisa escolher UM
// fabricante específico pra gerar o PDF do catálogo inteiro dele, não faz
// sentido "todos os fabricantes" numa exportação só.
let _catalogoFabricantesCompletoCarregados = false;

async function loadCatalogoFabricantesCompleto() {
  if (_catalogoFabricantesCompletoCarregados) return;
  const fabricantes = await _catalogoBuscarFabricantesLista();
  const select = document.getElementById("catalogo-fabricante-completo");
  if (select && fabricantes.length) {
    select.innerHTML = '<option value="">Selecione um fabricante...</option>' +
      fabricantes.map(f => `<option value="${safe(f)}">${safe(f)}</option>`).join("");
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
  } catch (err) {
    if (contagemEl) contagemEl.textContent = "Erro ao contar produtos dessa marca.";
    if (btn) btn.disabled = true;
    console.warn("[catalogo] falha ao contar produtos do fabricante:", err.message);
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
    a.download = `catalogo-completo-${fabricante.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.pdf`;
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
  document.getElementById("catalogo-form")?.classList.add("hidden");
  document.getElementById("catalogo-form-codigo")?.classList.add("hidden");
  document.getElementById("catalogo-form-nome")?.classList.add("hidden");
  document.getElementById("catalogo-form-completo")?.classList.add("hidden");
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

// Limpa os campos do formulário e volta o painel de resultados pro estado
// inicial — atalho pra começar uma nova busca do zero (pedido de UX).
function limparCatalogoForm() {
  ["catalogo-marca", "catalogo-modelo", "catalogo-ano"].forEach(id => {
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
    wrap.innerHTML = _catalogoEmptyState("fa-magnifying-glass-chart", "Preencha marca/modelo pra buscar por veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo.");
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

// Expande/recolhe o texto completo de aplicação (fica truncado no card por
// padrão pra não estourar o layout — alguns produtos citam dezenas de
// veículos no mesmo texto).
function toggleCatalogoAplicacao(btnEl) {
  const card = btnEl.closest(".catalogo-card");
  if (!card) return;
  const curta    = card.querySelector(".catalogo-aplicacao-curta");
  const completa = card.querySelector(".catalogo-aplicacao-completa");
  if (!curta || !completa) return;

  const vaiExpandir = completa.classList.contains("hidden");
  completa.classList.toggle("hidden");
  curta.classList.toggle("hidden");
  btnEl.innerHTML = vaiExpandir
    ? '<i class="fa-solid fa-chevron-up"></i> Ver menos'
    : '<i class="fa-solid fa-chevron-down"></i> Ver aplicação completa';
}

// "Ver referências" (pedido do usuário, 2026-07-30, inspirado na tela
// "Equivalentes" do X2): mostra os códigos de outros fabricantes cadastrados
// como equivalentes dessa mesma peça (ficha.equivalentesLista, já indexado
// em catalogo-x2.service.js). Fica escondido por padrão — só expande ao
// clicar, mesmo padrão de toggleCatalogoAplicacao acima.
function toggleCatalogoReferencias(btnEl) {
  const card = btnEl.closest(".catalogo-card");
  if (!card) return;
  const painel = card.querySelector(".catalogo-referencias");
  if (!painel) return;

  const vaiExpandir = painel.classList.contains("hidden");
  painel.classList.toggle("hidden");
  // Pedido do usuário (2026-07-30): o painel de referências ficava espremido
  // na largura de UMA coluna do grid (.catalogo-grid é auto-fill, então com
  // poucos resultados sobra muito espaço vazio à direita). Enquanto aberto,
  // o card estica pra ocupar o grid inteiro (grid-column: 1 / -1), dando
  // espaço de verdade pros cards de equivalentes com foto.
  card.classList.toggle("catalogo-card-expandido", vaiExpandir);
  btnEl.innerHTML = vaiExpandir
    ? '<i class="fa-solid fa-chevron-up"></i> Ocultar referências'
    : `<i class="fa-solid fa-link"></i> Ver referências (${btnEl.dataset.total})`;
}

// Pedido do usuário (2026-07-30): clicar no nome de um produto equivalente
// (dentro do card com foto) deve abrir esse produto direto, sem precisar
// pesquisar de novo manualmente. Reaproveita a aba "Busca por Código" já
// existente (buscarCatalogoPorCodigo), só preenchendo o campo e disparando
// a busca pelo código interno do produto encontrado. Também abre
// automaticamente o "Ver referências" desse produto encontrado (pedido do
// usuário logo em seguida: "não mostrou as referências também dessa peça
// que selecionei") — sem isso o usuário chegava no produto com o painel
// fechado, precisando clicar de novo pra continuar navegando pela cadeia
// de equivalentes.
async function catalogoAbrirProdutoEquivalente(codigo) {
  catalogoMostrarAbaCodigo();
  const input = document.getElementById("catalogo-codigo-busca");
  if (input) input.value = codigo;
  await buscarCatalogoPorCodigo();

  const wrap = document.getElementById("catalogo-resultados");
  wrap?.scrollIntoView({ behavior: "smooth", block: "start" });

  const refBtn = wrap?.querySelector(".catalogo-card .catalogo-ref-btn");
  if (refBtn) toggleCatalogoReferencias(refBtn);
}

// Cartão de cabeçalho igual à tela "Equivalentes" do X2 (foto + "Código
// Produto X - NOME" + Código Barras + Código Fornecedor) — pedido do
// usuário (2026-07-30): "quando eu clicar, apareça uma lista exatamente
// assim embaixo". Usa os mesmos dados já indexados (barras, referencia).
function _catalogoRefBannerHTML(produto) {
  return `
    <div class="catalogo-ref-banner">
      <div class="catalogo-ref-banner-photo">
        <i class="fa-solid fa-image catalogo-ref-banner-photo-fallback"></i>
        <img
          src="/api/catalogo/produtos/${encodeURIComponent(produto.codigo)}/fotos/0"
          alt="${safe(produto.nome)}"
          loading="lazy"
          onerror="this.remove();"
        >
      </div>
      <div class="catalogo-ref-banner-info">
        <strong
          class="catalogo-ref-banner-title catalogo-ref-banner-title-link"
          title="Abrir esse produto"
          onclick="event.stopPropagation(); catalogoAbrirProdutoEquivalente('${escapeAttr(produto.codigo)}')"
        >
          Código Produto ${safe(produto.codigo)} - ${safe(produto.nome)}
          <i class="fa-regular fa-file-lines"></i>
        </strong>
        <div class="catalogo-ref-banner-meta">
          ${produto.barras ? `<span><i class="fa-solid fa-barcode"></i> Código Barras - ${safe(produto.barras)}</span>` : ""}
          ${produto.referencia ? `<span><i class="fa-solid fa-user"></i> Código Fornecedor - ${safe(produto.referencia)}</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

// Card completo (foto + Código Produto + Código Barras + Código Fornecedor)
// pra cada código equivalente que a própria loja também revende — pedido do
// usuário (2026-07-30): "cada equivalente devia ter um card completo", não
// só o código cru. Reaproveita o mesmo visual do banner do produto
// principal (_catalogoRefBannerHTML), só adiciona o botão de copiar código
// equivalente (o código usado na busca pode ser diferente do código interno
// do produto encontrado — ex: FK1324 aponta pra um produto cujo código
// interno de catálogo é outro).
function _catalogoRefEquivCardHTML(det) {
  const p = det.produto;
  return `
    <div class="catalogo-ref-banner catalogo-ref-equiv-card">
      <div class="catalogo-ref-banner-photo">
        <i class="fa-solid fa-image catalogo-ref-banner-photo-fallback"></i>
        <img
          src="/api/catalogo/produtos/${encodeURIComponent(p.codigo)}/fotos/0"
          alt="${safe(p.nome)}"
          loading="lazy"
          onerror="this.remove();"
        >
      </div>
      <div class="catalogo-ref-banner-info">
        <strong
          class="catalogo-ref-banner-title catalogo-ref-banner-title-link"
          title="Abrir esse produto"
          onclick="event.stopPropagation(); catalogoAbrirProdutoEquivalente('${escapeAttr(p.codigo)}')"
        >Código Produto ${safe(p.codigo)} - ${safe(p.nome)}</strong>
        <div class="catalogo-ref-banner-meta">
          ${p.barras ? `<span><i class="fa-solid fa-barcode"></i> Código Barras - ${safe(p.barras)}</span>` : ""}
          ${p.referencia ? `<span><i class="fa-solid fa-user"></i> Código Fornecedor - ${safe(p.referencia)}</span>` : ""}
        </div>
      </div>
      <button
        type="button"
        class="catalogo-ref-chip catalogo-ref-equiv-copy"
        title="Copiar código"
        onclick="event.stopPropagation(); copiarCodigoCatalogo('${escapeAttr(det.codigo)}', this)"
      >
        <i class="fa-regular fa-copy"></i> ${safe(det.codigo)}
      </button>
    </div>
  `;
}

// Chip simples (só o código) — usado quando o código equivalente é de um
// fabricante que a loja não revende, então não existe produto cadastrado
// pra montar o card completo acima.
function _catalogoRefChipHTML(det) {
  return `
    <button
      type="button"
      class="catalogo-ref-chip"
      title="Copiar código"
      onclick="event.stopPropagation(); copiarCodigoCatalogo('${escapeAttr(det.codigo)}', this)"
    >
      <i class="fa-regular fa-copy"></i> ${safe(det.codigo)}
    </button>
  `;
}

// Prévia de códigos originais/equivalentes sempre visível no card (pedido
// do usuário, 2026-08-13): antes esses códigos só apareciam escondidos
// atrás do clique em "Ver referências" lá embaixo — o atendente não tinha
// como saber, só olhando a lista, se uma peça tinha equivalente sem abrir
// cada card. Mostra os 3 primeiros direto; clicar abre o mesmo painel
// completo de _catalogoReferenciasHTML (aciona o botão .catalogo-ref-btn
// de verdade, então o texto do botão e o estado expandido continuam
// corretos).
const CATALOGO_EQUIV_PREVIA_MAX = 3;

function _catalogoEquivalentesPreviaHTML(produto) {
  const equivalentes = Array.isArray(produto.equivalentes) ? produto.equivalentes : [];
  if (!equivalentes.length) return "";

  const previa = equivalentes.slice(0, CATALOGO_EQUIV_PREVIA_MAX);
  const resto = equivalentes.length - previa.length;
  const chips = previa.map(codigo => `<span class="catalogo-equiv-previa-chip">${safe(codigo)}</span>`).join("");

  return `
    <div
      class="catalogo-card-equiv-previa"
      onclick="event.stopPropagation(); this.closest('.catalogo-card')?.querySelector('.catalogo-ref-btn')?.click();"
      title="Ver todos os códigos originais/equivalentes"
    >
      <i class="fa-solid fa-link"></i>
      <span class="catalogo-equiv-previa-label">Códigos originais:</span>
      ${chips}
      ${resto > 0 ? `<span class="catalogo-equiv-previa-mais">+${resto}</span>` : ""}
    </div>
  `;
}

function _catalogoReferenciasHTML(produto) {
  const equivalentes = Array.isArray(produto.equivalentes) ? produto.equivalentes : [];
  if (!equivalentes.length) return "";

  // equivalentesDetalhados (novo, 2026-07-30): cada código equivalente já
  // vem com o produto de verdade resolvido, se a loja também vender essa
  // peça (ver _resolverEquivalente em catalogo-x2.service.js). Fallback pro
  // formato antigo (só código cru) se o backend ainda não tiver sido
  // reiniciado / bundle antigo em cache.
  const detalhes = Array.isArray(produto.equivalentesDetalhados) && produto.equivalentesDetalhados.length
    ? produto.equivalentesDetalhados
    : equivalentes.map(codigo => ({ codigo, produto: null }));

  const cards = detalhes.filter(d => d.produto).map(_catalogoRefEquivCardHTML).join("");
  const chips = detalhes.filter(d => !d.produto).map(_catalogoRefChipHTML).join("");

  return `
    <button type="button" class="catalogo-expand-btn catalogo-ref-btn" data-total="${equivalentes.length}" onclick="toggleCatalogoReferencias(this)">
      <i class="fa-solid fa-link"></i> Ver referências (${equivalentes.length})
    </button>
    <div class="catalogo-referencias hidden">
      ${_catalogoRefBannerHTML(produto)}
      <span class="catalogo-referencias-label">Códigos equivalentes (outros fabricantes):</span>
      ${cards ? `<div class="catalogo-ref-equiv-cards">${cards}</div>` : ""}
      ${chips ? `<div class="catalogo-referencias-list">${chips}</div>` : ""}
    </div>
  `;
}

// mostrarBadgeNeutro: só faz sentido quando a busca envolveu marca/modelo
// (aí sim vale avisar "confirme com o cliente" quando nada bateu). No modo
// navegação (só Seção/Linha, sem veículo informado) não tem comparação
// nenhuma sendo feita — mostrar o aviso em toda peça listada seria ruído.
// PEDIDO DO USUÁRIO (2026-08-07): "Estoque ao vivo no Catálogo/orçamento" —
// produto.estoque vem null pra ~2/3 dos produtos (Relatório de Estoque do
// X2 cobre ~5.200 dos 17.400 do catálogo) — nesse caso não mostra nada
// (sem dado ≠ zero produtos, não dá pra afirmar "sem estoque" sem saber).
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

function _catalogoCardHTML(produto, mostrarBadgeNeutro) {
  const badges = [];
  if (produto.marcaCompativel) {
    badges.push('<span class="catalogo-badge catalogo-badge-marca"><i class="fa-solid fa-check"></i> Marca confere</span>');
  }
  if (produto.anoCompativel) {
    badges.push('<span class="catalogo-badge catalogo-badge-ano"><i class="fa-solid fa-check"></i> Ano compatível</span>');
  }
  if (mostrarBadgeNeutro && !produto.marcaCompativel && !produto.anoCompativel) {
    badges.push('<span class="catalogo-badge catalogo-badge-neutro"><i class="fa-solid fa-circle-info"></i> Confirme ano/marca com o cliente</span>');
  }

  const aplicacaoCompleta = String(produto.aplicacao || "");
  const aplicacaoCurta    = cutText(aplicacaoCompleta, 160);
  const precisaExpandir   = aplicacaoCompleta.length > 160;

  // Foto: aponta direto pro endpoint já existente (catalogo.controller.js).
  // Se o produto não tiver foto cadastrada, a rota devolve 404 e o onerror
  // remove a img (sobra o ícone de fallback) — sem chamada extra só pra
  // checar existência.
  return `
    <article class="catalogo-card">
      <div class="catalogo-card-photo">
        <i class="fa-solid fa-image catalogo-card-photo-fallback"></i>
        <img
          src="/api/catalogo/produtos/${encodeURIComponent(produto.codigo)}/fotos/0"
          alt="${safe(produto.nome)}"
          loading="lazy"
          onerror="this.remove();"
          onclick="event.stopPropagation(); window.open(this.currentSrc || this.src, '_blank');"
          title="Clique pra abrir a foto em outra página"
        >
      </div>
      <div class="catalogo-card-body">
        <div class="catalogo-card-head">
          <span class="catalogo-card-secao">${safe(produto.secao)}${produto.linha ? " · " + safe(produto.linha) : ""}</span>
          <button
            type="button"
            class="catalogo-copy-btn"
            title="Copiar código pra conferir no ERP"
            onclick="copiarCodigoCatalogo('${produto.codigo}', this)"
          >
            <i class="fa-regular fa-copy"></i> ${safe(produto.codigo)}
          </button>
        </div>

        <h4 class="catalogo-card-nome">${safe(produto.nome)}</h4>
        ${produto.referencia ? `<span class="catalogo-card-ref">Ref: ${safe(produto.referencia)}</span>` : ""}
        ${produto.fabricante ? `<span class="catalogo-card-fabricante"><i class="fa-solid fa-industry"></i> ${safe(produto.fabricante)}</span>` : ""}
        ${_catalogoEquivalentesPreviaHTML(produto)}

        <p class="catalogo-card-aplicacao catalogo-aplicacao-curta">${safe(aplicacaoCurta)}</p>
        <p class="catalogo-card-aplicacao catalogo-aplicacao-completa hidden">${safe(aplicacaoCompleta)}</p>
        ${precisaExpandir ? `
          <button type="button" class="catalogo-expand-btn" onclick="toggleCatalogoAplicacao(this)">
            <i class="fa-solid fa-chevron-down"></i> Ver aplicação completa
          </button>
        ` : ""}

        <div class="catalogo-card-badges">${badges.join("")}</div>
        ${_catalogoEstoqueHTML(produto.estoque)}
        ${_catalogoReferenciasHTML(produto)}
      </div>
    </article>
  `;
}

async function buscarCatalogo(event) {
  if (event) event.preventDefault();
  const searchBtn = event?.target?.querySelector?.(".catalogo-erp-search-btn");
  setButtonBusy(searchBtn, true, "Buscando...");

  const marca  = document.getElementById("catalogo-marca")?.value.trim()  || "";
  const modelo = document.getElementById("catalogo-modelo")?.value.trim() || "";
  const ano    = document.getElementById("catalogo-ano")?.value.trim()    || "";

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
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe marca/modelo do veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo.", "catalogo-warn-state");
    return;
  }

  // Pedido do usuário (2026-07-31): Modelo é o único campo que o backend usa
  // pra FILTRAR de verdade uma busca por veículo (Marca só ranqueia depois —
  // ver comentário em buscarProdutosPainel, catalogo-x2.service.js). Buscar
  // só por Marca (ex: "Ford", sem Modelo) faz a mesma busca ampla contra
  // TODO o texto de aplicação, só que sem nem o Modelo pra restringir —
  // ainda mais resultado solto. Por isso, sempre que Marca e/ou Ano forem
  // usados (ou seja, é uma busca por veículo, não navegação por Seção/
  // Fabricante), exige Modelo preenchido também.
  if ((marca || ano) && !modelo) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe o Modelo pra buscar por veículo — só Marca/Ano sozinhos trazem resultado amplo demais.", "catalogo-warn-state");
    return;
  }

  const modoNavegacao = !marca && !modelo; // só categoria/fabricante — não é busca por veículo
  wrap.innerHTML = renderSkeletonGrid(8);

  const params = new URLSearchParams();
  if (marca)      params.set("marca", marca);
  if (modelo)     params.set("modelo", modelo);
  if (ano)        params.set("ano", ano);
  if (categoria)  params.set("categoria", categoria);
  if (fabricante) params.set("fabricante", fabricante);

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
    if (marca)      chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-car-side"></i> ${safe(marca)}</span>`);
    if (modelo)     chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-car"></i> ${safe(modelo)}</span>`);
    if (ano)        chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-calendar-day"></i> ${safe(ano)}</span>`);
    if (categoria)  chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-gears"></i> ${safe(categoria)}</span>`);
    if (fabricante) chips.push(`<span class="catalogo-chip"><i class="fa-solid fa-industry"></i> ${safe(fabricante)}</span>`);
    const chipsHTML = chips.length ? `<div class="catalogo-chips">${chips.join("")}</div>` : "";

    if (!produtos.length) {
      wrap.innerHTML = `${chipsHTML}${_catalogoEmptyState("fa-box-open", "Nenhuma peça encontrada pra esses critérios.")}`;
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
    `;
    const grid = `<div class="catalogo-grid">${produtos.map(p => _catalogoCardHTML(p, !modoNavegacao)).join("")}</div>`;
    wrap.innerHTML = resumoBar + grid;
    // Guarda os critérios desta busca pro botão de exportar (pedido do
    // usuário, 2026-07-28) — exporta TODOS os resultados do filtro, não só
    // os "produtos.length" mostrados na tela (ver MAX_EXPORT_PDF no backend).
    wrap.dataset.exportQuery = params.toString();
    applyStaggerIn(wrap.querySelector(".catalogo-grid"));
    bindLazyImageFade(wrap);
  } catch (err) {
    wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", "Erro ao buscar peças. Tente novamente.", "catalogo-error-state");
  }

  } finally {
    setButtonBusy(searchBtn, false);
  }
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
    `;
    // mostrarBadgeNeutro=false: busca por código é exata, não tem
    // marca/ano pra comparar — o aviso "confirme com o cliente" não se aplica.
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
    `;
    // mostrarBadgeNeutro=false: busca por nome não tem marca/ano pra
    // comparar — o aviso "confirme com o cliente" não se aplica.
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
