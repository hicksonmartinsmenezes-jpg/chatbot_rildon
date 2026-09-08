const crypto = require("crypto");
const ExcelJS = require("exceljs");
const logger = require("../utils/logger");
const { listarFotos, obterFoto, obterFotoPorNome, definirFotoPreferida, ocultarFoto, recarregarIndice: recarregarIndiceFotos, obterVersaoFotos, temMultiplasFotos } = require("../services/catalogo-fotos.service");
const { buscarProdutosPainel, buscarPorCodigo, buscarPorNomePainel, listarFabricantes, listarFabricantesCatalogoCompleto, listarMarcasVeiculoConhecidas, decodificarFabricanteCompleto, recarregarIndices: recarregarIndicesProdutos, listarLinhasParaEdicaoCategoria, definirLinhaProduto, PSEUDO_FABRICANTE_DIVERSOS } = require("../services/catalogo-x2.service");
const { listarSecoes, listarLinhasPorSecao } = require("../services/catalogo.service");
const { gerarPdfCatalogo, gerarPdfCatalogoCompleto, gerarPdfCatalogoPromocional, limparCacheBboxFotos } = require("../services/catalogo-pdf.service");
const { carregarEstoque, statusCache } = require("../services/estoque.service");
const { anexarAplicacoesOrganizadas } = require("../services/catalogo-aplicacao-ia.service");

// Issue #23 (2026-08-26): quantos textos de aplicação NOVOS (sem cache
// ainda) o clique em "Gerar catálogo completo" tenta organizar com IA antes
// de gerar o PDF — limite baixo de propósito, pra não deixar a resposta
// HTTP pendurada esperando o rate limit do provedor de IA (pode chegar a
// 20s/chamada no provedor free tier padrão, ver PROVIDER.intervalMs em
// ai.service.js). O resto (se sobrar) fica sem esse bloco NESSA exportação
// — não trava nem quebra o PDF, só sai menos completo até alguém rodar
// `npm run organizar-aplicacoes-ia -- --fabricante=X` (sem esse limite) ou
// exportar de novo mais tarde (cache já preenchido de exportações
// anteriores acelera a próxima).
const MAX_APLICACOES_NOVAS_POR_EXPORT = 8;

// Código de produto do X2 é sempre numérico (ex: "111430") — validação
// simples evita processar entrada absurda antes de tocar no índice em memória.
function _codigoValido(codigo) {
  return /^[A-Za-z0-9_-]{1,20}$/.test(String(codigo || ""));
}

const ANO_MINIMO = 1950;

// Pedido do usuário (2026-07-28): o export em PDF traz TODOS os resultados
// do filtro (não só os até 200 exibidos na tela) — mas como o PDF embute
// foto de cada peça, um filtro genérico demais (ex: seção inteira com
// milhares de produtos) geraria um arquivo gigante e lento de montar. Esse
// teto é só uma trava técnica de segurança; se bater nele, a resposta pede
// pra refinar a busca (marca/modelo/seção mais específica).
//
// 2026-08-26 (pedido do usuário, Issue #20): levantado de 500 pra 1000 — o novo modo "Catálogo Completo" (exportar
// TODO o catálogo de um fabricante, sem filtrar por marca/modelo) esbarrava
// nesse teto pra 4 dos 105 fabricantes cadastrados (medido em 2026-08-26:
// RAINHA 863, WEGA 664, GAUSS 615, PRADOLUX 586 produtos — o maior valor
// real hoje é 863). 1000 cobre todos com folga sem abrir mão da trava de
// segurança contra um filtro genérico demais.
const MAX_EXPORT_PDF = 1000;

// Pedido do usuário (2026-09-02): "Critérios de Pesquisa" mostrava só as
// primeiras 200 peças sem jeito de ver o resto — subiu pra 400 por página,
// com paginação de verdade (ver `offset` em buscarProdutosPainel/
// catalogo-x2.service.js) em vez de só cortar. `total` sempre reflete a
// contagem real antes do corte, então o frontend calcula quantas páginas
// existem e mostra "Página X de Y".
const LIMITE_PAGINA_PAINEL = 400;

// 2026-08-29 ("Catálogo Promocional", nova função): teto separado de
// MAX_EXPORT_PDF — aqui a lista é curada produto a produto pelo atendente
// (não um filtro amplo que pode trazer centenas sem querer), então um teto
// bem menor já cobre qualquer uso real e evita só o caso degenerado de um
// `codigos` gigante mandado direto na API sem passar pela UI.
const MAX_ITENS_PROMOCIONAL = 200;

