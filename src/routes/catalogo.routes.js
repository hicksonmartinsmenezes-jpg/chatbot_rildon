const express = require("express");
const router = express.Router();
const {
  listarFotosHandler,
  servirFotoHandler,
  buscarProdutosHandler,
  listarSecoesHandler,
  listarLinhasHandler,
  listarFabricantesHandler,
  buscarPorCodigoHandler,
  exportarPdfHandler,
  recarregarEstoqueHandler,
  recarregarCatalogoHandler,
} = require("../controllers/catalogo.controller");

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
// "Catálogo expresso" em PDF com foto (pedido do usuário, 2026-07-28): mesmos
// critérios de /catalogo/buscar (ou um `codigo` isolado), mas sem o teto de
// 200 da tela — traz tudo que bateu no filtro, até MAX_EXPORT_PDF.
router.get("/catalogo/exportar-pdf", exportarPdfHandler);
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

module.exports = router;
