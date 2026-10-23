// Faixa "Nova versão disponível" — aparece quando o servidor tem um instalador mais novo que o programa.
(function () {
  "use strict";
  const api = window.catalogoLoja;
  if (!api || !api.versaoNova) return;
  let faixa = null;
  function mostrar(v) {
    if (!v || faixa) return;
    faixa = document.createElement("div");
    faixa.id = "catalogo-atualizacao";
    faixa.innerHTML = '<span><i class="fa-solid fa-download"></i> Nova versão do programa disponível (' + String(v.versao).replace(/[<>&]/g, "") + ')</span><button type="button">Baixar nova versão</button>';
    const botao = faixa.querySelector("button");
    botao.addEventListener("click", async () => {
      botao.disabled = true; botao.textContent = "Baixando…";
      const r = await api.atualizar();
      if (!r || !r.ok) { botao.disabled = false; botao.textContent = "Tentar de novo"; }
      else botao.textContent = "Abrindo o instalador…";
    });
    document.body.appendChild(faixa);
  }
  api.aoHaverNovaVersao(mostrar);
  api.aoProgressoAtualizacao((p) => { const b = faixa && faixa.querySelector("button"); if (b && b.disabled) b.textContent = "Baixando… " + p + "%"; });
  api.versaoNova().then(mostrar).catch(() => {});
})();