// Converte um texto de preço (célula do CSV) num Number — aceita tanto
// formato pt-BR ("1.234,56", vírgula decimal, ponto de milhar) quanto
// formato solto com ponto decimal ("99.90", caso comum quando o CSV é
// gerado por script/planilha em locale en-US) — decide pelo formato
// olhando se tem vírgula: com vírgula, ponto vira separador de milhar
// (removido) e vírgula vira o decimal; sem vírgula, usa o texto como está.
// "R$" solto no início (cola comum de export de planilha) é removido antes.
function _parsePrecoTexto(txt) {
  const limpo = String(txt || "").trim().replace(/^R\$\s*/i, "");
  if (!limpo) return null;
  const normalizado = limpo.includes(",") ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
  const num = Number(normalizado);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

// Remove acento e normaliza espaço/caixa — usado só pra RECONHECER qual
// coluna é qual no cabeçalho (o valor das células continua intocado).
function _normalizarHeader(h) {
  return String(h || "")
    .trim().replace(/^"|"$/g, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos (o-com-acento -> o, c-cedilha -> c...)
    .toLowerCase();
}

// Parser de linhas já tabuladas (2 colunas: codigo,preco) — comum ao CSV e
// ao XLSX (2026-08-29, pedido do usuário: "preciso que ele entenda arquivos
// xls também"). Recebe uma matriz de linhas, cada uma já um array de
// células string — CSV chega assim depois do split por vírgula, XLSX chega
// assim depois de _linhasDaPlanilha(). Linha sem código OU sem preço válido
// é simplesmente ignorada (não derruba o import inteiro por causa de 1
// linha suja).
//
// Reconhecimento de cabeçalho por SUBSTRING, não igualdade exata (2026-08-29,
// achado testando com um export real do X2 — "Wega Estoque.xlsx" usa
// "Cód. Fornecedor" e "Preço Venda", não "codigo"/"preco" like o formato
// pensado originalmente pro upload manual). "cod" cobre código/código
// interno/cód. fornecedor/cod produto etc.; "preco"/"valor" cobre preço/
// preço venda/preço promocional/valor unitário etc. Se a planilha tiver
// mais de uma coluna de preço (ex: custo E venda), pega a primeira que
// bater — limitação aceitável pro uso real (upload de exports do X2, que
// só trazem 1 preço de venda por padrão).
function _mapaPrecosDeLinhas(linhas, nomeFormato) {
  if (linhas.length < 2) return new Map();

  const headers = linhas[0].map(_normalizarHeader);
  const idxCodigo = headers.findIndex(h => h.includes("cod"));
  const idxPreco = headers.findIndex(h => h.includes("preco") || h.includes("valor"));
  if (idxCodigo === -1 || idxPreco === -1) {
    throw new Error(`${nomeFormato} de preços precisa ter uma coluna de código (ex: "codigo", "cód. fornecedor") e uma de preço (ex: "preco", "preço venda") no cabeçalho.`);
  }

  const mapa = new Map();
  linhas.slice(1).forEach(linha => {
    const codigo = String(linha[idxCodigo] || "").trim().replace(/^"|"$/g, "");
    const preco = _parsePrecoTexto(linha[idxPreco]);
    if (!codigo || preco === null) return;
    mapa.set(codigo, preco);
  });
  return mapa;
}

// Parser de CSV bem simples — pedido do usuário (2026-08-29): "eu enviarei
// arquivos csv com codigos e preços promocionais". Não usa nenhuma lib de
// CSV (o projeto já tem um parser próprio equivalente em contact.routes.js
// pra importação de contatos, mas é local àquele arquivo) — como o formato
// aqui é sempre só 2 colunas simples, sem aspas/vírgula dentro de campo
// esperadas, um split direto basta, sem trazer dependência nova pra um caso
// tão simples (ver princípio "evitar overengineering" em CLAUDE.md).
function _parseCsvPrecos(conteudo) {
  const linhas = String(conteudo || "")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .split("\n").filter(l => l.trim())
    .map(linha => linha.split(","));
  return _mapaPrecosDeLinhas(linhas, "CSV");
}

// Parser de XLSX — pedido do usuário (2026-08-29): "preciso que ele
// entenda arquivos xls também". Usa exceljs (já dependência do projeto, ver
// scripts/x2-lancamentos-scraper.js) pra ler a 1ª planilha do workbook e
// devolver o mesmo formato de matriz de linhas que o parser de CSV usa —
// mesma validação de cabeçalho/preço, sem duplicar lógica.
// Limitação conhecida: exceljs só lê o formato OOXML (.xlsx); um .xls de
// verdade (binário antigo, pré-2007) cai aqui e estoura na leitura —
// mensagem de erro abaixo já orienta o usuário a salvar como .xlsx.
async function _parseXlsxPrecos(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('Não consegui ler a planilha. Se for um .xls antigo, salve como .xlsx (Excel: "Salvar como" → "Pasta de Trabalho do Excel") e envie de novo.');
  }
  const planilha = workbook.worksheets[0];
  if (!planilha) throw new Error("A planilha enviada está vazia.");

  const linhas = [];
  planilha.eachRow({ includeEmpty: false }, (row) => {
    const valores = row.values.slice(1).map(v => {
      if (v && typeof v === "object" && "text" in v) return v.text; // rich text
      if (v && typeof v === "object" && "result" in v) return v.result; // fórmula
      return v;
    });
    linhas.push(valores);
  });
  return _mapaPrecosDeLinhas(linhas, "Planilha");
}

// GET /api/catalogo/buscar — painel "Catálogo de Produtos" (Task #240-243,
// pedido do usuário em 2026-07-21): atendente digita marca/modelo/ano (e
// opcionalmente categoria) pra achar peças compatíveis durante o atendimento,
// sem depender de o cliente já ter escrito isso numa mensagem de chat.
async function buscarProdutosHandler(req, res) {
  try {
    const marca      = String(req.query.marca || "").trim();
    const modelo     = String(req.query.modelo || "").trim();
    const categoria  = String(req.query.categoria || "").trim();
    // Pedido do usuário (2026-09-03): o seletor da aba "Catálogo Completo"
    // pode mandar um valor composto tipo "PERFECT::mecanica" (ver
    // listarFabricantesCatalogoCompleto/decodificarFabricanteCompleto em
    // catalogo-x2.service.js) — decodifica ANTES de usar, senão vira um
    // fabricante desconhecido de verdade e a contagem dá 0. O filtro comum
    // do painel nunca manda "::" num fabricante de texto livre, então essa
    // decodificação não afeta em nada o uso normal.
    const { fabricante, tipoCompleto } = decodificarFabricanteCompleto(req.query.fabricante || "");
    const anoStr        = String(req.query.ano || "").trim();
    // PEDIDO DO USUÁRIO (2026-09-04, referência KKI Vendas): campo único
    // "Ano" virou "Ano Inicial"/"Ano Final" no formulário — `ano` continua
    // aceito (compat com quem ainda manda só um ano, ex: chamadas antigas
    // salvas em favoritos/histórico do navegador do atendente).
    const anoInicioStr  = String(req.query.anoInicio || "").trim();
    const anoFimStr     = String(req.query.anoFim || "").trim();
    const motor         = String(req.query.motor || "").trim();

    // Modo navegação (pedido do usuário, 2026-07-22, estendido em 2026-07-23
    // pra incluir fabricante): sem marca/modelo, uma categoria (Seção ou
    // Linha) e/ou um fabricante sozinho já bastam pra listar o catálogo —
    // inclusive produtos sem texto de aplicação cadastrado, que o modo
    // "busca por veículo" abaixo não alcançaria.
    if (!marca && !modelo && !categoria && !fabricante) {
      return res.status(400).json({ error: "Informe marca/modelo do veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo." });
    }

    const anoMaximo = new Date().getFullYear() + 1;
    function _validarAno(str, rotulo) {
      if (!str) return null;
      const n = parseInt(str, 10);
      if (!Number.isInteger(n) || n < ANO_MINIMO || n > anoMaximo) {
        res.status(400).json({ error: `${rotulo} inválido (use um valor entre ${ANO_MINIMO} e ${anoMaximo}).` });
        return undefined; // sinaliza "já respondeu, aborta"
      }
      return n;
    }

    const ano = _validarAno(anoStr, "Ano");
    if (ano === undefined) return;
    const anoInicio = _validarAno(anoInicioStr, "Ano inicial");
    if (anoInicio === undefined) return;
    const anoFim = _validarAno(anoFimStr, "Ano final");
    if (anoFim === undefined) return;
    if (anoInicio && anoFim && anoInicio > anoFim) {
      return res.status(400).json({ error: "Ano inicial não pode ser maior que o ano final." });
    }

    // Paginação (pedido do usuário, 2026-09-02): "pagina" é 1-based, vindo
    // do seletor de página no painel — qualquer valor inválido/ausente cai
    // em 1, nunca quebra a busca.
    const paginaNum = parseInt(req.query.pagina, 10);
    const pagina = Number.isInteger(paginaNum) && paginaNum > 0 ? paginaNum : 1;
    const offset = (pagina - 1) * LIMITE_PAGINA_PAINEL;

    const resultado = buscarProdutosPainel({ marca, modelo, ano, anoInicio, anoFim, motor, categoria, fabricante, tipoCompleto, limite: LIMITE_PAGINA_PAINEL, offset });

    // 2026-09-08 (pedido do usuário: "duas fotos como no PDF" também em
    // Critérios de Pesquisa): duasFotos é barato de calcular (só olha o
    // índice em memória, ver temMultiplasFotos) mesmo pros até 400 produtos
    // desta página — frontend usa esse flag pra decidir o layout do card
    // sem precisar de uma chamada extra por produto.
    const produtosComFlag = (resultado.produtos || []).map(p => ({
      ...p,
      duasFotos: temMultiplasFotos(p.codigo),
    }));

    res.json({ ...resultado, produtos: produtosComFlag, pagina, limite: LIMITE_PAGINA_PAINEL });
  } catch (err) {
    logger.error("❌ Erro ao buscar produtos do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao buscar produtos." });
  }
}

