// scripts/repair-linha-manometro-em-amperimetro.js
//
// Repara um bug real reportado pelo usuário 2026-09-05 (Catálogo Completo,
// fabricante 12M): produtos M02051 (código 126627) e M02038 (código
// 126626), ambos "MANOMETRO DO OLEO...", apareciam agrupados sob a Linha
// "AMPERÍMETRO" em vez de "MANÔMETRO DO ÓLEO".
//
// Investigação (2026-09-05): não são só esses 2 — são 23 produtos no total,
// todos dentro de src/config/catalogo-x2/instrumento-painel.json, todos com
// "linha": "AMPERÍMETRO" mesmo o `nome` claramente dizendo "MANOMETRO..."/
// "MAN. EL. OLEO..."/"MAN.M.OLEO...". Comparado contra os backups
// (.bak-*) desse arquivo desde o mais antigo disponível (2026-07-20, 255
// produtos) até o atual (1772 produtos) — os MESMOS 21 códigos aparecem
// errados em TODOS os snapshots, sem exceção. Isso descarta a race
// condition de scraping já corrigida em 2026-08-12 (commit eab6a30,
// "contaminação em cascata entre seções") como causa: aquele bug era
// intermitente (produtos diferentes errados a cada scrape); este é
// determinístico — sempre os mesmos 21, desde a extração original de
// 2026-07-20. Ou seja: o erro já veio errado na fonte (X2) e nunca foi
// corrigido, não é um bug do nosso scraper.
//
// Confirmado que é um erro isolado (não um padrão espalhado pelo catálogo):
// varredura nos ~17 mil produtos de todos os arquivos de
// src/config/catalogo-x2/*.json procurando a mesma confusão
// manômetro↔amperímetro (nome de um bate com Linha do outro) não achou
// nenhuma outra ocorrência fora deste arquivo.
//
// Como o parser original que gerou `linha`/`ficha` nunca foi salvo como
// código (ver aviso em scripts/x2-catalogo-sync.js, linhas ~20-34) e
// x2-catalogo-sync.js só ACRESCENTA produtos novos (nunca corrige um já
// existente), rodar um re-sync não corrige isso — precisa de reparo
// cirúrgico direto no JSON, mesmo padrão de scripts/repair-aplicacao-colada.js.
//
// Escopo desta correção (decisão do usuário 2026-09-05): SÓ o campo
// `linha` (de "AMPERÍMETRO" pra "MANÔMETRO DO ÓLEO", mesmo valor já usado
// pelos 3 produtos desta Linha que estão corretos no arquivo). NÃO mexe em
// `ficha.descricaoResumida` (também errado nesses produtos — "Válvula
// Solenoide"/"Amperímetro" em vez de "Manômetro"), nem em nenhum outro
// campo da ficha (aplicação/equivalentes/dadosTecnicos) — não temos fonte
// confiável pro valor correto desses campos pra esses 21 códigos
// específicos, e o próprio aviso em x2-catalogo-sync.js alerta que dado
// errado em aplicação/equivalentes é pior que não ter ficha nenhuma (pode
// fazer a IA "confirmar" aplicação errada pro cliente).
//
// Detecção dinâmica (não lista hardcoded de códigos): produto cujo `nome`
// bate com o padrão de nome de manômetro E cuja `linha` atual é
// "AMPERÍMETRO" — assim o script continua útil/idempotente se mais
// produtos com o mesmo problema aparecerem depois (novo código extraído
// pelo x2-catalogo-sync.js sem essa correção).
//
// Uso:
//   node scripts/repair-linha-manometro-em-amperimetro.js            → dry-run, só mostra o que mudaria
//   node scripts/repair-linha-manometro-em-amperimetro.js --apply     → aplica de verdade no arquivo

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "src", "config", "catalogo-x2");
const ARQUIVO = "instrumento-painel.json";
const APLICAR = process.argv.includes("--apply");

