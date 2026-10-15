// scripts/repair-aplicacao-colada.js
//
// Repara um bug real achado 2026-09-04 (pedido do usuário, produto 3RHO
// 121699 "não está captando aplicação"): o parser original de 2026-07-20
// que gerou os arquivos ficha (src/config/catalogo-x2/*.json) — nunca
// salvo como código, ver README.md desta pasta e scripts/x2-catalogo-sync.js
// linhas 20-34 — falhou em reconhecer o cabeçalho "N. Aplicação" quando ele
// não vinha seguido de ":" (às vezes tem tab, às vezes nada, às vezes
// ": " depois do NÚMERO em vez de depois da palavra). Quando isso acontece,
// o texto de aplicação inteiro fica colado dentro de ficha.dadosTecnicos
// (a seção anterior) e ficha.aplicacao fica null — por isso a aba
// "Aplicação" do modal do Catálogo aparece vazia mesmo o produto tendo o
// dado, só que no campo errado.
//
// Reconstruir o parser inteiro é fora de escopo (projeto à parte, ver
// aviso em x2-catalogo-sync.js) — mas o número de registros afetados é
// pequeno o bastante (17 em todo o catálogo, checado 2026-09-04) pra
// reparar cirurgicamente cada um: acha o cabeçalho "N. Aplicação" dentro
// de dadosTecnicos, corta ali — tudo ANTES vira o dadosTecnicos novo
// (limpo), tudo DEPOIS vira o aplicacao novo. Não tenta reconhecer seções
// seguintes (ex: "5. Similares" que às vezes sobra colado no final) porque
// esse texto extra é só um rótulo vazio na prática (checado manualmente
// nos 17 casos) e tentar cortar ali de forma genérica arriscava truncar
// aplicação de verdade em outros formatos (ex: "5640 POWERSTAR" sendo
// confundido com cabeçalho de seção num caso real testado).
//
// Uso:
//   node scripts/repair-aplicacao-colada.js           → dry-run, só mostra o que mudaria
//   node scripts/repair-aplicacao-colada.js --apply    → aplica de verdade nos arquivos

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "src", "config", "catalogo-x2");
const APLICAR = process.argv.includes("--apply");

// Cabeçalho "N. Aplicação" em qualquer formato observado nos dados reais:
// "4. Aplicação" / "4: Aplicação:" / "4 Aplicação:" / "4. Aplicação\t" /
// seguido ou não de quebras de linha extra.
const HEADER_RE = /\n?[ \t]*\d+[.:]?[ \t]*Aplica[cç][aã]o[ \t]*:?[ \t]*\n*/i;