// GET /api/catalogo/exportar-pdf — "catálogo expresso" (pedido do usuário,
// 2026-07-28): exporta em PDF, com foto, o resultado de uma busca do painel.
// Aceita os mesmos critérios de /catalogo/buscar (marca/modelo/ano/categoria/
// fabricante), um `codigo` isolado (mesmo modo de /catalogo/buscar-codigo) OU
// um `nome` isolado (mesmo modo de /catalogo/buscar-nome, 2026-08-14).
// Diferente da tela, aqui NÃO aplica o teto de exibição de 200 — traz tudo
// que bateu no filtro, até o teto de segurança MAX_EXPORT_PDF.
async function exportarPdfHandler(req, res) {
  try {
    const codigo = String(req.query.codigo || "").trim();
    const nome   = String(req.query.nome || "").trim();
    let produtos;
    let tituloBusca;
    // Issue #21 (2026-08-26): "Catálogo Completo" — fabricante isolado, sem
    // marca/modelo/categoria — dispara o layout com índice/sumário dividido
    // por Linha (gerarPdfCatalogoCompleto) em vez do PDF "expresso" comum
    // (gerarPdfCatalogo). Os outros modos (veículo/código/nome/seleção
    // manual via marca+modelo+categoria) continuam exatamente como estavam.
    let modoCompleto = false;
    let fabricanteCompleto = "";
    // Pedido do usuário (2026-09-03, separação Mecânica/Elétrica): guardado
    // à parte de fabricanteCompleto de propósito — _estiloCatalogoCompleto
    // (catalogo-pdf.service.js) decide o estilo visual "Mecânica" olhando o
    // NOME do fabricante (hoje só PERFECT); sem esse controle, "PERFECT -
    // Elétrica" (os 10 produtos de PERFECT que NÃO são da seção MECÂNICA)
    // herdaria por engano o mesmo estilo visual pensado só pro catálogo de
    // referência da seção MECÂNICA.
    let tipoCompletoSelecionado = null;

    if (codigo) {
      produtos = buscarPorCodigo(codigo, { limite: Infinity });
      tituloBusca = `Busca por código: ${codigo}`;
    } else if (nome) {
      produtos = buscarPorNomePainel(nome, { limite: Infinity }).produtos;
      tituloBusca = `Busca por nome: ${nome}`;
    } else {
      const marca      = String(req.query.marca || "").trim();
      const modelo     = String(req.query.modelo || "").trim();
      const categoria  = String(req.query.categoria || "").trim();
      // Pedido do usuário (2026-09-03): mesma decodificação de
      // buscarProdutosHandler acima — o seletor da aba "Catálogo Completo"
      // manda "PERFECT::mecanica" quando esse fabricante tem peça nos dois
      // tipos (ver listarFabricantesCatalogoCompleto/
      // decodificarFabricanteCompleto em catalogo-x2.service.js).
      const { fabricante, tipoCompleto } = decodificarFabricanteCompleto(req.query.fabricante || "");
      const anoStr     = String(req.query.ano || "").trim();

      if (!marca && !modelo && !categoria && !fabricante) {
        return res.status(400).json({ error: "Informe marca/modelo do veículo, ou selecione uma Seção/Fabricante pra exportar." });
      }

      let ano = null;
      if (anoStr) {
        const anoNum = parseInt(anoStr, 10);
        const anoMaximo = new Date().getFullYear() + 1;
        if (!Number.isInteger(anoNum) || anoNum < ANO_MINIMO || anoNum > anoMaximo) {
          return res.status(400).json({ error: `Ano inválido (use um valor entre ${ANO_MINIMO} e ${anoMaximo}).` });
        }
        ano = anoNum;
      }

      const resultado = buscarProdutosPainel({ marca, modelo, ano, categoria, fabricante, tipoCompleto, limite: Infinity });
      produtos = resultado.produtos;

      modoCompleto = !marca && !modelo && !categoria && !!fabricante;
      fabricanteCompleto = fabricante;
      tipoCompletoSelecionado = tipoCompleto;

      // Rótulo com o tipo pendurado (ex: "PERFECT - Mecânica") só pra
      // exibição em tituloBusca — NÃO usado pra decidir estilo visual (ver
      // tipoCompletoSelecionado acima, passado à parte pra
      // gerarPdfCatalogoCompleto).
      const sufixoTipo = tipoCompleto === "mecanica" ? " - Mecânica" : tipoCompleto === "eletrica" ? " - Elétrica" : "";
      const partes = [marca, modelo, anoStr, categoria, fabricante ? `${fabricante}${sufixoTipo}` : fabricante].filter(Boolean);
      tituloBusca = partes.length ? partes.join(" · ") : "Catálogo completo";
    }

    // Pedido do usuário (2026-09-05): no Catálogo Completo, só entram
    // produtos com preço cadastrado (varejo OU atacado) — ver
    // _anexarEstoque/catalogo-x2.service.js, produto.estoque vem null (sem
    // registro nenhum) ou { qtd, unidade, precoVarejo, precoAtacado }, e
    // cada preço pode ser null individualmente mesmo com registro de
    // estoque. Filtro só no modo Completo — o expresso (busca solta) e o
    // Promocional continuam como estavam (o Promocional já filtra por CSV
    // de preço à parte, tem outra lógica própria).
    if (modoCompleto) {
      const totalAntesDoPreco = produtos.length;
      produtos = produtos.filter(p => p.estoque && (p.estoque.precoVarejo != null || p.estoque.precoAtacado != null));
      if (!produtos.length) {
        return res.status(404).json({
          error: totalAntesDoPreco
            ? `${totalAntesDoPreco} peça(s) encontrada(s) pra "${fabricanteCompleto}", mas nenhuma tem preço cadastrado no estoque — nada pra exportar.`
            : "Nenhuma peça encontrada pra exportar com esses critérios.",
        });
      }

      // Pedido do usuário (2026-09-05): também só entra produto com foto —
      // listarFotos é metadados só (índice em memória, sem ler bytes),
      // barato de chamar por produto mesmo em listas grandes. Aplicado
      // DEPOIS do filtro de preço, com mensagem própria, pra distinguir no
      // erro qual dos dois filtros zerou o resultado.
      const totalAntesDaFoto = produtos.length;
      produtos = produtos.filter(p => listarFotos(p.codigo).length > 0);
      if (!produtos.length) {
        return res.status(404).json({
          error: `${totalAntesDaFoto} peça(s) com preço encontrada(s) pra "${fabricanteCompleto}", mas nenhuma tem foto cadastrada — nada pra exportar.`,
        });
      }
    }

    if (!produtos.length) {
      return res.status(404).json({ error: "Nenhuma peça encontrada pra exportar com esses critérios." });
    }
    if (produtos.length > MAX_EXPORT_PDF) {
      return res.status(400).json({
        error: `A busca encontrou ${produtos.length} peças — refine os filtros (máx. ${MAX_EXPORT_PDF} peças por exportação em PDF).`,
      });
    }

    if (modoCompleto) {
      // Issue #23: melhor esforço LIMITADO — organiza com IA só os textos de
      // aplicação ainda sem cache (até o teto acima), sem travar a resposta
      // HTTP por um fabricante nunca processado antes. Roda ANTES dos
      // headers pra poder responder 500 aqui se der erro grave sem quebrar
      // o stream do PDF (embora anexarAplicacoesOrganizadas nunca deva
      // lançar — falha de IA vira produto sem aplicacaoOrganizada, não
      // exceção).
      try {
        await anexarAplicacoesOrganizadas(produtos, { maxNovos: MAX_APLICACOES_NOVAS_POR_EXPORT });
      } catch (err) {
        logger.warn(`[Catálogo] Falha ao organizar aplicações com IA (seguindo sem elas): ${err.message}`);
      }
    }

    res.setHeader("Content-Type", "application/pdf");
    if (modoCompleto) {
      res.setHeader("Content-Disposition", `attachment; filename="catalogo-completo-${Date.now()}.pdf"`);
      // Pedido do usuário (2026-09-05): pseudo-fabricante "Diversos" agrupa
      // por marca de veículo em vez de por Linha (ver PSEUDO_FABRICANTE_DIVERSOS
      // acima e o comentário de agruparPorMarca em gerarPdfCatalogoCompleto).
      const agruparPorMarca = fabricanteCompleto === PSEUDO_FABRICANTE_DIVERSOS;
      await gerarPdfCatalogoCompleto(produtos, fabricanteCompleto, res, tipoCompletoSelecionado, agruparPorMarca);
    } else {
      res.setHeader("Content-Disposition", `attachment; filename="catalogo-expresso-${Date.now()}.pdf"`);
      await gerarPdfCatalogo(produtos, tituloBusca, res);
    }
  } catch (err) {
    logger.error("❌ Erro ao exportar catálogo em PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF do catálogo." });
  }
}