const LINHA_ERRADA = "AMPERÍMETRO";
const LINHA_CORRETA = "MANÔMETRO DO ÓLEO";
// Nome de manômetro em qualquer abreviação observada nos dados reais:
// palavra completa "MANOMETRO"/"MANÔMETRO", ou abreviado começando com
// "MAN" + "." ou espaço ("MAN. EL. OLEO", "MAN.M.OLEO", "MAN M OLEO" —
// esta última SEM ponto depois do "MAN", achada só numa 2ª rodada de
// verificação; o regex anterior [/MAN[O.]|MAN[ÔO]METR/] deixava passar
// justamente esse formato, 2 produtos a menos que o real). Exige também
// "OLEO"/"ÓLEO" no nome pra não confundir com outras palavras que também
// começam com "MAN" (ex: manopla, manual) — combinado com o filtro de
// `linha === "AMPERÍMETRO"` no chamador, a interseção fica bem estreita.
function pareceNomeDeManometro(nome) {
  const texto = String(nome || "");
  if (/MAN[ÔO]METR/i.test(texto)) return true;
  return /^MAN[.\s]/i.test(texto) && /OLE|ÓLE/i.test(texto);
}

function reparar(caminho) {
  const textoOriginal = fs.readFileSync(caminho, "utf-8");
  let data;
  try {
    data = JSON.parse(textoOriginal);
  } catch (e) {
    console.error(`ERRO ao parsear ${caminho}: ${e.message}`);
    return { alteracoes: [], textoNovo: null };
  }
  if (!Array.isArray(data)) return { alteracoes: [], textoNovo: null };

  const alteracoes = [];
  let textoNovo = textoOriginal;

  for (const produto of data) {
    if (produto.linha !== LINHA_ERRADA) continue;
    if (!pareceNomeDeManometro(produto.nome)) continue;

    // Localiza o bloco deste produto pelo "codigo" (único no arquivo) e
    // troca só a 1ª ocorrência de "linha": "AMPERÍMETRO" numa janela
    // pequena logo depois — mesma técnica de segurança de
    // repair-aplicacao-colada.js (nunca faz replace global, sempre escopado
    // ao registro certo).
    const codigoJSON = JSON.stringify(String(produto.codigo));
    const marcaCodigo = `"codigo": ${codigoJSON}`;
    const idxCodigo = textoNovo.indexOf(marcaCodigo);
    if (idxCodigo === -1) {
      console.warn(`  AVISO: código ${produto.codigo} — não achei "codigo" no texto, pulando por segurança.`);
      continue;
    }
    const qtdCodigo = textoNovo.split(marcaCodigo).length - 1;
    if (qtdCodigo !== 1) {
      console.warn(`  AVISO: código ${produto.codigo} — "codigo" não é único no arquivo (achado ${qtdCodigo}x), pulando por segurança.`);
      continue;
    }

    const trechoAntigoLinha = `"linha": ${JSON.stringify(LINHA_ERRADA)}`;
    const trechoNovoLinha = `"linha": ${JSON.stringify(LINHA_CORRETA)}`;
    const janela = textoNovo.slice(idxCodigo, idxCodigo + 500);
    const posRelativa = janela.indexOf(trechoAntigoLinha);
    if (posRelativa === -1) {
      console.warn(`  AVISO: código ${produto.codigo} — não achei "linha": "${LINHA_ERRADA}" logo depois do código como esperado, pulando por segurança.`);
      continue;
    }

    const idxLinha = idxCodigo + posRelativa;
    textoNovo = textoNovo.slice(0, idxLinha) + trechoNovoLinha + textoNovo.slice(idxLinha + trechoAntigoLinha.length);

    alteracoes.push({ codigo: produto.codigo, nome: produto.nome });
  }

  return { alteracoes, textoNovo };
}

function main() {
  const caminho = path.join(DIR, ARQUIVO);
  if (!fs.existsSync(caminho)) {
    console.error(`Arquivo não encontrado: ${caminho}`);
    process.exit(1);
  }

  const { alteracoes, textoNovo } = reparar(caminho);

  if (!alteracoes.length) {
    console.log("Nenhum produto encontrado pra corrigir (já reparado ou padrão não bate mais).");
    return;
  }

  console.log(`=== ${ARQUIVO} — ${alteracoes.length} produto(s) ===`);
  for (const a of alteracoes) {
    console.log(`  [${a.codigo}] ${a.nome}  ("${LINHA_ERRADA}" → "${LINHA_CORRETA}")`);
  }

  if (APLICAR) {
    try {
      JSON.parse(textoNovo);
    } catch (e) {
      console.error(`ERRO: texto reparado não é JSON válido (${e.message}) — arquivo NÃO alterado.`);
      process.exit(1);
    }
    fs.writeFileSync(caminho, textoNovo, "utf-8");
    console.log(`\n✅ Gravado em ${caminho}.`);
  } else {
    console.log(`\nModo: DRY-RUN (nada foi gravado — rode com --apply pra aplicar de verdade).`);
  }
}

main();
