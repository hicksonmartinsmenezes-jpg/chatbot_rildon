// scripts/x2-painel/public/app.js
//
// PEDIDO DO USUÁRIO (2026-09-11): "deixe mais organizado" — até aqui, todo
// o JS do painel vivia inline dentro de <script> em index.html. Extraído
// sem NENHUMA mudança de comportamento (copiar/colar programático, linha
// por linha) — a partir daqui só entram os ajustes pedidos junto (mesclar
// a aba Alertas dentro de Estoque, atualizar o aviso de Lançamentos com o
// passo novo de PDF/Drive). index.html agora só referencia isto via
// <script src="app.js"></script>, na mesma posição (fim do <body>) que o
// <script> inline ocupava — timing de carregamento idêntico.
(function () {
  'use strict';

  let secoes = [];
  let totalProdutosUnicos = 0;
  let totalComFotoUnicos = null;
  const selecionadas = new Set();
  let rodando = false;
  let filtroTexto = '';
  let filtroRapido = 'todas';
  let acaoAtiva = 'baixar';
  let secoesExpandido = false;
  const LIMITE_SECOES_VISIVEIS = 8;

  function el(id) { return document.getElementById(id); }

  // Escapa valores vindos do servidor/arquivos antes de interpolá-los em HTML.
  // Use somente para conteúdo textual e atributos entre aspas.
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  // ─── Toast (2026-09-12) ─────────────────────────────────────────────
  // PEDIDO DO USUÁRIO ("vamos fazer mudanças de ui e ux"): substitui os
  // alert() nativos (feios, bloqueiam a aba inteira até clicar OK, sem
  // nada a ver com o resto do visual do painel) por uma notificação no
  // canto da tela, no mesmo padrão de cor de .aviso-banner/.info-banner.
  // 'erro' = vermelho (ação falhou de verdade), 'aviso' = âmbar (falta
  // preencher algo, mesma cor de .aviso-inline). Some sozinho depois de
  // alguns segundos ou no clique — nunca bloqueia a tela.
  function mostrarToast(mensagem, tipo) {
    const container = el('toast-container');
    if (!container) { console.warn('[x2-painel] toast:', mensagem); return; }
    const icone = tipo === 'erro' ? '⛔' : tipo === 'aviso' ? '⚠️' : 'ℹ️';
    const toast = document.createElement('div');
    toast.className = `toast ${tipo || ''}`.trim();
    toast.innerHTML = `<span class="toast-icon">${icone}</span><span class="toast-texto"></span>`;
    toast.querySelector('.toast-texto').textContent = mensagem;
    const remover = () => {
      toast.classList.add('saindo');
      setTimeout(() => toast.remove(), 150);
    };
    toast.addEventListener('click', remover);
    container.appendChild(toast);
    setTimeout(remover, 6000);
  }

  // ─── Resumo (KPIs) ────────────────────────────────────────────────
  // Ícones/acentos e subtexto contextual (2026-08-11, mockup do usuário) —
  // tudo calculado em cima do que já vinha em `secoes`, nada novo do backend.
  const ICONE_SECOES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>';
  const ICONE_PRODUTOS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>';
  const ICONE_BAIXADAS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5-9 9"/></svg>';
  const ICONE_ZIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/></svg>';
  const ICONE_ALERTA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const ICONE_PENDENTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';

  // PEDIDO DO USUÁRIO (2026-09-12, mockup "CatálogoPro"): 6 cards de KPI em
  // vez de 5 — trocou "Fotos suspeitas" (que já tem coluna+filtro próprios
  // na tabela de Seções) por "Fotos pendentes" (produtos - com foto real) e
  // "Erros" (soma de s.erros — dado novo, ver Fix 2 de hoje). Os dois cards
  // com "% do total" ganham a mesma barrinha de progresso do mockup — só
  // com número real, nada inventado (sem trend "vs mês anterior": não temos
  // histórico salvo pra calcular isso, ver comentário no card Execução).
  function renderStats() {
    // totalProdutosUnicos vem do backend (dedup por código, ver server.js) —
    // uma peça pode aparecer em 2 seções, então a soma bruta de s.produtos
    // conta ela 2x. Fallback pra soma bruta só se o backend ainda não
    // mandou o campo (versão antiga do server rodando).
    const totalProdutos = totalProdutosUnicos || secoes.reduce((a, s) => a + s.produtos, 0);
    // `totalComFotoUnicos` vem do backend já deduplicado por código (ver
    // contarComFotoUnicos em server.js) — a soma bruta de comFotoReal conta
    // 2x a peça que está em duas seções e fazia o card passar de 100% e
    // zerar "Fotos pendentes". Fallback pra soma bruta só se o servidor
    // ainda for de uma versão anterior.
    const totalBaixados = typeof totalComFotoUnicos === 'number'
      ? totalComFotoUnicos
      : secoes.reduce((a, s) => a + s.comFotoReal, 0);
    const totalPendentes = Math.max(0, totalProdutos - totalBaixados);
    const precisamZip = secoes.filter((s) => s.precisaZip).length;
    const totalErros = secoes.reduce((a, s) => a + (s.erros || 0), 0);
    const pctBaixado = totalProdutos ? Math.round((totalBaixados / totalProdutos) * 100) : 0;
    const pctPendente = totalProdutos ? Math.round((totalPendentes / totalProdutos) * 100) : 0;

    el('stats-row').innerHTML = `
      <div class="stat-card stat-card--rico acento-azul">
        <div class="stat-icone">${ICONE_SECOES}</div>
        <div class="valor">${secoes.length}</div>
        <div class="rotulo">Seções</div>
      </div>
      <div class="stat-card stat-card--rico acento-roxo">
        <div class="stat-icone">${ICONE_PRODUTOS}</div>
        <div class="valor">${totalProdutos.toLocaleString('pt-BR')}</div>
        <div class="rotulo">Produtos no catálogo</div>
      </div>
      <div class="stat-card stat-card--rico acento-verde">
        <div class="stat-icone">${ICONE_BAIXADAS}</div>
        <div class="valor">${totalBaixados.toLocaleString('pt-BR')}</div>
        <div class="rotulo">Com foto no catálogo</div>
        <div class="stat-progress"><div class="stat-progress-fill" style="width:${pctBaixado}%"></div></div>
        <div class="stat-sub">${pctBaixado}% do total</div>
      </div>
      <div class="stat-card stat-card--rico">
        <div class="stat-icone">${ICONE_PENDENTE}</div>
        <div class="valor">${totalPendentes.toLocaleString('pt-BR')}</div>
        <div class="rotulo">Produtos sem foto</div>
        <div class="stat-progress"><div class="stat-progress-fill stat-progress-fill--amber" style="width:${pctPendente}%"></div></div>
        <div class="stat-sub">${pctPendente}% do total</div>
      </div>
      <div class="stat-card stat-card--rico ${precisamZip ? 'alerta' : ''}">
        <div class="stat-icone">${ICONE_ZIP}</div>
        <div class="valor">${precisamZip}</div>
        <div class="rotulo">Precisam de zip</div>
      </div>
      <div class="stat-card stat-card--rico ${totalErros ? 'risco' : ''}">
        <div class="stat-icone">${ICONE_ALERTA}</div>
        <div class="valor">${totalErros}</div>
        <div class="rotulo">Erros</div>
      </div>
    `;
  }

  // ─── Filtro + tabela de seções ────────────────────────────────────
  function secoesVisiveis() {
    return secoes.filter((s) => {
      if (filtroTexto && !s.label.toLowerCase().includes(filtroTexto) && !s.slug.includes(filtroTexto)) return false;
      if (filtroRapido === 'incompletas') return s.produtos > 0 && s.comFotoReal < s.produtos;
      if (filtroRapido === 'precisa-zip') return s.precisaZip;
      // PEDIDO DO USUÁRIO (2026-09-12): antes não tinha jeito de achar
      // seções com erro técnico sem rolar o log bruto de uma execução —
      // ver comentário em statusSecoes() (server.js).
      if (filtroRapido === 'com-erro') return (s.erros || 0) > 0;
      if (filtroRapido === 'suspeitas') return s.pequenas > 0;
      return true;
    });
  }

  function renderTabela() {
    const visiveis = secoesVisiveis();
    el('contador-secoes').textContent = `${visiveis.length}/${secoes.length}`;
    const tbody = el('tabela-secoes');

    if (!visiveis.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Nenhuma seção bate com esse filtro.</td></tr>`;
      atualizarRodapePaginacao(0, 0);
      return;
    }

    // Paginação simples (2026-08-11): mostra só as N primeiras por padrão
    // e deixa expandir sob pedido, em vez de tabela rolável sempre cheia.
    const mostrar = secoesExpandido ? visiveis : visiveis.slice(0, LIMITE_SECOES_VISIVEIS);

    tbody.innerHTML = mostrar.map((s) => {
      const publicadoOk = s.publicados >= s.comFotoReal && s.comFotoReal > 0;
      // PEDIDO DO USUÁRIO (2026-09-12): antes o badge amber só mostrava
      // s.publicados (o número JÁ publicado, desatualizado por definição
      // quando precisaZip é true) com o rótulo "precisa build-zip" — não
      // dava pra saber QUANTAS fotos reais estavam esperando o zip ser
      // remontado. Agora mostra os dois números.
      const badgePublicado = s.produtos === 0
        ? '<span class="valor-plano v-muted">sem dados</span>'
        : s.precisaZip
          ? `<span class="valor-plano v-ambar">${escapeHtml(s.publicados)} → ${escapeHtml(s.comFotoReal)} prontas, precisa build-zip</span>`
          : `<span class="valor-plano ${publicadoOk ? 'v-verde' : 'v-muted'}">${escapeHtml(s.publicados)}</span>`;
      const badgeErros = (s.erros || 0) > 0
        ? `<span class="valor-plano v-vermelho">${escapeHtml(s.erros)}</span>`
        : '<span class="valor-plano v-muted">0</span>';
      const badgePequenas = s.pequenas > 0
        ? `<span class="valor-plano v-vermelho">${escapeHtml(s.pequenas)} suspeita(s)</span>`
        : '<span class="valor-plano v-muted">0</span>';
      // PEDIDO DO USUÁRIO (2026-09-12, mockup "CatálogoPro"): dot de status
      // rápido — vermelho se tem erro, âmbar se falta zip, verde se 100%
      // processada e publicada, cinza se a seção ainda não tem dado (json
      // vazio, ex: "consumo" antes da 1ª extração).
      const corDot = s.produtos === 0 ? '' : (s.erros || 0) > 0 ? 'risco' : s.precisaZip ? 'alerta' : (s.comFotoReal >= s.produtos ? 'ok' : '');
      const selecionada = selecionadas.has(s.slug);
      // PEDIDO DO USUÁRIO (2026-09-12, mockup "CatálogoPro"): clicar na
      // linha (fora do checkbox) abre o drill-down de Produtos dessa Seção
      // — ver listener em "tabela-secoes" mais abaixo e abrirModalProdutos().
      return `
        <tr class="${selecionada ? 'selecionada' : ''} tr-clicavel" data-slug-linha="${escapeHtml(s.slug)}" title="Clique pra ver os produtos desta seção">
          <td><input type="checkbox" data-slug="${escapeHtml(s.slug)}" ${selecionada ? 'checked' : ''}></td>
          <td><span class="status-dot-mini ${corDot}"></span>${escapeHtml(s.label)}<div class="cell-slug">${escapeHtml(s.slug)}</div></td>
          <td>${escapeHtml(s.produtos)}</td>
          <td>${escapeHtml(s.baixados)}/${escapeHtml(s.produtos)}</td>
          <td>${badgePublicado}</td>
          <td>${badgeErros}</td>
          <td>${badgePequenas}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selecionadas.add(cb.dataset.slug);
        else selecionadas.delete(cb.dataset.slug);
        cb.closest('tr').classList.toggle('selecionada', cb.checked);
        atualizarResumoSelecao();
      });
    });

    atualizarRodapePaginacao(mostrar.length, visiveis.length);
  }

  function atualizarRodapePaginacao(mostrando, total) {
    const rodape = el('tabela-rodape');
    if (!rodape) return;
    if (total <= LIMITE_SECOES_VISIVEIS) { rodape.style.display = 'none'; return; }
    rodape.style.display = 'flex';
    el('tabela-rodape-texto').textContent = `Mostrando ${mostrando} de ${total} seções`;
    el('btn-ver-todas').textContent = secoesExpandido ? 'Mostrar menos' : 'Ver todas as seções';
  }

  // ─── Modal de Produtos por Seção (2026-09-12, drill-down "CatálogoPro") ──
  // PEDIDO DO USUÁRIO: clicar numa linha da tabela de Seções abre a lista
  // de produtos DAQUELA seção (thumbnail/código/descrição/linha/status),
  // em vez de carregar os ~19 mil produtos do catálogo inteiro de uma vez.
  let modalProdutosSlug = null;
  let modalProdutosLista = [];
  let modalProdutosFiltro = '';
  let modalProdutosFiltroStatus = 'todas';
  let modalProdutosPagina = 0;
  const LIMITE_PRODUTOS_MODAL_POR_PAGINA = 20;

  // PEDIDO DO USUÁRIO (2026-09-12, redesign): status como ponto colorido +
  // texto simples, sem pill de fundo (ver .valor-plano/.status-dot-mini) —
  // dotClasse vazia = cinza neutro (default de .status-dot-mini).
  const STATUS_PRODUTO_INFO = {
    ok: { texto: 'Completo', dotClasse: 'ok' },
    sem_foto: { texto: 'Sem foto no X2', dotClasse: '' },
    placeholder: { texto: 'Placeholder', dotClasse: '' },
    erro: { texto: 'Erro', dotClasse: 'risco' },
    pendente: { texto: 'Pendente', dotClasse: '' },
  };

  // Chips de status (2026-09-12, mockup): "Precisa de zip" do mockup original
  // é conceito de SEÇÃO (build do zip), não de produto individual — não dá
  // pra filtrar por isso aqui sem inventar um estado que não existe por
  // produto. Ficou de fora; os 4 chips abaixo são os que têm dado real por
  // produto (status do scraper + fotosSuspeitas() já calculada no backend).
  const FILTROS_STATUS_MODAL = [
    { id: 'todas', label: 'Todas' },
    { id: 'ok', label: 'Completo' },
    { id: 'sem-foto', label: 'Sem foto' },
    { id: 'erro', label: 'Erro' },
    { id: 'suspeita', label: 'Fotos suspeitas' },
  ];

  function _contarPorStatusModal() {
    const c = { todas: modalProdutosLista.length, ok: 0, 'sem-foto': 0, erro: 0, suspeita: 0 };
    for (const p of modalProdutosLista) {
      if (p.status === 'ok') c.ok++;
      else if (p.status === 'erro') c.erro++;
      else c['sem-foto']++;
      if (p.fotoSuspeita) c.suspeita++;
    }
    return c;
  }

  function renderChipsModalProdutos() {
    const contagem = _contarPorStatusModal();
    el('modal-produtos-filtro-chips').innerHTML = FILTROS_STATUS_MODAL.map((f) => `
      <span class="chip ${modalProdutosFiltroStatus === f.id ? 'active' : ''}" data-filtro-status-modal="${f.id}">${escapeHtml(f.label)} <span class="chip-contador">${contagem[f.id]}</span></span>
    `).join('');
  }

  function _produtosModalFiltrados() {
    let lista = modalProdutosLista;
    if (modalProdutosFiltroStatus === 'ok') lista = lista.filter((p) => p.status === 'ok');
    else if (modalProdutosFiltroStatus === 'erro') lista = lista.filter((p) => p.status === 'erro');
    else if (modalProdutosFiltroStatus === 'sem-foto') lista = lista.filter((p) => p.status !== 'ok' && p.status !== 'erro');
    else if (modalProdutosFiltroStatus === 'suspeita') lista = lista.filter((p) => p.fotoSuspeita);
    if (!modalProdutosFiltro) return lista;
    const termo = modalProdutosFiltro.toLowerCase();
    return lista.filter((p) =>
      String(p.codigo).toLowerCase().includes(termo) || String(p.nome || '').toLowerCase().includes(termo)
    );
  }

  function renderModalProdutos() {
    const filtrados = _produtosModalFiltrados();
    const totalPaginas = Math.max(1, Math.ceil(filtrados.length / LIMITE_PRODUTOS_MODAL_POR_PAGINA));
    modalProdutosPagina = Math.min(modalProdutosPagina, totalPaginas - 1);
    const inicio = modalProdutosPagina * LIMITE_PRODUTOS_MODAL_POR_PAGINA;
    const pagina = filtrados.slice(inicio, inicio + LIMITE_PRODUTOS_MODAL_POR_PAGINA);

    const tbody = el('modal-produtos-tbody');
    if (!filtrados.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Nenhum produto bate com esse filtro.</td></tr>`;
    } else {
      tbody.innerHTML = pagina.map((p) => {
        const info = STATUS_PRODUTO_INFO[p.status] || STATUS_PRODUTO_INFO.pendente;
        const thumb = p.temThumb
          ? `<img class="thumb-produto" src="/api/secoes/${encodeURIComponent(modalProdutosSlug)}/produtos/${encodeURIComponent(p.codigo)}/thumb" alt="">`
          : `<div class="thumb-produto-vazio" title="Sem foto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5-9 9"/></svg></div>`;
        const rotuloAcao = p.status === 'ok' ? 'Reprocessar' : p.status === 'pendente' ? 'Baixar agora' : 'Tentar de novo';
        // Contagem real de arquivos baixados (não é "X de Y esperado" — não
        // temos esse total do X2). Ponto âmbar avisa quando alguma dessas
        // fotos está abaixo do tamanho mínimo (fotoSuspeita, calculado no
        // backend com a mesma função já usada no agregado por seção).
        const fotosTexto = p.numFotos > 0
          ? `${escapeHtml(p.numFotos)} foto${p.numFotos > 1 ? 's' : ''}`
          : p.fotoCatalogo
            // Produto sem nada no staging do scraper, mas COM foto já
            // publicada no catálogo (zip antigo ou foto manual) — é essa
            // que sai no PDF, então a linha precisa dizer isso em vez de
            // mostrar "—" ao lado de uma miniatura que aparece na tela.
            ? '<span title="Foto já publicada no catálogo (zip ou envio manual), não baixada nesta rodada">do catálogo</span>'
            : '—';
        const fotosSuspeitaMarca = p.fotoSuspeita
          ? ` <span class="status-dot-mini alerta" title="Alguma foto abaixo do tamanho mínimo"></span>`
          : '';
        const verFotoBtn = p.temThumb
          ? `<a class="icon-btn" href="/api/secoes/${encodeURIComponent(modalProdutosSlug)}/produtos/${encodeURIComponent(p.codigo)}/thumb" target="_blank" rel="noopener" title="Ver foto ampliada"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg></a>`
          : '';
        return `
          <tr>
            <td>${thumb}</td>
            <td>${escapeHtml(p.codigo)}</td>
            <td>${escapeHtml(p.nome)}</td>
            <td>${escapeHtml(p.linha || '—')}</td>
            <td>${fotosTexto}${fotosSuspeitaMarca}</td>
            <td><span class="status-dot-mini ${info.dotClasse}"></span>${info.texto}</td>
            <td class="modal-produtos-acoes">${verFotoBtn}<button class="small ghost" data-retentar-codigo="${escapeHtml(p.codigo)}">${rotuloAcao}</button></td>
          </tr>
        `;
      }).join('');
    }

    const rodape = el('modal-produtos-paginacao');
    if (totalPaginas > 1) {
      rodape.style.display = 'flex';
      el('modal-produtos-paginacao-texto').textContent = `${filtrados.length} produto(s)`;
      el('modal-produtos-pagina-info').textContent = `${modalProdutosPagina + 1} / ${totalPaginas}`;
      el('modal-produtos-pag-anterior').disabled = modalProdutosPagina === 0;
      el('modal-produtos-pag-proxima').disabled = modalProdutosPagina >= totalPaginas - 1;
    } else {
      rodape.style.display = 'none';
    }
  }

  async function abrirModalProdutos(slug, codigoParaDestacar) {
    modalProdutosSlug = slug;
    modalProdutosFiltro = codigoParaDestacar ? String(codigoParaDestacar) : '';
    modalProdutosFiltroStatus = 'todas';
    modalProdutosPagina = 0;
    el('modal-produtos-busca').value = modalProdutosFiltro;
    el('modal-produtos-titulo').textContent = 'Produtos';
    el('modal-produtos-subtitulo').textContent = 'Carregando...';
    el('modal-produtos-filtro-chips').innerHTML = '';
    el('modal-produtos-tbody').innerHTML = `<tr><td colspan="7" class="skeleton">Carregando...</td></tr>`;
    el('modal-produtos-paginacao').style.display = 'none';
    // PEDIDO DO USUÁRIO (2026-09-12): parou de ser modal por cima da tela —
    // agora troca de view inline no lugar de #layout-secoes (Seções/Ação/
    // Execução), com botão Voltar no topo em vez de fechar um overlay.
    el('layout-secoes').style.display = 'none';
    el('produtos-secao-view').style.display = 'block';

    try {
      const res = await fetch(`/api/secoes/${encodeURIComponent(slug)}/produtos`);
      if (!res.ok) {
        // Antes mostrava sempre "Não achei essa seção." mesmo quando o erro
        // era outra coisa (ex: servidor não reiniciado após mudança no
        // backend) — agora mostra o status/erro real pra dar pra diagnosticar.
        const dataErro = await res.json().catch(() => ({}));
        throw new Error(dataErro.error || `Erro ${res.status} ao buscar produtos desta seção.`);
      }
      const data = await res.json();
      modalProdutosLista = data.produtos || [];
      el('modal-produtos-titulo').textContent = `Produtos — ${data.label}`;
      el('modal-produtos-subtitulo').textContent = `${modalProdutosLista.length} produto(s) cadastrados nesta seção.`;
      renderChipsModalProdutos();
      renderModalProdutos();
    } catch (err) {
      el('modal-produtos-subtitulo').textContent = '';
      el('modal-produtos-tbody').innerHTML = `<tr><td colspan="7" class="table-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function fecharModalProdutos() {
    el('produtos-secao-view').style.display = 'none';
    el('layout-secoes').style.display = '';
    modalProdutosSlug = null;
    modalProdutosLista = [];
  }

  el('tabela-secoes').addEventListener('click', (ev) => {
    if (ev.target.closest('input[type="checkbox"]')) return;
    const tr = ev.target.closest('tr[data-slug-linha]');
    if (!tr) return;
    abrirModalProdutos(tr.dataset.slugLinha);
  });

  el('produtos-secao-voltar').addEventListener('click', fecharModalProdutos);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && el('produtos-secao-view').style.display !== 'none') fecharModalProdutos();
  });
  el('modal-produtos-busca').addEventListener('input', (ev) => {
    modalProdutosFiltro = ev.target.value.trim();
    modalProdutosPagina = 0;
    renderModalProdutos();
  });
  el('modal-produtos-filtro-chips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-filtro-status-modal]');
    if (!chip) return;
    modalProdutosFiltroStatus = chip.dataset.filtroStatusModal;
    modalProdutosPagina = 0;
    renderChipsModalProdutos();
    renderModalProdutos();
  });
  el('modal-produtos-pag-anterior').addEventListener('click', () => { modalProdutosPagina--; renderModalProdutos(); });
  el('modal-produtos-pag-proxima').addEventListener('click', () => { modalProdutosPagina++; renderModalProdutos(); });

  el('modal-produtos-tbody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-retentar-codigo]');
    if (!btn || !modalProdutosSlug) return;
    const codigo = btn.dataset.retentarCodigo;
    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = 'Enviando...';
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'baixar', secoes: [modalProdutosSlug], opcoes: { retrySemFoto: true, codigosEspecificos: [codigo] } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar nova tentativa.', 'erro');
      btn.disabled = false;
      btn.textContent = textoOriginal;
      return;
    }
    mostrarToast(`Reprocessando ${codigo} — acompanhe em "Execução".`);
    fecharModalProdutos();
    el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
  });

  function atualizarResumoSelecao() {
    el('resumo-selecao-n').textContent = selecionadas.size;
    // "Sync" (e as outras ações por seção) não funcionam sem nada marcado
    // na tabela — mostra um aviso claro em vez de deixar a pessoa clicar
    // e só descobrir pelo toast de erro depois (ver mostrarToast()).
    // PEDIDO DO USUÁRIO (2026-09-12): o modo "Apenas lançamentos" (dentro
    // do mesmo acordeão "Cadastrar produtos") NUNCA depende de seção
    // marcada — só mostra esse aviso quando o modo ativo é "Seções
    // marcadas" (padrão quando o toggle nem existe ainda, ex: HTML antigo
    // em cache).
    const modoSyncAtual = document.querySelector('#sync-modo-chips .chip.active')?.dataset.syncModo || 'secoes';
    const avisoSync = el('sync-aviso-selecao');
    if (avisoSync) avisoSync.style.display = (!selecionadas.size && acaoAtiva === 'sync' && modoSyncAtual === 'secoes') ? 'block' : 'none';
    // Toolbar (Selecionar visíveis/Limpar seleção) e a barra "N selecionada(s)"
    // só fazem sentido depois que já tem algo marcado — ficam ocultos até lá.
    const toolbar = el('selecao-toolbar');
    if (toolbar) toolbar.style.display = selecionadas.size ? 'flex' : 'none';
    const resumo = el('selecao-resumo');
    if (resumo) resumo.style.display = selecionadas.size ? 'flex' : 'none';
  }

  function horaAgora() {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function carregarStatus() {
    const res = await fetch('/api/status');
    const data = await res.json();
    secoes = data.secoes;
    totalProdutosUnicos = data.totalProdutosUnicos || 0;
    totalComFotoUnicos = typeof data.totalComFotoUnicos === 'number' ? data.totalComFotoUnicos : null;
    renderStats();
    renderTabela();
    atualizarResumoSelecao();
    const horaEl = el('catalogo-sync-hora');
    if (horaEl) horaEl.textContent = `Última atualização: hoje às ${horaAgora()}`;
  }

  // ─── Ações Rápidas (acordeão) ───────────────────────────────────────
  // tab === null fecha tudo (clicar de novo na linha já aberta) — ver
  // listener de clique logo abaixo, que decide null vs. tab.
  function trocarAba(tab) {
    acaoAtiva = tab;
    document.querySelectorAll('.acao-rapida').forEach((item) => {
      item.classList.toggle('aberta', tab !== null && item.dataset.acaoRapida === tab);
    });
    atualizarResumoSelecao();
  }

  // ─── Estado de execução (via SSE) ──────────────────────────────────
  function aplicarBotoesDesabilitados() {
    document.querySelectorAll('[data-action]').forEach((b) => {
      if (['baixar', 'sync', 'drive-enviar', 'fotos-codigos'].includes(b.dataset.action)) b.disabled = rodando;
    });
  }

  let statusTimeoutId = null;
  let rodandoAnterior = false;
  // Resumo "Última execução" do card Execução parado (2026-08-11) — só
  // client-side, calculado a partir do que o SSE já manda (tipo + a última
  // linha "[N/M]" que o scraper escreve no log). Não persiste entre F5 e
  // não tem "produtos cadastrados" pra ações que não imprimem [N/M] — nesse
  // caso o resumo mostra só quando/duração. Ver comentário no HTML.
  let execucaoInicio = null;
  let ultimoProgressoObservado = null;
  let ultimaExecucao = null;

  function formatarDuracao(ms) {
    const totalSeg = Math.round(ms / 1000);
    const h = Math.floor(totalSeg / 3600);
    const m = Math.floor((totalSeg % 3600) / 60);
    const s = totalSeg % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function atualizarResumoExecucaoIdle() {
    const grid = el('execucao-resumo-grid');
    if (!grid) return;
    if (!ultimaExecucao) { grid.style.display = 'none'; return; }
    grid.style.display = 'grid';
    el('resumo-quando').textContent = `Hoje às ${ultimaExecucao.terminadoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    el('resumo-itens').textContent = ultimaExecucao.progresso ? `${ultimaExecucao.progresso.feito}/${ultimaExecucao.progresso.total}` : '–';
    el('resumo-duracao').textContent = formatarDuracao(ultimaExecucao.duracaoMs);
  }

  function aplicarEstadoExecucao(payload) {
    const estavaRodando = rodando;
    rodando = !!payload.rodando;
    aplicarBotoesDesabilitados();
    // Marca o estado no <body> pro CSS desenhar o trilho de execução no
    // topo (ver .x2-rodando em style.css) — a pessoa precisa ver que o
    // painel está ocupado de qualquer ponto da rolagem.
    document.body.classList.toggle('x2-rodando', rodando);

    if (rodando && !estavaRodando) {
      execucaoInicio = { tipo: payload.tipo, inicio: Date.now() };
      ultimoProgressoObservado = null;
    }
    // 2026-08-07 — só mostra "Cancelar/destravar" quando tem algo rodando
    // de verdade (ver /api/cancelar em server.js); nos outros estados fica
    // escondido pra não confundir com um botão de uso normal.
    el('btn-cancelar').style.display = rodando ? 'inline-block' : 'none';

    const statusEl = el('status-execucao');
    clearTimeout(statusTimeoutId);

    if (payload.erro) {
      statusEl.innerHTML = `<span class="status-dot"></span> Erro: ${escapeHtml(payload.erro)}`;
      statusEl.className = 'status-line erro';
    } else if (rodando) {
      // Pedido do usuário (2026-09-11): o cadastro disparado automaticamente
      // depois de Lançamentos (tipo "sync" por baixo dos panos) mostra como
      // "Cadastro Lançamentos" aqui — nome específico mandado pelo servidor
      // em `payload.rotulo` (ver rodarAcao/transmitir em server.js) — em vez
      // do nome genérico "Sync" que o Sync manual (por seção) continua
      // usando.
      statusEl.innerHTML = `<span class="status-dot"></span> Rodando: ${escapeHtml(payload.rotulo || ROTULOS_TIPO_ACAO[payload.tipo] || payload.tipo)}...`;
      statusEl.className = 'status-line rodando';
    } else if (rodandoAnterior) {
      // Pedido do usuário (2026-08-06): dar um retorno visual claro quando
      // uma ação termina, em vez de só voltar pro texto neutro em silêncio.
      statusEl.innerHTML = `<span class="status-dot"></span> Concluído — números atualizados.`;
      statusEl.className = 'status-line concluido';
      statusTimeoutId = setTimeout(() => {
        statusEl.innerHTML = `<span class="status-dot"></span> Nada rodando agora.`;
        statusEl.className = 'status-line';
      }, 6000);
      carregarStatus(); // ação terminou — atualiza os números da tabela/resumo

      if (execucaoInicio) {
        ultimaExecucao = {
          tipo: execucaoInicio.tipo,
          terminadoEm: new Date(),
          duracaoMs: Date.now() - execucaoInicio.inicio,
          progresso: ultimoProgressoObservado,
        };
        execucaoInicio = null;
        atualizarResumoExecucaoIdle();
      }
    } else {
      statusEl.innerHTML = `<span class="status-dot"></span> Nada rodando agora.`;
      statusEl.className = 'status-line';
    }
    rodandoAnterior = rodando;

    const banner = el('banner-aguardando');
    if (payload.aguardando) {
      el('banner-texto').textContent = payload.aguardando;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }

    // Pedido original do usuário: barra de progresso ao vivo, não só texto
    // — lê a última linha "[N/M]" que o scraper já escreve (ver
    // x2-fotos-scraper.js), sem precisar de nenhum dado novo do backend.
    const progressoWrap = el('progresso-wrap');
    const match = rodando && payload.texto ? [...payload.texto.matchAll(/\[(\d+)\/(\d+)\]/g)].pop() : null;
    if (match) {
      const feito = Number(match[1]);
      const total = Number(match[2]);
      const pct = total > 0 ? Math.min(100, Math.round((feito / total) * 100)) : 0;
      el('progresso-bar-fill').style.width = `${pct}%`;
      el('progresso-label').textContent = `${feito}/${total} (${pct}%)`;
      progressoWrap.classList.add('show');
      ultimoProgressoObservado = { feito, total };
    } else if (!rodando) {
      progressoWrap.classList.remove('show');
    }

    // Card "Execução" — esconde o estado "parado" (ícone+resumo) enquanto
    // tem algo rodando ou com erro ativo, pra não competir visualmente com
    // status-line/log logo abaixo.
    const idleEl = el('execucao-idle');
    if (idleEl) idleEl.style.display = (!rodando && !payload.erro) ? 'block' : 'none';

    if (payload.texto) {
      const logEl = el('log');
      logEl.textContent = payload.texto;
      logEl.scrollTop = logEl.scrollHeight;
    }

    // Reflete o estado global de execução no KPI "Em execução agora" da
    // aba Rotinas (2026-08-07) — só atualiza se os elementos existirem
    // (aba já foi aberta ao menos uma vez nesta sessão).
    const emExecucaoEl = el('rotinas-stat-em-execucao');
    if (emExecucaoEl) emExecucaoEl.textContent = rodando ? '1' : '0';
  }

  function conectarSSE() {
    const es = new EventSource('/api/log-stream');
    es.onmessage = (ev) => aplicarEstadoExecucao(JSON.parse(ev.data));
    es.onerror = () => { /* reconecta sozinho, comportamento padrão do EventSource */ };
  }

  // Mesma regra do servidor (fotos-codigos.js): separa por linha/virgula/ponto e virgula/espaco.
  function lerCodigosColados() {
    const vistos = new Set();
    const lista = [];
    for (const parte of String(el('fotos-codigos-lista').value || '').split(/[\s,;]+/)) {
      const c = parte.trim().replace(/^["']+|["']+$/g, '');
      if (c && !vistos.has(c)) { vistos.add(c); lista.push(c); }
    }
    return lista;
  }
  el('fotos-codigos-lista').addEventListener('input', () => {
    const n = lerCodigosColados().length;
    el('fotos-codigos-contador').textContent = `${n} código${n === 1 ? '' : 's'}`;
  });

  async function dispararAcao(tipo, opcoes) {
    if (!selecionadas.size) {
      mostrarToast('Selecione ao menos uma seção.', 'aviso');
      return;
    }
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, secoes: Array.from(selecionadas), opcoes }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar ação.', 'erro');
    }
  }

  // ─── Eventos ────────────────────────────────────────────────────
  el('busca-secao').addEventListener('input', (ev) => {
    filtroTexto = ev.target.value.trim().toLowerCase();
    secoesExpandido = false;
    renderTabela();
  });

  el('filtro-chips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    filtroRapido = chip.dataset.filtro;
    secoesExpandido = false;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderTabela();
  });

  el('btn-ver-todas').addEventListener('click', () => {
    secoesExpandido = !secoesExpandido;
    renderTabela();
  });

  el('acoes-rapidas').addEventListener('click', (ev) => {
    const linha = ev.target.closest('.acao-rapida-linha');
    if (!linha) return;
    const item = linha.closest('.acao-rapida');
    const jaAberta = item && item.classList.contains('aberta');
    trocarAba(jaAberta ? null : linha.dataset.tab);
    if (!jaAberta && linha.dataset.tab === 'drive-enviar') carregarFabricantesDrive();
  });

  let fabricantesDriveCarregados = false;
  async function carregarFabricantesDrive() {
    const box = el('drive-fab-lista');
    if (!box || fabricantesDriveCarregados) return;
    box.textContent = 'Carregando…';
    try {
      const res = await fetch('/api/drive/fabricantes');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { box.textContent = data.error || 'Não consegui carregar a lista de fabricantes.'; return; }
      box.textContent = '';
      for (const f of data.fabricantes || []) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = f.nome;
        label.appendChild(input);
        // O `value` dessa opção é um sentinel interno (ver
        // PSEUDO_FABRICANTE_DIVERSOS em catalogo-x2.service.js) e estava
        // vazando cru pra tela como "__DIVERSOS_TODOS_FABRICANTES__". O
        // value continua igual (é o que o backend espera de volta); só o
        // rótulo vira o nome que o resto do sistema já usa.
        const rotulo = f.nome === '__DIVERSOS_TODOS_FABRICANTES__'
          ? 'Diversos (todos os fabricantes)'
          : f.nome;
        label.appendChild(document.createTextNode(' ' + rotulo + (f.mecanica ? ' (Mecânica)' : '')));
        box.appendChild(label);
      }
      fabricantesDriveCarregados = true;
    } catch (e) {
      box.textContent = 'Não consegui carregar a lista de fabricantes.';
    }
  }

  // PEDIDO DO USUÁRIO (2026-09-12): toggle "Seções marcadas" / "Apenas
  // lançamentos" dentro do acordeão "Cadastrar produtos" — troca qual
  // bloco de campos/botão aparece (sync por seção vs. diff-estoque por
  // código), sem sair do acordeão.
  const syncModoChips = el('sync-modo-chips');
  if (syncModoChips) {
    syncModoChips.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.chip');
      if (!chip) return;
      syncModoChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      const modo = chip.dataset.syncModo;
      el('sync-modo-secoes-campos').style.display = modo === 'lancamentos' ? 'none' : '';
      el('sync-modo-lancamentos-campos').style.display = modo === 'lancamentos' ? '' : 'none';
      atualizarResumoSelecao(); // reavalia o aviso de seleção, que agora também depende do modo
    });
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;

    if (btn.dataset.action === 'selecionar-visiveis') {
      secoesVisiveis().forEach((s) => selecionadas.add(s.slug));
      renderTabela(); atualizarResumoSelecao();
      return;
    }
    if (btn.dataset.action === 'limpar-selecao') {
      selecionadas.clear();
      renderTabela(); atualizarResumoSelecao();
      return;
    }
    if (btn.dataset.action === 'baixar') {
      const reiniciar = el('opt-reiniciar').checked;
      // Pedido do usuário: opção destrutiva (apaga progresso já baixado)
      // pede confirmação extra em vez de disparar direto no clique.
      if (reiniciar && !confirm(`Isso apaga o progresso já salvo das ${selecionadas.size} seção(ões) selecionada(s) e baixa tudo de novo do zero. Confirma?`)) return;
      // PEDIDO DO USUÁRIO (2026-09-12): removidos "Limite por seção" (nunca
      // usado) e "Só estes códigos" — código específico agora se retenta
      // direto pelo drill-down da Seção (ver modal-produtos-tbody mais
      // abaixo, que já manda codigosEspecificos: [codigo] pro mesmo /api/acao).
      dispararAcao('baixar', {
        retrySemFoto: el('opt-retry-sem-foto').checked,
        reiniciar,
        rebaixarTudo: !reiniciar && el('opt-rebaixar-tudo').checked,
      });
      return;
    }
    // PEDIDO DO USUARIO (2026-10-17): lista de codigos colada -> procura no X2 e baixa
    // a foto de cada um (cadastra antes os que ainda nao existem no catalogo).
    if (btn.dataset.action === 'fotos-codigos') {
      const codigos = lerCodigosColados();
      if (!codigos.length) { mostrarToast('Cole ao menos um código.', 'aviso'); return; }
      fetch('/api/fotos-por-codigos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigos, refazer: el('opt-fotos-codigos-refazer').checked }),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { mostrarToast(data.error || 'Erro ao iniciar.', 'erro'); return; }
        const extra = data.novos ? ` (${data.novos} novo(s) serão cadastrados antes)` : '';
        mostrarToast(`Buscando fotos de ${data.total} código(s)${extra}.`, 'sucesso');
      }).catch(() => mostrarToast('Erro de conexão.', 'erro'));
      return;
    }
    if (btn.dataset.action === 'sync') {
      const forcarRemocao = el('opt-forcar-remocao').checked;
      if (forcarRemocao && !confirm('Isso força a remoção em massa mesmo se for muita coisa de uma vez (trava de segurança normalmente bloquearia). Confirma?')) return;
      dispararAcao('sync', {
        dryRun: el('opt-dry-run').checked,
        semRemover: !el('opt-remover-desativados').checked,
        forcarRemocao,
      });
      return;
    }
    // PEDIDO DO USUÁRIO (2026-09-12): botão "Montar zip" tinha sumido do
    // painel — ficou pra trás na reforma de Ações Rápidas em acordeão
    // (só "baixar"/"sync" foram migrados pro novo formato, esse aqui não).
    // Backend (tipo: 'zip' → montarZipFinal por seção) nunca mudou.
    if (btn.dataset.action === 'drive-fab-todos' || btn.dataset.action === 'drive-fab-nenhum') {
      const marcar = btn.dataset.action === 'drive-fab-todos';
      document.querySelectorAll('#drive-fab-lista input[type="checkbox"]').forEach((c) => { c.checked = marcar; });
      return;
    }
    if (btn.dataset.action === 'drive-enviar') {
      const fabricantes = Array.from(document.querySelectorAll('#drive-fab-lista input:checked')).map((c) => c.value);
      if (!fabricantes.length) { mostrarToast('Escolha pelo menos 1 fabricante.', 'aviso'); return; }
      const dryRun = el('drive-enviar-dry-run').checked;
      if (!dryRun && !confirm(`Gerar e enviar ${fabricantes.length} catálogo(s) ao Drive, substituindo os arquivos atuais. Confirma?`)) return;
      fetch('/api/acao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo: 'drive-enviar', opcoes: { fabricantes, dryRun } }),
      }).then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          mostrarToast(data.error || 'Erro ao iniciar o envio.', 'erro');
        }
      });
      return;
    }
    if (btn.dataset.action === 'zip') {
      dispararAcao('zip', {});
      return;
    }
  });

  el('btn-confirmar').addEventListener('click', async () => {
    await fetch('/api/confirmar', { method: 'POST' });
  });

  // 2026-08-07 — "Cancelar/destravar": libera o painel quando fica preso
  // dizendo "já tem uma ação rodando" mesmo parecendo terminado (causa mais
  // comum: uma execução anterior ficou esperando confirmação numa aba que
  // não estava sendo olhada — ver comentário em cancelarExecucaoAtual() no
  // server.js).
  el('btn-cancelar').addEventListener('click', async () => {
    if (!confirm('Isso libera o painel pra tentar de novo. Se uma janela do Chrome da execução anterior ainda estiver aberta, pode ter que fechar ela manualmente. Confirma?')) return;
    const res = await fetch('/api/cancelar', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao cancelar.', 'erro');
    }
  });

  // ─── Abas de topo (Fotos / Rotinas / Estoque) ─────────────────────
  // 2026-08-11: removido o <h1>/subtítulo fixo no topo do conteúdo (pedido
  // do usuário — "aliás, de todos, acho que nem precisa disso"). A sidebar
  // já mostra rótulo + tooltip por aba, então virou redundante.
  el('top-tabs').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.top-tab');
    if (!tab) return;
    document.querySelectorAll('.top-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.top-painel').forEach((p) => p.classList.toggle('active', p.dataset.topPainel === tab.dataset.topTab));
    if (tab.dataset.topTab === 'rotinas') carregarRotinas();
    if (tab.dataset.topTab === 'estoque') carregarEstoqueExports();
    if (tab.dataset.topTab === 'lancamentos') carregarLancamentosX2();
    if (tab.dataset.topTab === 'qualidade') carregarQualidadeCadastral();
  });

  // ─── Rotinas (2026-08-06) ──────────────────────────────────────────
  let rotinas = [];
  let secoesSelectPreenchido = false;

  function preencherSelectSecoes() {
    // Só preenche 1x quando `secoes` já carregou (vem do /api/status da aba
    // Fotos) — se o usuário for direto pra Rotinas antes disso, tenta de
    // novo a cada carregarRotinas() até secoes existir.
    if (secoesSelectPreenchido || !secoes.length) return;
    el('rotina-secoes').innerHTML = secoes.map((s) => `<option value="${escapeHtml(s.slug)}">${escapeHtml(s.label)}</option>`).join('');
    secoesSelectPreenchido = true;
  }

  function formatarDataHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function mesmoDia(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // Calculado 100% no cliente a partir do que já vem de /api/rotinas — sem
  // endpoint novo no backend (2026-08-07, referência visual pedida pelo
  // usuário). "Em execução agora" reflete o mesmo `rodando` global usado no
  // resto do painel, já que rotina e ação manual compartilham o mesmo
  // executor (só uma coisa roda por vez nesta ferramenta).
  // Quantas vezes a rotina falhou SEGUIDO, da mais recente pra trás — é o
  // número que diz "isto está quebrado", não "deu um erro um dia desses".
  function falhasSeguidas(r) {
    const h = Array.isArray(r.historico) ? r.historico : [];
    let n = 0;
    for (const e of h) { if (e.resultado === 'erro') n += 1; else break; }
    return n;
  }

  function renderRotinasStats() {
    const hoje = new Date();
    const ativas = rotinas.filter((r) => r.ativa).length;
    // Conta EXECUÇÕES, não rotinas: uma rotina a cada 5h roda ~4x por dia e
    // antes aparecia como "1 execução hoje" (só o último resultado era
    // guardado). Agora vem do histórico, com fallback pro jeito antigo
    // enquanto as rotinas existentes ainda não têm histórico gravado.
    let execucoesHoje = 0;
    let falhasHoje = 0;
    for (const r of rotinas) {
      const h = Array.isArray(r.historico) && r.historico.length
        ? r.historico.filter((e) => e.em && mesmoDia(new Date(e.em), hoje))
        : (r.ultimaExecucao && mesmoDia(new Date(r.ultimaExecucao), hoje)
          ? [{ resultado: r.ultimoResultado }]
          : []);
      execucoesHoje += h.length;
      falhasHoje += h.filter((e) => e.resultado === 'erro').length;
    }
    el('rotinas-stat-ativas').textContent = ativas;
    el('rotinas-stat-execucoes-hoje').textContent = execucoesHoje;
    el('rotinas-stat-falhas-hoje').textContent = falhasHoje;
    el('rotinas-stat-em-execucao').textContent = rodando ? '1' : '0';
    el('rotinas-stat-falhas-card').classList.toggle('risco', falhasHoje > 0);
  }

  // Nome amigável de cada tipo de ação/rotina — usado tanto na tabela de
  // Rotinas (coluna "Ação") quanto no status "Rodando: ..." (ver
  // aplicarEstadoExecucao). Extraído pra uma constante só (2026-09-11) pra
  // não duplicar o mapa nos dois lugares.
  const ROTULOS_TIPO_ACAO = { baixar: 'Baixar fotos', sync: 'Sync', estoque: 'Exportar estoque', 'painel-produtos': 'Snapshot Painel', 'diff-estoque': 'Diff Estoque', 'cortes-produtos': 'Alerta: Cortes', 'produtos-parados': 'Alerta: Parados', 'lancamentos-x2': 'Lançamentos X2', 'drive-enviar-semana': 'Reenviar Drive (semana)' };

  function renderTabelaRotinas() {
    el('contador-rotinas').textContent = rotinas.length;
    const tbody = el('tabela-rotinas');
    if (!rotinas.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Nenhuma rotina criada ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = rotinas.map((r) => {
      const labelsSecoes = r.secoes.map((slug) => {
        const s = secoes.find((x) => x.slug === slug);
        return s ? s.label : slug;
      });
      const secoesTexto = labelsSecoes.length > 2
        ? `${labelsSecoes.slice(0, 2).join(', ')} +${labelsSecoes.length - 2}`
        : labelsSecoes.join(', ');
      const quando = r.frequencia === 'horas'
        ? `A cada ${escapeHtml(r.intervaloHoras)}h`
        : r.frequencia === 'semanal'
          ? `${escapeHtml(['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][r.diaSemana] || '—')} às ${escapeHtml(r.horario)}`
          : `Diária às ${escapeHtml(r.horario)}`;
      let resultadoBadge = '<span class="badge badge-muted">nunca rodou</span>';
      if (r.ultimoResultado === 'sucesso') resultadoBadge = `<span class="badge badge-green" title="${escapeHtml(formatarDataHora(r.ultimaExecucao))}">ok</span>`;
      else if (r.ultimoResultado === 'erro') {
        // Uma falha isolada é ruído; falha repetida é rotina parada. O
        // número de falhas seguidas é o que separa os dois casos.
        const seguidas = falhasSeguidas(r);
        const sufixo = seguidas > 1 ? ` ${seguidas}×` : '';
        resultadoBadge = `<span class="badge badge-red" title="${escapeHtml(r.ultimoErro)}">erro${sufixo}</span>`;
      }
      return `
        <tr>
          <td>
            <label class="rotina-toggle">
              <input type="checkbox" data-rotina-toggle="${escapeHtml(r.id)}" ${r.ativa ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </td>
          <td>${escapeHtml(r.nome)}</td>
          <td>${escapeHtml(ROTULOS_TIPO_ACAO[r.tipo] || r.tipo)}</td>
          <td title="${escapeHtml(labelsSecoes.join(', '))}">${escapeHtml(r.tipo === 'estoque' ? (r.opcoes && r.opcoes.estoqueOpcao || 'Com e sem estoque') : r.tipo === 'painel-produtos' ? 'Divergências/Situação' : r.tipo === 'cortes-produtos' ? 'Perda por falta de estoque' : r.tipo === 'produtos-parados' ? 'Curva C sem venda' : r.tipo === 'lancamentos-x2' ? 'Primeira entrada da semana' : (secoesTexto || '—'))}</td>
          <td>${quando}</td>
          <td>${escapeHtml(r.ativa ? formatarDataHora(r.proximaExecucao) : '—')}</td>
          <td>${resultadoBadge} <span class="cell-slug">${escapeHtml(formatarDataHora(r.ultimaExecucao))}</span></td>
          <td style="white-space:nowrap;">
            <button class="small" data-rotina-rodar="${escapeHtml(r.id)}">Testar agora</button>
            <button class="small ghost" data-rotina-excluir="${escapeHtml(r.id)}">Excluir</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function carregarRotinas() {
    preencherSelectSecoes();
    const res = await fetch('/api/rotinas');
    const data = await res.json();
    rotinas = data.rotinas;
    el('rotinas-aviso-credenciais').style.display = data.temCredenciais ? 'none' : 'block';
    renderTabelaRotinas();
    renderRotinasStats();
  }

  el('rotina-frequencia').addEventListener('change', () => {
    const freq = el('rotina-frequencia').value;
    el('rotina-dia-semana-wrap').style.display = freq === 'semanal' ? 'block' : 'none';
    // PEDIDO DO USUÁRIO (2026-09-11): "horas" não tem horário fixo — troca o
    // campo "Horário" pelo campo "Intervalo (horas)" (ver rotinas.js).
    const ehHoras = freq === 'horas';
    el('rotina-horario-wrap').style.display = ehHoras ? 'none' : 'block';
    el('rotina-intervalo-horas-wrap').style.display = ehHoras ? 'block' : 'none';
    el('rotina-intervalo-horas-hint').style.display = ehHoras ? 'block' : 'none';
  });

  el('rotina-tipo').addEventListener('change', () => {
    const tipo = el('rotina-tipo').value;
    const ehEstoque = tipo === 'estoque';
    const semSecoes = tipo === 'estoque' || tipo === 'painel-produtos' || tipo === 'diff-estoque' || tipo === 'cortes-produtos' || tipo === 'produtos-parados' || tipo === 'lancamentos-x2';
    el('rotina-secoes-wrap').style.display = semSecoes ? 'none' : 'block';
    el('rotina-estoque-opcao-wrap').style.display = ehEstoque ? 'block' : 'none';
  });

  document.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-action="criar-rotina"]')) {
      const nome = el('rotina-nome').value.trim();
      const tipo = el('rotina-tipo').value;
      const ehEstoque = tipo === 'estoque';
      const semSecoes = tipo === 'estoque' || tipo === 'painel-produtos' || tipo === 'diff-estoque' || tipo === 'cortes-produtos' || tipo === 'produtos-parados' || tipo === 'lancamentos-x2';
      const secoesEscolhidas = semSecoes ? [] : Array.from(el('rotina-secoes').selectedOptions).map((o) => o.value);
      const frequencia = el('rotina-frequencia').value;
      const diaSemana = Number(el('rotina-dia-semana').value);
      const ehHoras = frequencia === 'horas';
      // PEDIDO DO USUÁRIO (2026-09-11): "horas" valida intervaloHoras em vez
      // de horario — ver rotinas.js/validarRotina.
      const horario = ehHoras ? null : el('rotina-horario').value;
      const intervaloHoras = ehHoras ? Number(el('rotina-intervalo-horas').value) : null;
      const faltaAgendamento = ehHoras
        ? !(Number.isInteger(intervaloHoras) && intervaloHoras >= 1 && intervaloHoras <= 168)
        : !horario;
      if (!nome || (!semSecoes && !secoesEscolhidas.length) || faltaAgendamento) {
        const msgAgendamento = ehHoras ? 'um intervalo em horas (1 a 168) válido' : 'horário';
        mostrarToast(semSecoes ? `Preencha nome e ${msgAgendamento}.` : `Preencha nome, ao menos uma seção e ${msgAgendamento}.`, 'aviso');
        return;
      }
      const opcoes = ehEstoque ? { estoqueOpcao: el('rotina-estoque-opcao').value } : {};
      const res = await fetch('/api/rotinas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, tipo, secoes: secoesEscolhidas, opcoes, frequencia, diaSemana, horario, intervaloHoras }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        mostrarToast(data.error || 'Erro ao criar rotina.', 'erro');
        return;
      }
      el('rotina-nome').value = '';
      await carregarRotinas();
      return;
    }

    const btnRodar = ev.target.closest('[data-rotina-rodar]');
    if (btnRodar) {
      const res = await fetch(`/api/rotinas/${btnRodar.dataset.rotinaRodar}/rodar-agora`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        mostrarToast(data.error || 'Erro ao rodar rotina.', 'erro');
        return;
      }
      // troca pra aba Fotos pra acompanhar o log/progresso ao vivo, já que
      // é o mesmo mecanismo de execução das ações manuais
      el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
      return;
    }

    const btnExcluir = ev.target.closest('[data-rotina-excluir]');
    if (btnExcluir) {
      if (!confirm('Excluir esta rotina?')) return;
      await fetch(`/api/rotinas/${btnExcluir.dataset.rotinaExcluir}`, { method: 'DELETE' });
      await carregarRotinas();
      return;
    }
  });

  document.addEventListener('change', async (ev) => {
    const toggle = ev.target.closest('[data-rotina-toggle]');
    if (!toggle) return;
    await fetch(`/api/rotinas/${toggle.dataset.rotinaToggle}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ativa: toggle.checked }),
    });
    await carregarRotinas();
  });

  // Atualiza a lista de rotinas periodicamente (mostra "última execução"
  // depois que o agendador dispara sozinho de madrugada, sem precisar
  // recarregar a página manualmente).
  setInterval(() => {
    if (document.querySelector('.top-tab[data-top-tab="rotinas"]').classList.contains('active')) carregarRotinas();
  }, 30000);

  // ─── Estoque (2026-08-06) ───────────────────────────────────────────
  function formatarBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function carregarEstoqueExports() {
    const res = await fetch('/api/estoque/exports');
    const data = await res.json();
    const exports = data.exports || [];
    el('contador-estoque-exports').textContent = exports.length;
    const tbody = el('tabela-estoque-exports');
    if (!exports.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Nenhum export ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = exports.map((e) => `
      <tr>
        <td>${escapeHtml(e.nome)}</td>
        <td>${escapeHtml(formatarBytes(e.bytes))}</td>
        <td>${escapeHtml(formatarDataHora(e.modificadoEm))}</td>
        <td><a href="/estoque-files/${encodeURIComponent(e.nome)}" download>Baixar</a></td>
      </tr>
    `).join('');

    // Popula TODOS os selects "Qual CSV usar" — mantém a opção "Mais
    // recente" sempre no topo, o resto na mesma ordem (mais novo primeiro).
    // PEDIDO DO USUÁRIO (2026-09-12): antes só existia 1 select (id
    // "diff-estoque-csv", card "Sincronizar com o Catálogo" na aba
    // Estoque). Agora existe um 2º, gêmeo, dentro do acordeão "Cadastrar
    // produtos" (aba Catálogo, modo "Apenas lançamentos") — em vez de
    // duplicar a lógica, os dois compartilham a classe
    // "diff-estoque-csv-select" e este loop popula qualquer um que
    // existir no DOM.
    document.querySelectorAll('.diff-estoque-csv-select').forEach((selectCsv) => {
      const valorAtual = selectCsv.value;
      selectCsv.innerHTML = '<option value="">Mais recente (automático)</option>' +
        exports.map((e) => `<option value="${escapeHtml(e.nome)}">${escapeHtml(e.nome)} (${formatarBytes(e.bytes)})</option>`).join('');
      if ([...selectCsv.options].some((o) => o.value === valorAtual)) selectCsv.value = valorAtual;
    });
  }

  document.addEventListener('click', async (ev) => {
    const btnEstoque = ev.target.closest('[data-action="estoque-baixar-agora"]');
    if (!btnEstoque) return;
    // automatico:true (2026-08-07) — mesma correção já aplicada em
    // "Capturar agora" da Qualidade Cadastral: login automático via
    // X2_USUARIO/X2_SENHA já confirmado funcionando (ver x2-estoque-export.js),
    // não tinha motivo real pra esse botão manual ainda parar esperando
    // clique humano em "Já cliquei, continuar". Rotinas de estoque
    // (agendadas) já rodavam automáticas — só o clique manual tinha ficado
    // pra trás.
    // Mesmo botão/data-action existe em 2 lugares agora (2026-09-12): a aba
    // Estoque de sempre e o atalho novo em Ações Rápidas (Catálogo) — cada
    // um com seu próprio <select> de opção, por isso lê o mais próximo do
    // botão clicado em vez de um id fixo.
    const selectEstoque = btnEstoque.closest('.card, .acao-rapida-painel')?.querySelector('select');
    const estoqueOpcao = selectEstoque ? selectEstoque.value : 'Com e sem estoque';
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'estoque', secoes: [], opcoes: { estoqueOpcao, automatico: true } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar exportação.', 'erro');
      return;
    }
    // acompanha o progresso na mesma "Execução" da aba Fotos (mesmo mecanismo de SSE)
    el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
  });

  // ─── Diff Estoque (2026-08-10) — "com a lista csv que eu extraio, não
  // seria mais fácil capturar códigos novos por lá e depois rastreá-los com
  // o sync": em vez de rodar Sync com as 26 seções marcadas (caro, foi o
  // que travou o servidor numa rodada --todas), compara o CSV de estoque
  // contra o catálogo e busca só os códigos que faltam, 1 por 1.
  //
  // PEDIDO DO USUÁRIO (2026-09-12): agora existem 2 instâncias desse botão
  // na tela (card "Sincronizar com o Catálogo" na aba Estoque, e o modo
  // "Apenas lançamentos" dentro do acordeão "Cadastrar produtos" na aba
  // Catálogo) — em vez de duas cópias da lógica com ids fixos diferentes,
  // acha o select/checkbox mais perto do botão que foi clicado (mesmo
  // padrão já usado no handler de "estoque-baixar-agora" acima).
  document.addEventListener('click', async (ev) => {
    const btnDiffEstoque = ev.target.closest('[data-action="diff-estoque-rodar"]');
    if (!btnDiffEstoque) return;
    const container = btnDiffEstoque.closest('.card, .acao-rapida-painel');
    const selectCsv = container ? container.querySelector('.diff-estoque-csv-select') : null;
    const checkDryRun = container ? container.querySelector('.diff-estoque-dry-run-check') : null;
    const caminhoCsv = (selectCsv && selectCsv.value) || undefined;
    const dryRun = checkDryRun ? checkDryRun.checked : true;
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'diff-estoque', secoes: [], opcoes: { caminhoCsv, dryRun, automatico: true } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar a sincronização.', 'erro');
      return;
    }
    // mesmo padrão do "Baixar CSV agora": acompanha na Execução da aba Fotos.
    el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
  });

  // ─── Lançamentos via X2 (2026-08-11) — "Apenas produtos com primeira
  // entrada" na última semana completa (segunda a sábado, nunca a semana em
  // andamento), lido direto de ☰ >
  // Compras > Catálogo de Produtos — ver x2-lancamentos-scraper.js pros
  // seletores confirmados ao vivo. Mesmo padrão de carregamento dos
  // Alertas de WhatsApp: só busca a ÚLTIMA captura salva; "Rodar agora"
  // dispara a ação de verdade (abre o X2 e busca) via /api/acao.
  async function carregarLancamentosX2() {
    const tbody = el('tabela-lancamentos');
    const linkCsv = el('lancamentos-csv-link');
    try {
      const res = await fetch('/api/lancamentos-x2/ultima-captura');
      if (!res.ok) {
        el('lancamentos-info').textContent = 'Nenhuma captura ainda.';
        el('contador-lancamentos').textContent = '0';
        linkCsv.style.display = 'none';
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Clique em "Buscar lançamentos no X2" pra trazer a semana atual.</td></tr>';
        return;
      }
      const captura = await res.json();
      const { de, ate } = captura.periodoRecebimento || {};
      el('lancamentos-info').textContent = `${formatarDataHora(captura.capturadoEm)} — recebimento de ${de} a ${ate}.`;
      const lista = captura.produtos || [];
      el('contador-lancamentos').textContent = lista.length;
      if (captura.nomeBase && lista.length) {
        linkCsv.href = `/api/lancamentos-x2/xlsx/${encodeURIComponent(captura.nomeBase)}`;
        linkCsv.style.display = '';
      } else {
        linkCsv.style.display = 'none';
      }
      // PEDIDO DO USUÁRIO (2026-08-11): "código de barra e seção... e código
      // de fabricante já aparece junto a descrição" — tabela na tela só
      // mostra Código + Descrição (que já inclui fabricante/cód. fabricante
      // dentro do texto); o CSV baixado continua com todos os campos, pra
      // quem precisar do detalhe completo.
      tbody.innerHTML = lista.length
        ? lista.map((p) => `
          <tr>
            <td>${escapeHtml(p.codigo)}</td>
            <td>${escapeHtml(p.descricaoComercial || p.descricaoCurta || '—')}</td>
          </tr>
        `).join('')
        : '<tr><td colspan="2" class="table-empty">Nenhum produto com primeira entrada nesse período.</td></tr>';
    } catch (e) { /* painel segue funcionando sem isso */ }
    carregarLancamentosExports();
  }

  async function carregarLancamentosExports() {
    const tbody = el('tabela-lancamentos-exports');
    try {
      const res = await fetch('/api/lancamentos-x2/exports');
      const data = await res.json();
      const exports = data.exports || [];
      el('contador-lancamentos-exports').textContent = exports.length;
      if (!exports.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Nenhum export ainda.</td></tr>';
        return;
      }
      tbody.innerHTML = exports.map((e) => {
        const { de, ate } = e.periodoRecebimento || {};
        return `
          <tr>
            <td>${escapeHtml(de || '—')} a ${escapeHtml(ate || '—')}</td>
            <td>${escapeHtml(e.quantidade)}</td>
            <td>${escapeHtml(formatarBytes(e.bytes))}</td>
            <td>${escapeHtml(formatarDataHora(e.capturadoEm))}</td>
            <td><a href="/api/lancamentos-x2/xlsx/${encodeURIComponent(e.nomeBase)}" download>Baixar</a></td>
          </tr>
        `;
      }).join('');
    } catch (e) { /* painel segue funcionando sem isso */ }
  }

  // yyyy-mm-dd (formato do <input type="date">) -> dd/mm/aaaa (formato que o X2 espera)
  function _isoParaDataBr(iso) {
    if (!iso) return undefined;
    const [yyyy, mm, dd] = iso.split('-');
    return `${dd}/${mm}/${yyyy}`;
  }

  document.addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-action="lancamentos-x2-rodar"]')) return;
    const dataInicioRecebimento = _isoParaDataBr(el('lancamentos-x2-desde').value);
    const dataFimRecebimento = _isoParaDataBr(el('lancamentos-x2-ate').value);
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'lancamentos-x2', secoes: [], opcoes: { automatico: true, dataInicioRecebimento, dataFimRecebimento } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar a busca.', 'erro');
      return;
    }
    // acompanha o progresso na aba Catálogo (mesmo mecanismo de SSE das outras ações)
    el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
  });

  // PEDIDO DO USUÁRIO (2026-10-27): reenviar ao Drive, na hora, só os
  // fabricantes da ÚLTIMA captura de lançamentos já salva (sem buscar de
  // novo no X2) — pra poder refazer o envio da semana sozinho, sem precisar
  // esperar a rotina automática de segunda à noite nem pedir pra alguém
  // rodar por SSH.
  document.addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-action="drive-enviar-semana"]')) return;
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'drive-enviar-semana', secoes: [] }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar o reenvio ao Drive.', 'erro');
      return;
    }
    mostrarToast('Reenviando ao Drive os fabricantes da semana — acompanhe em "Rotinas".', 'sucesso');
    el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
  });

  // ─── Qualidade Cadastral (2026-08-07, reformulado em abas 2026-08-10) —
  // listas de Itens Inativos, Sem Foto/Arquivo, Preço de Venda Zerado, Sem
  // Custo Médio (ver scripts/x2-painel-produtos-snapshot.js). Antes, as 4
  // ficavam empilhadas na mesma tela (card atrás de card) e a busca cortava
  // em 500 linhas com uma mensagem de "mostrando 500 de X" fácil de não
  // notar — dava a impressão de filtro incompleto. Agora: 1 aba por
  // divergência (só uma tabela na tela por vez) + paginação de verdade
  // (Anterior/Próxima), então a busca sempre alcança o resultado inteiro,
  // só dividido em páginas em vez de escondido.
  const QUALIDADE_PAGINA_TAMANHO = 100;
  const qualidadeDados = {}; // chave -> { headers, produtos, labelBadge }
  const qualidadeEstado = {}; // chave -> { filtro, pagina }
  let qualidadeAbaAtiva = null;

  function _qualidadeEstadoDe(chave) {
    return qualidadeEstado[chave] || (qualidadeEstado[chave] = { filtro: '', pagina: 0 });
  }

  async function carregarQualidadeCadastral() {
    const res = await fetch('/api/painel-produtos/qualidade-cadastral');
    const data = await res.json();
    const tipos = data.tipos || [];
    if (!qualidadeAbaAtiva && tipos.length) qualidadeAbaAtiva = tipos[0].chave;

    el('qualidade-tabs').innerHTML = tipos.map((t) => `
      <span class="qualidade-tab${t.chave === qualidadeAbaAtiva ? ' active' : ''}" data-qualidade-tab="${escapeHtml(t.chave)}">
        ${escapeHtml(t.labelBadge)}
        <span class="qualidade-tab-contador" id="qualidade-tab-contador-${escapeHtml(t.chave)}">…</span>
      </span>
    `).join('');

    el('qualidade-paineis').innerHTML = tipos.map((t) => `
      <div class="qualidade-painel${t.chave === qualidadeAbaAtiva ? ' active' : ''}" data-qualidade-painel="${escapeHtml(t.chave)}">
        <input type="text" class="search-input" data-qualidade-busca="${escapeHtml(t.chave)}" placeholder="Buscar por código ou descrição...">
        <div class="table-wrap">
          <table>
            <thead><tr id="qualidade-cabecalho-${escapeHtml(t.chave)}"></tr></thead>
            <tbody id="qualidade-tabela-${escapeHtml(t.chave)}"><tr><td class="skeleton">Carregando...</td></tr></tbody>
          </table>
        </div>
        <div class="qualidade-paginacao">
          <button class="small ghost" data-qualidade-pag="anterior" data-qualidade-chave="${escapeHtml(t.chave)}" id="qualidade-pag-anterior-${escapeHtml(t.chave)}">‹ Anterior</button>
          <span class="qualidade-pagina-info" id="qualidade-pagina-info-${escapeHtml(t.chave)}"></span>
          <button class="small ghost" data-qualidade-pag="proxima" data-qualidade-chave="${escapeHtml(t.chave)}" id="qualidade-pag-proxima-${escapeHtml(t.chave)}">Próxima ›</button>
        </div>
        <p class="descricao" id="qualidade-info-${escapeHtml(t.chave)}" style="margin-top:10px;"></p>
      </div>
    `).join('');

    tipos.forEach((t) => _carregarUmaListaQualidade(t.chave));
  }

  function _qualidadeTrocarAba(chave) {
    qualidadeAbaAtiva = chave;
    document.querySelectorAll('.qualidade-tab').forEach((t) => t.classList.toggle('active', t.dataset.qualidadeTab === chave));
    document.querySelectorAll('.qualidade-painel').forEach((p) => p.classList.toggle('active', p.dataset.qualidadePainel === chave));
  }

  // PEDIDO DO USUÁRIO (2026-08-11, "vamos dar uma melhorada por favor"):
  // achado ao vivo durante a auditoria de design — "Itens Inativos" mostra
  // valor de código/barras deslocado 1 coluna pra esquerda e a coluna
  // "Código - Descrição" sempre vazia. Causa raiz confirmada via
  // /api/painel-produtos/qualidade-cadastral/itensInativos: o cabeçalho vem
  // com 3 colunas (["", "Cod. Barras", "Código - Descrição"] — a 1ª vazia é
  // provavelmente o checkbox "Ativar Produtos" dessa tela específica), mas
  // cada linha de dado só tem 2 células (o scraper não captura nada pra
  // aquela coluna de checkbox) — desalinha cabeçalho x dado em 1 posição.
  // "Sem Foto/Arquivo" tem o problema oposto e inofensivo: cabeçalho com
  // coluna vazia no FIM, que já bate em tamanho com os dados (também com
  // célula vazia no fim) — só sobra uma coluna sem uso nenhum.
  // Corrigido aqui na renderização (não no scraper Playwright, frágil e só
  // validável ao vivo): alinha cabeçalho e dado pelo tamanho real da 1ª
  // linha, cortando sobra vazia do INÍCIO (sem par nos dados) ou do FIM
  // (com ou sem par) — nunca desalinha o resto das colunas.
  function _alinharCabecalhoELinhas(headersOriginais, produtos) {
    let headers = headersOriginais.slice();
    if (produtos.length) {
      const larguraLinha = produtos[0].length;
      if (headers.length === larguraLinha + 1 && headers[0] === '') {
        headers = headers.slice(1); // coluna extra sem dado (ex: checkbox) — remove do início
      } else if (headers.length > larguraLinha) {
        headers = headers.slice(0, larguraLinha); // sobra no fim sem dado — corta o excesso
      }
    }
    // Cabeçalho vazio sobrando no fim = coluna sem uso nenhum — remove pra
    // não deixar uma coluna sem rótulo e sem propósito visível.
    while (headers.length && headers[headers.length - 1] === '') {
      headers = headers.slice(0, -1);
    }
    const largura = headers.length;
    const produtosAjustados = produtos.map((linha) => linha.slice(0, largura));
    return { headers, produtos: produtosAjustados };
  }

  async function _carregarUmaListaQualidade(chave) {
    const res = await fetch(`/api/painel-produtos/qualidade-cadastral/${chave}`);
    const tbody = el(`qualidade-tabela-${chave}`);
    const theadRow = el(`qualidade-cabecalho-${chave}`);
    const tabContador = el(`qualidade-tab-contador-${chave}`);
    const info = el(`qualidade-info-${chave}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      tabContador.textContent = '—';
      tabContador.closest('.qualidade-tab').classList.add('qualidade-tab-erro');
      theadRow.innerHTML = '';
      tbody.innerHTML = `<tr><td class="table-empty">${escapeHtml(data.error || 'Nenhuma captura ainda.')}</td></tr>`;
      info.textContent = '';
      const btnAnterior = el(`qualidade-pag-anterior-${chave}`);
      const btnProxima = el(`qualidade-pag-proxima-${chave}`);
      if (btnAnterior) btnAnterior.disabled = true;
      if (btnProxima) btnProxima.disabled = true;
      const pagInfo = el(`qualidade-pagina-info-${chave}`);
      if (pagInfo) pagInfo.textContent = '';
      return;
    }
    const data = await res.json();
    const { headers, produtos } = _alinharCabecalhoELinhas(data.headers || [], data.produtos || []);
    qualidadeDados[chave] = { headers, produtos };
    qualidadeEstado[chave] = { filtro: '', pagina: 0 };

    tabContador.textContent = produtos.length.toLocaleString('pt-BR');
    theadRow.innerHTML = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    _renderTabelaQualidade(chave);
    info.textContent = data.capturadoEm
      ? `Capturado em ${formatarDataHora(data.capturadoEm)}${data.fonte === 'csv-estoque' ? ` — a partir do CSV "${data.csvUsado}".` : '.'}`
      : '';
  }

  function _renderTabelaQualidade(chave) {
    const dados = qualidadeDados[chave];
    const tbody = el(`qualidade-tabela-${chave}`);
    if (!dados || !tbody) return;
    const estado = _qualidadeEstadoDe(chave);
    const colspan = dados.headers.length || 1;
    const termo = estado.filtro.trim().toLowerCase();
    const filtrados = termo
      ? dados.produtos.filter((linha) => linha.some((c) => String(c || '').toLowerCase().includes(termo)))
      : dados.produtos;

    const totalPaginas = Math.max(1, Math.ceil(filtrados.length / QUALIDADE_PAGINA_TAMANHO));
    if (estado.pagina >= totalPaginas) estado.pagina = totalPaginas - 1;
    if (estado.pagina < 0) estado.pagina = 0;

    if (!filtrados.length) {
      tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-empty">Nenhum produto encontrado.</td></tr>`;
    } else {
      const inicio = estado.pagina * QUALIDADE_PAGINA_TAMANHO;
      const visiveis = filtrados.slice(inicio, inicio + QUALIDADE_PAGINA_TAMANHO);
      tbody.innerHTML = visiveis.map((linha) => `<tr>${linha.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
    }

    const pagInfo = el(`qualidade-pagina-info-${chave}`);
    if (pagInfo) {
      pagInfo.textContent = filtrados.length
        ? `Página ${estado.pagina + 1} de ${totalPaginas} — ${filtrados.length.toLocaleString('pt-BR')} produto(s)`
        : '';
    }
    const btnAnterior = el(`qualidade-pag-anterior-${chave}`);
    const btnProxima = el(`qualidade-pag-proxima-${chave}`);
    if (btnAnterior) btnAnterior.disabled = estado.pagina <= 0;
    if (btnProxima) btnProxima.disabled = estado.pagina >= totalPaginas - 1;
  }

  el('qualidade-tabs').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.qualidade-tab');
    if (tab) _qualidadeTrocarAba(tab.dataset.qualidadeTab);
  });

  el('qualidade-paineis').addEventListener('input', (ev) => {
    const chave = ev.target.dataset.qualidadeBusca;
    if (!chave) return;
    const estado = _qualidadeEstadoDe(chave);
    estado.filtro = ev.target.value;
    estado.pagina = 0; // busca nova sempre volta pra 1ª página
    _renderTabelaQualidade(chave);
  });

  el('qualidade-paineis').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-qualidade-pag]');
    if (!btn || btn.disabled) return;
    const chave = btn.dataset.qualidadeChave;
    const estado = _qualidadeEstadoDe(chave);
    estado.pagina += btn.dataset.qualidadePag === 'proxima' ? 1 : -1;
    _renderTabelaQualidade(chave);
  });

  document.addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-action="qualidade-capturar-agora"]')) return;
    // automatico:true — login automático via X2_USUARIO/X2_SENHA (.env),
    // já confirmado funcionando. Antes disso, "Capturar agora" sempre
    // parava esperando um clique humano em "Já cliquei, continuar" mesmo
    // não tendo motivo real pra isso (diferente do fluxo de Fotos, que
    // trava por um bug real do X2, não por login).
    const res = await fetch('/api/acao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'painel-produtos', secoes: [], opcoes: { automatico: true } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      mostrarToast(data.error || 'Erro ao iniciar captura.', 'erro');
      return;
    }
    // acompanha o progresso na aba Fotos (mesmo mecanismo de SSE das outras ações)
    el('top-tabs').querySelector('[data-top-tab="fotos"]').click();
  });

  // ─── Alertas de WhatsApp (2026-08-10, REMOVIDO da tela em 2026-09-11 —
  // pedido do usuário: "vamos remover essa função de avisos whatsapp por
  // enquanto, quero focar apenas nas rotinas e atualizações de cadastros").
  // carregarAlertas()/formatarMoeda()/o listener de clique dos botões
  // "Rodar agora" foram removidos daqui porque ficaram sem elemento no DOM
  // pra escrever (a seção foi tirada de index.html) — o backend (rotas
  // /api/alertas/..., scripts x2-cortes-produtos-scraper.js/
  // x2-curva-abc-parados-scraper.js/x2-whatsapp-alerta.js, tipos de rotina
  // 'cortes-produtos'/'produtos-parados') continua intacto, então isso é
  // reversível — se algum dia voltar a tela, o mesmo código de antes
  // funciona de novo (ver histórico do git).

  carregarStatus();
  conectarSSE();
})();
