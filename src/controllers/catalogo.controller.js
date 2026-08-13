const logger = require("../utils/logger");
const { listarFotos, obterFoto, recarregarIndice: recarregarIndiceFotos } = require("../services/catalogo-fotos.service");
const { buscarProdutosPainel, buscarPorCodigo, listarFabricantes, recarregarIndices: recarregarIndicesProdutos } = require("../services/catalogo-x2.service");
const { listarSecoes, listarLinhasPorSecao } = require("../services/catalogo.service");
const { gerarPdfCatalogo } = require("../services/catalogo-pdf.service");
const { carregarEstoque, statusCache } = require("../services/estoque.service");

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
const MAX_EXPORT_PDF = 500;

// GET /api/catalogo/buscar — painel "Catálogo de Produtos" (Task #240-243,
// pedido do usuário em 2026-07-21): atendente digita marca/modelo/ano (e
// opcionalmente categoria) pra achar peças compatíveis durante o atendimento,
// sem depender de o cliente já ter escrito isso numa mensagem de chat.
async function buscarProdutosHandler(req, res) {
  try {
    const marca      = String(req.query.marca || "").trim();
    const modelo     = String(req.query.modelo || "").trim();
    const categoria  = String(req.query.categoria || "").trim();
    const fabricante = String(req.query.fabricante || "").trim();
    const anoStr     = String(req.query.ano || "").trim();

    // Modo navegação (pedido do usuário, 2026-07-22, estendido em 2026-07-23
    // pra incluir fabricante): sem marca/modelo, uma categoria (Seção ou
    // Linha) e/ou um fabricante sozinho já bastam pra listar o catálogo —
    // inclusive produtos sem texto de aplicação cadastrado, que o modo
    // "busca por veículo" abaixo não alcançaria.
    if (!marca && !modelo && !categoria && !fabricante) {
      return res.status(400).json({ error: "Informe marca/modelo do veículo, ou selecione uma Seção/Fabricante pra navegar pelo catálogo." });
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

    const resultado = buscarProdutosPainel({ marca, modelo, ano, categoria, fabricante });
    res.json(resultado);
  } catch (err) {
    logger.error("❌ Erro ao buscar produtos do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao buscar produtos." });
  }
}

// GET /api/catalogo/exportar-pdf — "catálogo expresso" (pedido do usuário,
// 2026-07-28): exporta em PDF, com foto, o resultado de uma busca do painel.
// Aceita os mesmos critérios de /catalogo/buscar (marca/modelo/ano/categoria/
// fabricante) OU um `codigo` isolado (mesmo modo de /catalogo/buscar-codigo).
// Diferente da tela, aqui NÃO aplica o teto de exibição de 200 — traz tudo
// que bateu no filtro, até o teto de segurança MAX_EXPORT_PDF.
async function exportarPdfHandler(req, res) {
  try {
    const codigo = String(req.query.codigo || "").trim();
    let produtos;
    let tituloBusca;

    if (codigo) {
      produtos = buscarPorCodigo(codigo, { limite: Infinity });
      tituloBusca = `Busca por código: ${codigo}`;
    } else {
      const marca      = String(req.query.marca || "").trim();
      const modelo     = String(req.query.modelo || "").trim();
      const categoria  = String(req.query.categoria || "").trim();
      const fabricante = String(req.query.fabricante || "").trim();
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

      const resultado = buscarProdutosPainel({ marca, modelo, ano, categoria, fabricante, limite: Infinity });
      produtos = resultado.produtos;

      const partes = [marca, modelo, anoStr, categoria, fabricante].filter(Boolean);
      tituloBusca = partes.length ? partes.join(" · ") : "Catálogo completo";
    }

    if (!produtos.length) {
      return res.status(404).json({ error: "Nenhuma peça encontrada pra exportar com esses critérios." });
    }
    if (produtos.length > MAX_EXPORT_PDF) {
      return res.status(400).json({
        error: `A busca encontrou ${produtos.length} peças — refine os filtros (máx. ${MAX_EXPORT_PDF} peças por exportação em PDF).`,
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="catalogo-expresso-${Date.now()}.pdf"`);
    gerarPdfCatalogo(produtos, tituloBusca, res);
  } catch (err) {
    logger.error("❌ Erro ao exportar catálogo em PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF do catálogo." });
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

async function listarFotosHandler(req, res) {
  try {
    const { codigo } = req.params;
    if (!_codigoValido(codigo)) {
      return res.status(400).json({ error: "Código de produto inválido." });
    }
    const fotos = listarFotos(codigo);
    res.json({ codigo, total: fotos.length, fotos });
  } catch (err) {
    logger.error("❌ Erro ao listar fotos do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao listar fotos." });
  }
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

    res.setHeader("Content-Type", foto.mimetype);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(foto.buffer);
  } catch (err) {
    logger.error("❌ Erro ao servir foto do catálogo:", err.message);
    res.status(500).json({ error: "Erro ao carregar foto." });
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
    res.json({ ok: true, produtosComFoto: idx.size });
  } catch (err) {
    logger.error("❌ Erro ao recarregar catálogo/fotos:", err.message);
    res.status(500).json({ error: "Erro ao recarregar catálogo." });
  }
}

module.exports = {
  listarFotosHandler,
  servirFotoHandler,
  buscarProdutosHandler,
  recarregarEstoqueHandler,
  recarregarCatalogoHandler,
  listarSecoesHandler,
  listarLinhasHandler,
  listarFabricantesHandler,
  buscarPorCodigoHandler,
  exportarPdfHandler,
};
