// Inicialização do programa: tela inicial, ações dos botões e reação ao servidor ligar/desligar.
(function () {
  "use strict";

  // Ações declaradas em data-action / data-submit-action no HTML (mesmo esquema do painel, só o que o catálogo usa).
  const cliques = new Set(["catalogoMostrarAbaVeiculo", "catalogoMostrarAbaCodigo", "catalogoMostrarAbaNome", "catalogoMostrarAbaCompleto"]);
  document.addEventListener("click", (ev) => {
    const gatilho = ev.target.closest("[data-action]");
    if (!gatilho) return;
    const nome = gatilho.dataset.action;
    if (cliques.has(nome) && typeof window[nome] === "function") { ev.preventDefault(); window[nome](ev); }
  });
  document.addEventListener("submit", (ev) => {
    const form = ev.target.closest("[data-submit-action]");
    if (!form) return;
    ev.preventDefault();
    const f = window[form.dataset.submitAction];
    if (typeof f === "function") f(ev);
  });

  // Listas dos campos de busca. Se falhar (servidor lento na hora de abrir), tenta de novo
  // na próxima vez que o servidor responder — senão os campos ficavam vazios até apertar F5.
  let consultaCarregando = false;
  let consultaCarregada = false;
  async function carregarConsulta() {
    if (consultaCarregada || consultaCarregando || window.servidorOnline !== true) return;
    consultaCarregando = true;
    try {
      await Promise.all([loadCatalogoSecoes(), loadCatalogoFabricantes(), loadCatalogoMontadoras()]);
      consultaCarregada = !!document.querySelector("#catalogo-secao option[value]:not([value=''])");
    } catch (_) { consultaCarregada = false; }
    consultaCarregando = false;
  }

  function barra(online) {
    const el = document.getElementById("aviso-offline");
    if (el) {
      el.classList.toggle("hidden", online !== false);
    }
  }

  document.addEventListener("servidor-status", (ev) => {
    const online = ev.detail.online;
    barra(online);
    if (online) carregarConsulta();
    const html = document.documentElement;
    if (!online && !html.classList.contains("consulta-montar") && !html.classList.contains("consulta-inicio")) {
      catalogoConsultaInicio(); // estava em Consultar: volta ao início
    }
    // Lista de Ver Catálogos muda entre servidor e cópias salvas.
    if (html.classList.contains("consulta-montar") && !html.classList.contains("montar-aberto")) {
      _catalogoFabricantesCompletoOpcoes = null; _catalogoFabricantesCompletoCarregados = false;
      _catalogoMontarRenderGrid();
    }
  });

  // Ctrl+F: procurar um código dentro do catálogo aberto.
  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || String(ev.key).toLowerCase() !== "f") return;
    if (document.documentElement.classList.contains("montar-aberto") && catalogoAbrirBuscaDoLeitor()) {
      ev.preventDefault();
      return;
    }
    // Na lista de catálogos, Ctrl+F vai para a busca por nome.
    const busca = document.getElementById("catalogo-montar-busca");
    if (document.documentElement.classList.contains("consulta-montar") && busca) {
      ev.preventDefault();
      busca.focus();
      busca.select();
    }
  });

  window.addEventListener("DOMContentLoaded", async () => {
    document.body.classList.add("light-theme");
    catalogoConsultaInicio();
    await window.iniciarShim();
  });
})();