function repararArquivo(caminho) {
  const textoOriginal = fs.readFileSync(caminho, "utf-8");
  let data;
  try {
    data = JSON.parse(textoOriginal);
  } catch (e) {
    console.error(`  ERRO ao parsear ${caminho}: ${e.message}`);
    return { alteracoes: [], textoNovo: null };
  }
  if (!Array.isArray(data)) return { alteracoes: [], textoNovo: null };

  const alteracoes = [];
  let textoNovo = textoOriginal;

  for (const produto of data) {
    const ficha = produto.ficha;
    if (!ficha || typeof ficha !== "object") continue;
    const dt = ficha.dadosTecnicos;
    const aplicacaoAtual = ficha.aplicacao;
    if (aplicacaoAtual) continue; // já tem aplicação — nada a fazer
    if (typeof dt !== "string" || !dt) continue;

    const m = dt.match(HEADER_RE);
    if (!m) continue;

    const dadosTecnicosNovo = dt.slice(0, m.index).trim();
    const aplicacaoNova = dt.slice(m.index + m[0].length).trim();
    if (!aplicacaoNova) continue; // cabeçalho sem conteúdo nenhum depois — nada a extrair

    // Substituição surgical no TEXTO BRUTO do arquivo (não via
    // JSON.stringify do objeto inteiro) — preserva formatação/ordem de
    // chaves/encoding de todo o resto do arquivo de 1-2MB intacto, só
    // troca os 2 valores deste produto.
    const dtAntigoJSON = JSON.stringify(dt);
    const dtNovoJSON = JSON.stringify(dadosTecnicosNovo);
    const aplicacaoAntigoJSON = JSON.stringify(aplicacaoAtual === undefined ? null : aplicacaoAtual);

    const trechoAntigoDT = `"dadosTecnicos": ${dtAntigoJSON}`;
    const trechoNovoDT = `"dadosTecnicos": ${dtNovoJSON}`;
    const trechoAntigoApl = `"aplicacao": ${aplicacaoAntigoJSON}`;
    const trechoNovoApl = `"aplicacao": ${JSON.stringify(aplicacaoNova)}`;

    const qtdDT = textoNovo.split(trechoAntigoDT).length - 1;
    if (qtdDT !== 1) {
      console.warn(`  AVISO: código ${produto.codigo} — dadosTecnicos não é único no arquivo (achado ${qtdDT}x), pulando por segurança.`);
      continue;
    }

    const idxDT = textoNovo.indexOf(trechoAntigoDT);
    // "aplicacao" precisa estar LOGO DEPOIS de dadosTecnicos neste mesmo
    // registro (mesma ordem de campos observada em todos os arquivos) —
    // procura só numa janela pequena à frente pra não confundir com outro
    // produto que por acaso tenha o mesmo "aplicacao": null.
    const janela = textoNovo.slice(idxDT, idxDT + trechoAntigoDT.length + 200);
    if (!janela.includes(trechoAntigoApl)) {
      console.warn(`  AVISO: código ${produto.codigo} — não achei "aplicacao" logo depois de dadosTecnicos como esperado, pulando por segurança.`);
      continue;
    }

    textoNovo = textoNovo.slice(0, idxDT) + trechoNovoDT + textoNovo.slice(idxDT + trechoAntigoDT.length);
    const idxApl = textoNovo.indexOf(trechoAntigoApl, idxDT);
    textoNovo = textoNovo.slice(0, idxApl) + trechoNovoApl + textoNovo.slice(idxApl + trechoAntigoApl.length);

    alteracoes.push({
      codigo: produto.codigo,
      nome: produto.nome,
      dadosTecnicosNovo,
      aplicacaoNova,
    });
  }

  return { alteracoes, textoNovo };
}

function main() {
  const arquivos = fs.readdirSync(DIR).filter(f => f.endsWith(".json") && !f.includes(".bak-"));
  let totalAlteracoes = 0;

  for (const arquivo of arquivos) {
    const caminho = path.join(DIR, arquivo);
    const { alteracoes, textoNovo } = repararArquivo(caminho);
    if (!alteracoes.length) continue;

    console.log(`\n=== ${arquivo} — ${alteracoes.length} produto(s) ===`);
    for (const a of alteracoes) {
      console.log(`  [${a.codigo}] ${a.nome}`);
      console.log(`    dadosTecnicos (novo): ${JSON.stringify(a.dadosTecnicosNovo).slice(0, 100)}${a.dadosTecnicosNovo.length > 100 ? "..." : ""}`);
      console.log(`    aplicacao (novo):     ${JSON.stringify(a.aplicacaoNova).slice(0, 140)}${a.aplicacaoNova.length > 140 ? "..." : ""}`);
    }
    totalAlteracoes += alteracoes.length;

    if (APLICAR) {
      // Confirma que o texto novo continua sendo JSON válido antes de
      // gravar por cima do arquivo original — nunca grava se quebrou algo.
      try {
        JSON.parse(textoNovo);
      } catch (e) {
        console.error(`  ERRO: texto reparado de ${arquivo} não é JSON válido (${e.message}) — arquivo NÃO alterado.`);
        continue;
      }
      fs.writeFileSync(caminho, textoNovo, "utf-8");
      console.log(`  ✅ Gravado.`);
    }
  }

  console.log(`\nTOTAL: ${totalAlteracoes} produto(s) em ${arquivos.length} arquivo(s) verificados.`);
  console.log(APLICAR ? "Modo: APLICADO nos arquivos." : "Modo: DRY-RUN (nada foi gravado — rode com --apply pra aplicar de verdade).");
}

main();