// Normaliza código pra comparação (mesma regra de _normalizarCodigo em
// catalogo-x2.service.js — não exportada de lá, replicada aqui só pra
// comparação; a busca em si continua inteiramente dentro do service).
function _normalizarCodigoComparacao(codigo) {
  return String(codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Extrai só a parte do código de uma referência tipo "FCD3061 - WEGA" (antes
// do " - ", que é o fabricante) já normalizada pra comparação. Mesma lógica
// de referenciaIndex em catalogo-x2.service.js, replicada aqui (ver
// comentário de _normalizarCodigoComparacao acima).
//
// BUG REAL corrigido 2026-09-01 (achado junto da investigação de
// FCD0721/FCD0727 sumindo do import/export do Catálogo Promocional): antes
// desta função, o código comparava `_normalizarCodigoComparacao(p.referencia)`
// direto, SEM separar o fabricante — "FCD3061 - WEGA" normalizava pra
// "FCD3061WEGA", que nunca bate contra "FCD3061" (código do arquivo do
// fornecedor). Essa comparação nunca disparava de verdade; só não quebrava
// visivelmente porque o fallback `resultados[0]` já vinha certo depois do
// fix de prioridade em buscarPorCodigo. Também normaliza o mesmo typo de
// hífen sem espaço antes do "WEGA" já corrigido em _extrairFabricante e no
// referenciaIndex ("FCD-0721- WEGA", "FCD0727- WEGA").
function _extrairCodigoDaReferencia(referencia) {
  const normalizada = String(referencia || "").replace(/(?<=\S)-(?=\s)/g, " -");
  const parte = normalizada.includes(" - ") ? normalizada.split(" - ")[0] : normalizada;
  return _normalizarCodigoComparacao(parte);
}

// Resolve uma lista de códigos internos pros produtos reais indexados —
// mesma busca exata usada em /catalogo/buscar-codigo (equivalente/
// referência/código interno). Prioriza o match EXATO (código interno da loja
// OU referência própria do produto — a UI de seleção manda código interno,
// mas um arquivo de preço de fornecedor manda a referência dele) quando
// buscarPorCodigo devolver mais de um resultado. Compartilhado entre
// exportarPdfPromocionalHandler e importarArquivoPromocionalHandler
// (2026-08-29) — mesma lógica, evita os dois divergirem com o tempo (ver
// princípio DRY em CLAUDE.md).
//
// BUG REAL corrigido 2026-09-01 (achado testando import de preços com
// arquivo real, "Wega Estoque.xlsx"): a comparação `String(p.codigo) ===
// codigo` nunca podia bater, porque p.codigo é sempre o código INTERNO da
// loja (ex: "123517") e `codigo` aqui é o código do ARQUIVO do fornecedor
// (ex: "JFA0K14") — formatos incompatíveis por definição. Isso fazia o
// "match exato" nunca disparar, caindo sempre em resultados[0] (que também
// tinha ordem errada — ver fix em buscarPorCodigo/catalogo-x2.service.js).
// Resultado: import de preço por código de fornecedor podia devolver um
// produto de OUTRO fabricante que só cita aquele código como equivalente
// OEM, em vez do produto certo. Fix: comparar também contra a referência
// própria do produto (normalizada), que é o campo que de fato corresponde
// ao código de fornecedor de um arquivo de preços.
function _resolverProdutosPorCodigos(codigos) {
  const produtos = [];
  const naoEncontrados = [];
  codigos.forEach((codigo) => {
    const resultados = buscarPorCodigo(codigo, { limite: 10 });
    const codigoNormalizado = _normalizarCodigoComparacao(codigo);
    const exato = resultados.find((p) =>
      String(p.codigo) === codigo || _extrairCodigoDaReferencia(p.referencia) === codigoNormalizado
    ) || resultados[0] || null;
    if (exato) produtos.push(exato);
    else naoEncontrados.push(codigo);
  });
  return { produtos, naoEncontrados };
}

// BUG REAL achado testando com arquivo de verdade do usuário (2026-08-29,
// "Wega Estoque.xlsx"): o Map de preços vem indexado pelo código QUE ESTAVA
// NO ARQUIVO (ex: "Cód. Fornecedor" tipo "WR106") — mas o produto resolvido
// por buscarPorCodigo() sempre volta com o CÓDIGO INTERNO da loja (ex:
// "126011", ver comentário de buscarPorCodigo em catalogo-x2.service.js).
// gerarPdfCatalogoPromocional/importarArquivoPromocionalHandler procuravam
// o preço fazendo precosPorCodigo.get(produto.codigo) — codigo INTERNO — só
// que a chave do Map era o codigo do ARQUIVO. Resultado: preço sempre null,
// mesmo com o arquivo "batendo" certinho na resolução de produto (que usa
// os 3 índices — interno/referência/equivalente — então funciona mesmo com
// código de fornecedor; só o preço que ficava sem achar a chave certa).
// Esta função re-indexa o Map pelo código INTERNO logo após o parse, uma
// vez só, resolvendo cada chave do arquivo pro mesmo produto que
// _resolverProdutosPorCodigos acha depois — os dois pontos de uso (export
// e import) passam a bater sempre, seja o arquivo usando código interno,
// de fornecedor ou referência.
function _reindexarPrecosPorCodigoInterno(precosBrutos) {
  const mapa = new Map();
  for (const [codigoArquivo, preco] of precosBrutos) {
    const resultados = buscarPorCodigo(codigoArquivo, { limite: 10 });
    const codigoNormalizado = _normalizarCodigoComparacao(codigoArquivo);
    const exato = resultados.find((p) =>
      String(p.codigo) === codigoArquivo || _extrairCodigoDaReferencia(p.referencia) === codigoNormalizado
    ) || resultados[0] || null;
    if (exato) mapa.set(String(exato.codigo), preco);
  }
  return mapa;
}

// POST /api/catalogo/promocional/exportar-pdf — "Catálogo Promocional" (nova
// função, pedido do usuário 2026-08-29): mesmo layout com foto/aplicação do
// Catálogo Completo, mas pra uma LISTA SELECIONADA de produtos (não "todo
// fabricante") e com preço promocional por card, vindo de um CSV que o
// próprio usuário sobe junto com a requisição. multipart/form-data:
//   - `codigos` (campo de texto): JSON array de códigos internos dos
//     produtos selecionados na UI (frontend acumula essa lista clicando
//     "Adicionar" nos resultados de busca já existentes).
//   - `csv` (arquivo, opcional): CSV com colunas "codigo,preco" — código
//     sem entrada aqui simplesmente não ganha badge de preço no card (ver
//     _desenharBadgePreco em catalogo-pdf.service.js), não bloqueia a
//     geração do PDF.
async function exportarPdfPromocionalHandler(req, res) {
  try {
    let codigos;
    try {
      codigos = JSON.parse(req.body.codigos || "[]");
    } catch {
      return res.status(400).json({ error: "Lista de produtos selecionados inválida." });
    }
    if (!Array.isArray(codigos) || !codigos.length) {
      return res.status(400).json({ error: "Selecione ao menos 1 produto pra gerar o catálogo promocional." });
    }

    codigos = [...new Set(codigos.map(c => String(c).trim()).filter(Boolean))];
    if (!codigos.length) {
      return res.status(400).json({ error: "Selecione ao menos 1 produto pra gerar o catálogo promocional." });
    }
    if (codigos.some(c => !_codigoValido(c))) {
      return res.status(400).json({ error: "Código de produto inválido na lista selecionada." });
    }
    if (codigos.length > MAX_ITENS_PROMOCIONAL) {
      return res.status(400).json({ error: `A lista tem ${codigos.length} produtos — máx. ${MAX_ITENS_PROMOCIONAL} por catálogo promocional.` });
    }

    let precosPorCodigo = new Map();
    if (req.file) {
      const nomeArquivo = String(req.file.originalname || "").toLowerCase();
      try {
        precosPorCodigo = nomeArquivo.endsWith(".xls") || nomeArquivo.endsWith(".xlsx")
          ? await _parseXlsxPrecos(req.file.buffer)
          : _parseCsvPrecos(req.file.buffer.toString("utf-8"));
        // Re-indexa pelo código INTERNO (ver _reindexarPrecosPorCodigoInterno)
        // — sem isso, um arquivo com código de fornecedor/referência (ex:
        // export de Estoque do X2) nunca batia com produto.codigo (sempre
        // interno) na hora de desenhar o selo de preço no PDF.
        precosPorCodigo = _reindexarPrecosPorCodigoInterno(precosPorCodigo);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    const { produtos, naoEncontrados } = _resolverProdutosPorCodigos(codigos);

    if (!produtos.length) {
      return res.status(404).json({ error: "Nenhum dos produtos selecionados foi encontrado no catálogo." });
    }

    // Mesmo melhor-esforço limitado do Catálogo Completo (Issue #23) —
    // organiza com IA só os textos ainda sem cache, até o mesmo teto.
    try {
      await anexarAplicacoesOrganizadas(produtos, { maxNovos: MAX_APLICACOES_NOVAS_POR_EXPORT });
    } catch (err) {
      logger.warn(`[Catálogo Promocional] Falha ao organizar aplicações com IA (seguindo sem elas): ${err.message}`);
    }

    // 2026-08-31 (pedido do usuário: "poderá ser por linha ou por
    // fabricante") — modo vem do form-data do frontend (radio "Agrupar
    // por"), default "linha" se não vier nada (compatível com chamadas
    // antigas do preview/export que ainda não mandam esse campo). Qualquer
    // valor que não seja exatamente "fabricante" cai em "linha" — nunca
    // quebra por um valor inesperado.
    const modo = req.body.modo === "fabricante" ? "fabricante" : "linha";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="catalogo-promocional-${Date.now()}.pdf"`);
    if (naoEncontrados.length) {
      // Aviso não-bloqueante (o PDF sai só com o que foi encontrado) — o
      // frontend pode ler esse header e avisar o atendente quais códigos
      // sumiram da seleção (produto removido/renomeado no catálogo depois
      // que a UI adicionou ele à lista).
      res.setHeader("X-Catalogo-Codigos-Nao-Encontrados", naoEncontrados.join(","));
    }
    await gerarPdfCatalogoPromocional(produtos, precosPorCodigo, res, modo);
  } catch (err) {
    logger.error("❌ Erro ao exportar catálogo promocional em PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF do catálogo promocional." });
  }
}

// POST /api/catalogo/promocional/importar-arquivo — pedido do usuário
// (2026-08-29): "no upload de preços promocionais geralmente vai junto ao
// codigo, dá pra fazer a captação do produto ao mesmo tempo o preço no
// arquivo e inseri-lo no catálogo promocional?". Antes, o CSV/XLS/XLSX só
// servia pra dar preço a produtos JÁ adicionados manualmente (busca +
// "Adicionar" um a um). Agora o mesmo arquivo pode ALIMENTAR a lista
// direto: lê codigo+preco do arquivo, resolve cada código pro produto real
// (mesmo _resolverProdutosPorCodigos do handler de exportar-pdf) e devolve
// pro frontend já com nome/seção/linha/preço prontos pra popular
// "Produtos Selecionados" sem precisar buscar cada um manualmente.
// Não gera PDF nenhum aqui — só devolve JSON; a geração continua reusando
// o mesmo arquivo (reenviado) em exportarPdfPromocionalHandler.
async function importarArquivoPromocionalHandler(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Envie um arquivo CSV, XLS ou XLSX com códigos e preços." });
    }

    const nomeArquivo = String(req.file.originalname || "").toLowerCase();
    let precosPorCodigo;
    try {
      precosPorCodigo = nomeArquivo.endsWith(".xls") || nomeArquivo.endsWith(".xlsx")
        ? await _parseXlsxPrecos(req.file.buffer)
        : _parseCsvPrecos(req.file.buffer.toString("utf-8"));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!precosPorCodigo.size) {
      return res.status(400).json({ error: "Nenhum código com preço válido encontrado no arquivo." });
    }
    if (precosPorCodigo.size > MAX_ITENS_PROMOCIONAL) {
      return res.status(400).json({ error: `O arquivo tem ${precosPorCodigo.size} códigos — máx. ${MAX_ITENS_PROMOCIONAL} por catálogo promocional.` });
    }

    // Resolve produtos usando os códigos CRUS do arquivo (podem ser código
    // de fornecedor/referência, ex: export de Estoque do X2 — buscarPorCodigo
    // já lida com isso). Só DEPOIS re-indexa o Map de preços pelo código
    // INTERNO (mesmo formato que os produtos resolvidos sempre trazem) —
    // mesmo bug/fix do exportarPdfPromocionalHandler, ver
    // _reindexarPrecosPorCodigoInterno.
    const codigosDoArquivo = [...precosPorCodigo.keys()];
    const { produtos, naoEncontrados } = _resolverProdutosPorCodigos(codigosDoArquivo);
    const precosPorCodigoInterno = _reindexarPrecosPorCodigoInterno(precosPorCodigo);

    if (!produtos.length) {
      return res.status(404).json({ error: "Nenhum dos códigos do arquivo foi encontrado no catálogo." });
    }

    res.json({
      produtos: produtos.map(p => ({
        codigo: p.codigo,
        nome: p.nome,
        secao: p.secao,
        linha: p.linha,
        preco: precosPorCodigoInterno.get(String(p.codigo)) ?? null,
      })),
      naoEncontrados,
    });
  } catch (err) {
    logger.error("❌ Erro ao importar arquivo de preços do catálogo promocional:", err.message);
    res.status(500).json({ error: "Erro ao processar o arquivo." });
  }
}

// GET /api/catalogo/fabricantes — alimenta o dropdown opcional "Fabricante"
// no painel (Task #250-253, pedido do usuário em 2026-07-23). Só mostra
// fabricantes com um mínimo de produtos identificados (ver
// FABRICANTE_MIN_OCORRENCIAS em catalogo-x2.service.js) — o fabricante é
// extraído do nome do produto, não é campo estruturado no catálogo real.
async function listarFabricantesHandler(req, res) {
  try {
    res.json({ fabricantes: listarFabricantes() });
  } catch (err) {
    logger.error("❌ Erro ao listar fabricantes do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao listar fabricantes." });
  }
}

// GET /api/catalogo/montadoras — pedido do usuário (2026-09-04, referência
// do concorrente KKI Vendas): sugestões pro campo "Montadora" da busca
// avançada (datalist, não trava o atendente num valor fixo — continua
// aceitando texto livre, ver buscarProdutosPainel). Lista curada extraída
// de dado REAL do catálogo (ver MARCAS_VEICULO_CONHECIDAS em
// catalogo-x2.service.js), não inventada à mão.
async function listarMontadorasHandler(req, res) {
  try {
    res.json({ montadoras: listarMarcasVeiculoConhecidas() });
  } catch (err) {
    logger.error("❌ Erro ao listar montadoras conhecidas do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao listar montadoras." });
  }
}

// GET /api/catalogo/fabricantes-completo — só pra aba "Catálogo Completo"
// (pedido do usuário, 2026-09-03: "temos a divisão de peças cadastradas
// como mecânica para esses catálogos [...] preciso que faça a separação
// das que são elétricas e mecânicas [...] quando eu for selecionar o tipo
// de catálogo que eu queira preciso que tenha essa separação algo como
// Perfect - Mecânica"). Diferente de /catalogo/fabricantes (usado pelo
// filtro comum do painel, sem separação): aqui cada fabricante que tem
// peça na seção MECÂNICA e peça fora dela ao mesmo tempo vira DUAS opções
// ("PERFECT - Mecânica" / "PERFECT - Elétrica"); o resto (a maioria) some
// como uma opção só. Ver listarFabricantesCatalogoCompleto/
// decodificarFabricanteCompleto em catalogo-x2.service.js pro resto do
// fluxo (contagem em /catalogo/buscar e geração em /catalogo/exportar-pdf
// já entendem o `value` composto que essa lista devolve).
async function listarFabricantesCatalogoCompletoHandler(req, res) {
  try {
    res.json({ opcoes: listarFabricantesCatalogoCompleto() });
  } catch (err) {
    logger.error("❌ Erro ao listar fabricantes do Catálogo Completo:", err.message);
    res.status(500).json({ error: "Erro ao listar fabricantes." });
  }
}

// GET /api/catalogo/buscar-codigo?codigo=X — busca direta por código de
// fabricante, referência própria ou código interno do produto (Task
// #250-253, pedido do usuário em 2026-07-23). Diferente de
// /catalogo/buscar: aqui o atendente já sabe o código exato (ex: cliente leu
// o número na embalagem antiga), não precisa de marca/modelo/ano.
async function buscarPorCodigoHandler(req, res) {
  try {
    const codigo = String(req.query.codigo || "").trim();
    if (!codigo) {
      return res.status(400).json({ error: "Informe o código de fabricante, referência ou código interno da peça." });
    }
    const produtos = buscarPorCodigo(codigo);
    res.json({ total: produtos.length, produtos });
  } catch (err) {
    logger.error("❌ Erro ao buscar produto por código:", err.message);
    res.status(500).json({ error: "Erro ao buscar produto por código." });
  }
}

// GET /api/catalogo/buscar-nome?nome=X — 3ª forma de busca do painel
// "Catálogo de Produtos" (pedido do usuário, 2026-08-14): "gostaria que no
// meu painel de catálogo também tivesse opção de pesquisar por peça nome".
// Diferente de /catalogo/buscar (marca/modelo/veículo) e /catalogo/
// buscar-codigo (código exato): aqui o atendente digita o nome/descrição da
// peça direto (ex: "correia dentada", "sensor de oxigenio"), sem precisar
// saber veículo nem código nenhum — útil quando o cliente só sabe o nome da
// peça que quer.
async function buscarPorNomeHandler(req, res) {
  try {
    const nome = String(req.query.nome || "").trim();
    if (!nome) {
      return res.status(400).json({ error: "Informe o nome ou parte do nome da peça." });
    }
    const resultado = buscarPorNomePainel(nome);
    res.json(resultado);
  } catch (err) {
    logger.error("❌ Erro ao buscar produto por nome:", err.message);
    res.status(500).json({ error: "Erro ao buscar produto por nome." });
  }
}

// GET /api/catalogo/secoes — lista as 26 categorias reais, pra popular o
// campo opcional de "Peça/Categoria" no formulário de busca do painel.
async function listarSecoesHandler(req, res) {
  try {
    res.json({ secoes: listarSecoes() });
  } catch (err) {
    logger.error("❌ Erro ao listar seções do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao listar categorias." });
  }
}

// incluirOcultas=1 na query é usado só pelo modal "Escolher foto
// principal" (precisa mostrar as ocultas também, pra dar pra restaurar —
// ver ocultarFotoHandler abaixo); o resto do painel (card, PDF) nunca
// manda esse parâmetro e continua só vendo as visíveis, como sempre.
async function listarFotosHandler(req, res) {
  try {
    const { codigo } = req.params;
    if (!_codigoValido(codigo)) {
      return res.status(400).json({ error: "Código de produto inválido." });
    }
    const incluirOcultas = req.query.incluirOcultas === "1";
    const fotos = listarFotos(codigo, { incluirOcultas });
    res.json({ codigo, total: fotos.length, fotos });
  } catch (err) {
    logger.error("❌ Erro ao listar fotos do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao listar fotos." });
  }
}

// BUG REAL corrigido 2026-09-02 (usuário reportou "troquei a foto, ela até
// troca mas não fica salva como principal"): max-age=86400 fixo era
// seguro enquanto a mesma URL (/fotos/0) SEMPRE devolvia o mesmo arquivo
// pra sempre — deixou de ser verdade quando a troca manual de foto
// principal (ver definirFotoPreferida) passou a mudar o que /fotos/0
// devolve pro MESMO produto. O navegador continuava servindo do cache
// local a versão de ANTES da troca em qualquer carregamento novo (nova
// busca, F5) sem nem perguntar pro servidor — só o clique que troca (usa
// uma URL com ?t=timestamp, sempre nova) escapava do cache. Fix: ETag
// (hash do conteúdo real) + must-revalidate — o navegador AGORA sempre
// pergunta pro servidor "isso mudou?" antes de reusar o cache; se não
// mudou, servidor responde 304 (barato, sem reenviar a foto); se mudou
// (troca de preferência), ETag bate diferente e o navegador busca de
// novo. Mantém o ganho de banda sem arriscar mostrar foto desatualizada.
// Extraído (2026-09-02, feature de ocultar foto) porque servirFotoHandler
// e servirFotoPorNomeHandler abaixo precisam exatamente do mesmo
// comportamento de cache, só mudando como a foto é localizada (índice vs.
// nome de arquivo).
function _responderFoto(req, res, foto) {
  const etag = `"${crypto.createHash("md5").update(foto.buffer).digest("hex")}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  res.setHeader("Content-Type", foto.mimetype);
  res.send(foto.buffer);
}

async function servirFotoHandler(req, res) {
  try {
    const { codigo, indice } = req.params;
    if (!_codigoValido(codigo)) {
      return res.status(400).json({ error: "Código de produto inválido." });
    }
    const i = parseInt(indice, 10) || 0;

    const foto = obterFoto(codigo, i);
    if (!foto) {
      return res.status(404).json({ error: "Foto não encontrada." });
    }
    _responderFoto(req, res, foto);
  } catch (err) {
    logger.error("❌ Erro ao servir foto do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao carregar foto." });
  }
}

// GET /api/catalogo/produtos/:codigo/fotos/nome/:nomeArquivo — pedido do
// usuário (2026-09-02, feature de ocultar foto): a lista de fotos OCULTAS
// (ver ocultarFotoHandler) não tem índice estável na lista visível (é por
// isso que /fotos/:indice não serve pra elas) — esse endpoint busca por
// nome de arquivo direto, usado pela miniatura de cada foto oculta na
// grade "Escolher foto principal", pra dar pra ver antes de restaurar.
async function servirFotoPorNomeHandler(req, res) {
  try {
    const { codigo, nomeArquivo } = req.params;
    if (!_codigoValido(codigo) || !nomeArquivo || !_nomeArquivoValido(nomeArquivo)) {
      return res.status(400).json({ error: "Parâmetros inválidos." });
    }
    const foto = obterFotoPorNome(codigo, nomeArquivo);
    if (!foto) {
      return res.status(404).json({ error: "Foto não encontrada." });
    }
    _responderFoto(req, res, foto);
  } catch (err) {
    logger.error("❌ Erro ao servir foto por nome do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao carregar foto." });
  }
}

// POST /api/catalogo/produtos/:codigo/foto-preferida — pedido do usuário
// (2026-09-02): quando a foto que aparece em 1º é uma ficha técnica/desenho
// em vez da foto real (ver comentário em catalogo-fotos.service.js —
// alguns produtos têm ficha técnica e foto real na MESMA resolução, aí o
// critério automático por tamanho não consegue distinguir as duas), o
// atendente escolhe manualmente qual foto é a principal, direto no painel.
// Body: { nomeArquivo }. nomeArquivo vazio/null REMOVE a preferência
// (volta pra ordenação automática) — mesmo endpoint faz as duas coisas pra
// não precisar de rota DELETE separada só pra isso.
function _nomeArquivoValido(nome) {
  return nome === null || nome === undefined || nome === "" || /^[A-Za-z0-9_.-]{1,80}$/.test(String(nome));
}

async function definirFotoPreferidaHandler(req, res) {
  try {
    const { codigo } = req.params;
    if (!_codigoValido(codigo)) {
      return res.status(400).json({ error: "Código de produto inválido." });
    }
    const nomeArquivo = req.body?.nomeArquivo ?? null;
    if (!_nomeArquivoValido(nomeArquivo)) {
      return res.status(400).json({ error: "Nome de arquivo inválido." });
    }
    const fotos = definirFotoPreferida(codigo, nomeArquivo || null);
    // versao junto na resposta: o frontend atualiza sua cópia local na hora,
    // sem precisar de outro round-trip pra /catalogo/fotos-versao (ver
    // versaoFotosHandler abaixo e o comentário em catalogo-fotos.service.js
    // sobre por que a URL precisa mudar de verdade, não só o Cache-Control).
    res.json({ ok: true, codigo, fotos, versao: obterVersaoFotos() });
  } catch (err) {
    // definirFotoPreferida lança erro "de negócio" (nomeArquivo não bate
    // com nenhuma foto do produto) — 400, não 500, é erro de entrada, não
    // falha do servidor.
    res.status(400).json({ error: err.message || "Erro ao definir foto preferida." });
  }
}

// POST /api/catalogo/produtos/:codigo/foto-ocultar — pedido do usuário
// (2026-09-02, mesma leva do "trocar foto principal"): às vezes uma das
// fotos cadastradas no X2 pra um produto está simplesmente ERRADA (foto de
// outra peça, borrada, etc.) — o atendente esconde ela da exibição (card,
// modal, PDF) sem apagar nada do zip/X2 de verdade (ver
// ocultarFoto/catalogo-fotos.service.js). Body: { nomeArquivo, oculta }.
// oculta=false RESTAURA (mesmo endpoint faz as duas coisas, igual
// definirFotoPreferidaHandler acima) — default true se omitido.
async function ocultarFotoHandler(req, res) {
  try {
    const { codigo } = req.params;
    if (!_codigoValido(codigo)) {
      return res.status(400).json({ error: "Código de produto inválido." });
    }
    const nomeArquivo = req.body?.nomeArquivo;
    if (!nomeArquivo || !_nomeArquivoValido(nomeArquivo)) {
      return res.status(400).json({ error: "Nome de arquivo inválido." });
    }
    const oculta = req.body?.oculta !== false;
    const fotos = ocultarFoto(codigo, nomeArquivo, oculta);
    res.json({ ok: true, codigo, fotos, versao: obterVersaoFotos() });
  } catch (err) {
    // ocultarFoto lança erro "de negócio" (nomeArquivo não bate com
    // nenhuma foto do produto, ou tentativa de ocultar a última foto
    // visível) — 400, não 500, é erro de entrada, não falha do servidor.
    res.status(400).json({ error: err.message || "Erro ao ocultar foto." });
  }
}

// GET /api/catalogo/fotos-versao — pedido do usuário (2026-09-02, teste ao
// vivo): confirmar troca de foto principal funciona na hora mas some depois
// de recarregar a página, porque URLs de foto já vistas antes desse fix
// ficam presas no cache do navegador com a validade antiga (24h) e nem um
// refresh forçado limpa isso pra imagens carregadas via busca. O frontend
// busca essa versão uma vez por sessão e embute como ?v=<versao> em toda
// URL de foto — muda a URL, força pedido novo de verdade, não importa o que
// já esteja cacheado (ver obterVersaoFotos em catalogo-fotos.service.js).
async function versaoFotosHandler(req, res) {
  try {
    res.json({ versao: obterVersaoFotos() });
  } catch (err) {
    logger.error("❌ Erro ao obter versão de fotos do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao obter versão de fotos." });
  }
}

// GET /api/catalogo/linhas?secao=X — alimenta o dropdown dependente "Linha"
// (só habilita depois que uma Seção é escolhida, estilo ERP).
async function listarLinhasHandler(req, res) {
  try {
    const secao = String(req.query.secao || "").trim();
    if (!secao) return res.json({ linhas: [] });
    res.json({ linhas: listarLinhasPorSecao(secao) });
  } catch (err) {
    logger.error("❌ Erro ao listar linhas do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao listar linhas." });
  }
}

// GET /api/catalogo/categoria-linhas — pedido do usuário (2026-09-05, achado
// investigando M02051/M02038 na Linha errada "AMPERÍMETRO", confirmado ao
// vivo contra o próprio X2): alimenta o dropdown do formulário "Editar
// categoria" do painel — todas as Seções já conhecidas, com as Linhas já
// cadastradas em cada uma (ver listarLinhasParaEdicaoCategoria/
// catalogo-x2.service.js). Escolher uma Linha existente evita criar
// duplicata por erro de digitação; o campo também aceita texto livre pra
// Linha nova, então esta lista é só sugestão, não validação.
async function listarCategoriaLinhasHandler(req, res) {
  try {
    res.json({ secoes: listarLinhasParaEdicaoCategoria() });
  } catch (err) {
    logger.error("❌ Erro ao listar categorias do catálogo X2:", err.message);
    res.status(500).json({ error: "Erro ao listar categorias." });
  }
}

// POST /api/catalogo/produtos/:codigo/linha — corrige a Linha de um produto
// específico (pedido do usuário, 2026-09-05 — ver comentário acima e em
// definirLinhaProduto/catalogo-x2.service.js pro porquê do overlay
// não-destrutivo em vez de editar o JSON do X2 direto). `{ linha: "" }` (ou
// omitido) REMOVE a correção manual, voltando a mostrar o valor original do
// X2 — mesmo padrão de definirFotoPreferidaHandler (nomeArquivo null remove
// a preferência).
async function definirLinhaProdutoHandler(req, res) {
  try {
    const { codigo } = req.params;
    if (!_codigoValido(codigo)) {
      return res.status(400).json({ error: "Código de produto inválido." });
    }
    const novaLinha = req.body?.linha ?? "";
    const produto = definirLinhaProduto(codigo, novaLinha);
    res.json({ ok: true, codigo, produto });
  } catch (err) {
    // definirLinhaProduto lança erro "de negócio" (código não encontrado no
    // catálogo) — 400, não 500, é erro de entrada, não falha do servidor.
    res.status(400).json({ error: err.message || "Erro ao corrigir a categoria do produto." });
  }
}

// POST /api/catalogo/estoque/recarregar — pedido do usuário (2026-08-10):
// o cache de estoque em memória (usado pro badge do Catálogo) só recarregava
// no boot do servidor e a cada 30min (setInterval em server.js). O import de
// um CSV novo via `x2-estoque-export.js` roda num processo Node SEPARADO
// (docker exec avulso) que grava no Postgres mas não tem como avisar o
// processo principal já rodando — resultado: estoque podia ficar até 30min
// desatualizado no painel mesmo logo depois de baixar um CSV novo, mesmo
// dando F5 na página. Esse endpoint deixa o próprio pipeline de export
// forçar o reload assim que o import termina, em vez de esperar o intervalo.
// Protegido por authSession (aplicado em app.js) — aceita tanto sessão de
// usuário logado quanto o Bearer API_TOKEN (usado pelo script via HTTP,
// mesmo padrão de scripts/x2-whatsapp-alerta.js).
async function recarregarEstoqueHandler(req, res) {
  try {
    await carregarEstoque();
    res.json({ ok: true, ...statusCache() });
  } catch (err) {
    logger.error("❌ Erro ao recarregar cache de estoque:", err.message);
    res.status(500).json({ error: "Erro ao recarregar estoque." });
  }
}

// POST /api/catalogo/produtos/recarregar — pedido do usuário (2026-08-12):
// mesmo raciocínio de recarregarEstoqueHandler acima, mas pro catálogo de
// produtos + índice de fotos. Sem isso, "Cadastrar produtos novos" e
// "Atualizar Fotos" rodando sozinhas (agendadas) atualizavam os arquivos em
// disco mas o atendimento só via o resultado depois de alguém reiniciar o
// bot manualmente — a automação ficava pela metade. Chamado pelo próprio
// pipeline (scripts/x2-catalogo-sync.js e scripts/x2-fotos-scraper.js) via
// API_TOKEN logo depois de uma rodada real (não-dry-run) terminar. Recarrega
// os dois índices (produtos E fotos) numa chamada só — as duas rotinas
// tocam nos dois (produto novo geralmente ainda não tem foto até rodar
// "Atualizar Fotos" depois, mas não custa manter os dois sempre em sincronia).
async function recarregarCatalogoHandler(req, res) {
  try {
    recarregarIndicesProdutos();
    const idx = recarregarIndiceFotos();
    // 2026-09-02: fotos podem ter sido substituídas (mesmo código, imagem
    // nova) — sem isso, o cache de bbox (catalogo-pdf.service, ver
    // limparCacheBboxFotos) continuaria servindo o recorte calculado em
    // cima da foto ANTIGA até o processo reiniciar.
    limparCacheBboxFotos();
    res.json({ ok: true, produtosComFoto: idx.size });
  } catch (err) {
    logger.error("❌ Erro ao recarregar catálogo/fotos:", err.message);
    res.status(500).json({ error: "Erro ao recarregar catálogo." });
  }
}

module.exports = {
  listarFotosHandler,
  servirFotoHandler,
  servirFotoPorNomeHandler,
  definirFotoPreferidaHandler,
  ocultarFotoHandler,
  versaoFotosHandler,
  buscarProdutosHandler,
  listarMontadorasHandler,
  recarregarEstoqueHandler,
  recarregarCatalogoHandler,
  listarSecoesHandler,
  listarLinhasHandler,
  listarFabricantesHandler,
  listarFabricantesCatalogoCompletoHandler,
  buscarPorCodigoHandler,
  buscarPorNomeHandler,
  exportarPdfHandler,
  exportarPdfPromocionalHandler,
  importarArquivoPromocionalHandler,
  listarCategoriaLinhasHandler,
  definirLinhaProdutoHandler,
};
