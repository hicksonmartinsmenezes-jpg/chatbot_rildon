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
  try {
    const res = await apiFetch("/api/catalogo/fabricantes");
    if (!res.ok) return;
    const data = await res.json();
    const select = document.getElementById("catalogo-fabricante");
    if (select && Array.isArray(data.fabricantes)) {
      select.innerHTML = '<option value="">Todos</option>' +
        data.fabricantes.map(f => `<option value="${safe(f)}">${safe(f)}</option>`).join("");
    }
    _catalogoFabricantesCarregados = true;
  } catch (err) {
    console.warn("[catalogo] falha ao carregar fabricantes:", err.message);
  }
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

// Duas sub-abas dentro do painel (Task #250-253): "Critérios de Pesquisa"
// (marca/modelo/ano/seção/linha/fabricante) e "Busca por Código" (código
// isolado, sem depender de veículo nenhum — cliente às vezes só tem o número
// gravado na peça antiga). Só uma fica visível por vez, mesmo padrão visual
// da tab strip estilo ERP já usado no painel.
function catalogoMostrarAbaVeiculo() {
  document.getElementById("catalogo-tab-veiculo")?.classList.add("active");
  document.getElementById("catalogo-tab-codigo")?.classList.remove("active");
  document.getElementById("catalogo-form")?.classList.remove("hidden");
  document.getElementById("catalogo-form-codigo")?.classList.add("hidden");
  document.getElementById("catalogo-hint-veiculo")?.classList.remove("hidden");
  document.getElementById("catalogo-hint-codigo")?.classList.add("hidden");
}

function catalogoMostrarAbaCodigo() {
  document.getElementById("catalogo-tab-codigo")?.classList.add("active");
  document.getElementById("catalogo-tab-veiculo")?.classList.remove("active");
  document.getElementById("catalogo-form-codigo")?.classList.remove("hidden");
  document.getElementById("catalogo-form")?.classList.add("hidden");
  document.getElementById("catalogo-hint-codigo")?.classList.remove("hidden");
  document.getElementById("catalogo-hint-veiculo")?.classList.add("hidden");
  document.getElementById("catalogo-codigo-busca")?.focus();
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

// Copia o código do produto pro clipboard — é a ponte direta pro próximo
// passo do atendente (conferir preço/estoque no ERP com esse código).
async function copiarCodigoCatalogo(codigo, btnEl) {
  try {
    await navigator.clipboard.writeText(String(codigo));
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
  } catch (err) {
    showToast?.("Não foi possível copiar o código.", "error");
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

// mostrarBadgeNeutro: só faz sentido quando a busca envolveu marca/modelo
// (aí sim vale avisar "confirme com o cliente" quando nada bateu). No modo
// navegação (só Seção/Linha, sem veículo informado) não tem comparação
// nenhuma sendo feita — mostrar o aviso em toda peça listada seria ruído.
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

        <p class="catalogo-card-aplicacao catalogo-aplicacao-curta">${safe(aplicacaoCurta)}</p>
        <p class="catalogo-card-aplicacao catalogo-aplicacao-completa hidden">${safe(aplicacaoCompleta)}</p>
        ${precisaExpandir ? `
          <button type="button" class="catalogo-expand-btn" onclick="toggleCatalogoAplicacao(this)">
            <i class="fa-solid fa-chevron-down"></i> Ver aplicação completa
          </button>
        ` : ""}

        <div class="catalogo-card-badges">${badges.join("")}</div>
      </div>
    </article>
  `;
}

async function buscarCatalogo(event) {
  if (event) event.preventDefault();

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
  if (!wrap) return;

  // Modo navegação (pedido do usuário, 2026-07-22, estendido em 2026-07-23
  // pra fabricante): sem marca/modelo, uma Seção/Linha e/ou Fabricante já
  // bastam pra listar o catálogo inteiro daquele filtro — inclusive peças
  // sem texto de aplicação/veículo (ex: abraçadeira, parafuso), que a busca
  // por veículo abaixo nunca alcançaria.
  if (!marca && !modelo && !categoria && !fabricante) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe marca/modelo do veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo.", "catalogo-warn-state");
    return;
  }

  const modoNavegacao = !marca && !modelo; // só categoria/fabricante — não é busca por veículo
  wrap.innerHTML = _catalogoEmptyState("fa-spinner fa-spin", "Buscando...", "catalogo-loading-state");

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
      </div>
    `;
    const grid = `<div class="catalogo-grid">${produtos.map(p => _catalogoCardHTML(p, !modoNavegacao)).join("")}</div>`;
    wrap.innerHTML = resumoBar + grid;
  } catch (err) {
    wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", "Erro ao buscar peças. Tente novamente.", "catalogo-error-state");
  }
}

// Busca isolada por código de fabricante/referência/código interno (Task
// #250-253, pedido do usuário em 2026-07-23) — aba separada de "Critérios de
// Pesquisa" porque é um modo de busca diferente: exato, sem ranking nem
// badges de marca/ano (não faz sentido comparar contra veículo nenhum aqui).
async function buscarCatalogoPorCodigo(event) {
  if (event) event.preventDefault();

  const codigo = document.getElementById("catalogo-codigo-busca")?.value.trim() || "";
  const wrap = document.getElementById("catalogo-resultados");
  if (!wrap) return;

  if (!codigo) {
    wrap.innerHTML = _catalogoEmptyState("fa-triangle-exclamation", "Informe o código de fabricante, referência ou código interno da peça.", "catalogo-warn-state");
    return;
  }

  wrap.innerHTML = _catalogoEmptyState("fa-spinner fa-spin", "Buscando...", "catalogo-loading-state");

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
      </div>
    `;
    // mostrarBadgeNeutro=false: busca por código é exata, não tem
    // marca/ano pra comparar — o aviso "confirme com o cliente" não se aplica.
    const grid = `<div class="catalogo-grid">${produtos.map(p => _catalogoCardHTML(p, false)).join("")}</div>`;
    wrap.innerHTML = resumoBar + grid;
  } catch (err) {
    wrap.innerHTML = _catalogoEmptyState("fa-circle-exclamation", "Erro ao buscar peça. Tente novamente.", "catalogo-error-state");
  }
}
