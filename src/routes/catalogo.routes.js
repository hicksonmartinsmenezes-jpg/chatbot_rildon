const express = require("express");
const multer = require("multer");
const router = express.Router();
const { uploadLimiter } = require("../middlewares/rate-limiters");
const {
  listarFotosHandler,
  servirFotoHandler,
  definirFotoPreferidaHandler,
  buscarProdutosHandler,
  listarSecoesHandler,
  listarLinhasHandler,
  listarFabricantesHandler,
  buscarPorCodigoHandler,
  buscarPorNomeHandler,
  exportarPdfHandler,
  exportarPdfPromocionalHandler,
  importarArquivoPromocionalHandler,
  recarregarEstoqueHandler,
  recarregarCatalogoHandler,
} = require("../controllers/catalogo.controller");

// CSV/XLSX de preços do "Catálogo Promocional" (nova função, 2026-08-29;
// suporte a planilha Excel adicionado 2026-08-29 a pedido do usuário — "ele
// entender arquivos xls também"): mesmo padrão de validação de
// contact.routes.js (csvUpload), só que aceitando .csv/.xls/.xlsx até 2MB,
// mimetype coerente. Preço promocional de umas dezenas/centenas de linhas
// cabe MUITO longe desse teto — a trava é só contra arquivo errado enviado
// sem querer, não uma limitação real de uso.
// Nota: .xls (formato binário antigo, pré-2007) NÃO é lido de verdade — só
// aceito na validação de upload por mimetype legado comum, mas o parser
// (_parseXlsxPrecos, catalogo.controller.js) usa exceljs, que só entende
// .xlsx (OOXML). Arquivo .xls de verdade cai no catch do parser com erro
// claro pro usuário, pedindo pra salvar como .xlsx — troca de lib só se
// isso vier a ser um problema real (evitar overengineering, CLAUDE.md).
const csvUploadPrecos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const original = String(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    const mimesAceitos = [
      "text/csv", "application/csv", "text/plain",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream", // alguns navegadores mandam isso pra .xlsx
    ];
    const extensaoOk = original.endsWith(".csv") || original.endsWith(".xls") || original.endsWith(".xlsx");
    const allowed = extensaoOk && mimesAceitos.includes(mime);
    if (!allowed) return cb(new Error("Envie apenas arquivo CSV, XLS ou XLSX válido."));
    return cb(null, true);
  }
});

// Painel "Catálogo de Produtos" (pedido do usuário, 2026-07-21): busca por
// marca/modelo/ano/categoria. Mesma proteção authSession das rotas abaixo
// (aplicada em app.js) — sem restrição extra de role, então atendente,
// supervisor e admin acessam igual (decisão do usuário).
router.get("/catalogo/buscar", buscarProdutosHandler);
router.get("/catalogo/secoes", listarSecoesHandler);
// Dropdown dependente "Seção → Linha" (reformulação no estilo do ERP, 2026-07-21).
router.get("/catalogo/linhas", listarLinhasHandler);
// Dropdown de filtro por fabricante da peça + busca direta por código de
// fabricante/referência/código interno (Task #250-253, pedido do usuário em
// 2026-07-23).
router.get("/catalogo/fabricantes", listarFabricantesHandler);
router.get("/catalogo/buscar-codigo", buscarPorCodigoHandler);
// Busca por nome/descrição da peça (pedido do usuário, 2026-08-14) — 3ª
// forma de busca do painel, útil quando o cliente só sabe o nome da peça,
// sem saber marca/modelo do veículo nem código nenhum.
router.get("/catalogo/buscar-nome", buscarPorNomeHandler);
// "Catálogo expresso" em PDF com foto (pedido do usuário, 2026-07-28): mesmos
// critérios de /catalogo/buscar (ou um `codigo` isolado), mas sem o teto de
// 200 da tela — traz tudo que bateu no filtro, até MAX_EXPORT_PDF.
router.get("/catalogo/exportar-pdf", exportarPdfHandler);
// "Catálogo Promocional" (nova função, pedido do usuário 2026-08-29): lista
// selecionada de produtos + preço promocional por CSV, mesmo layout com
// foto/aplicação do Catálogo Completo mas sem sub-agrupamento por marca (ver
// comentário em catalogo-pdf.service.js/gerarPdfCatalogoPromocional). POST
// porque a lista de códigos + o CSV de preços não cabem confortavelmente
// numa query string GET (Catálogo Completo é só 1 fabricante = 1 parâmetro).
router.post("/catalogo/promocional/exportar-pdf", uploadLimiter, csvUploadPrecos.single("csv"), exportarPdfPromocionalHandler);
// Importar produtos + preço direto do arquivo (pedido do usuário, 2026-08-29):
// mesmo arquivo de preços, mas em vez de só dar preço a produtos já
// adicionados manualmente, também RESOLVE e devolve os produtos pro
// frontend popular "Produtos Selecionados" sozinho — sem precisar buscar
// código por código na UI.
router.post("/catalogo/promocional/importar-arquivo", uploadLimiter, csvUploadPrecos.single("csv"), importarArquivoPromocionalHandler);
// Força o reload do cache de estoque em memória (ver comentário no handler)
// — chamado pelo pipeline scripts/x2-estoque-export.js via API_TOKEN logo
// após o import no banco, pra não esperar o setInterval de 30min.
router.post("/catalogo/estoque/recarregar", recarregarEstoqueHandler);
// Força o reload dos índices de produtos + fotos em memória (ver comentário
// no handler) — chamado por scripts/x2-catalogo-sync.js e
// scripts/x2-fotos-scraper.js via API_TOKEN logo após uma rodada real.
router.post("/catalogo/produtos/recarregar", recarregarCatalogoHandler);

// Lista as fotos disponíveis de um produto do catálogo X2 (só metadados —
// nome de arquivo e índice, sem os bytes).
router.get("/catalogo/produtos/:codigo/fotos", listarFotosHandler);
// Serve os bytes de uma foto específica (índice 0 = primeira foto do produto).
// Protegida por authSession (aplicado em app.js), igual à rota de mídia do
// histórico — dado interno da loja, não público.
router.get("/catalogo/produtos/:codigo/fotos/:indice", servirFotoHandler);
// Escolhe manualmente qual foto é a principal de um produto (pedido do
// usuário, 2026-09-02) — ver comentário no handler/catalogo-fotos.service.js.
router.post("/catalogo/produtos/:codigo/foto-preferida", definirFotoPreferidaHandler);

module.exports = router;
