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

// Lista as fotos disponíveis de um produto do catálogo X2 (só metadados —
// nome de arquivo e índice, sem os bytes).
router.get("/catalogo/produtos/:codigo/fotos", listarFotosHandler);
// Serve os bytes de uma foto específica (índice 0 = primeira foto do produto).
// Protegida por authSession (aplicado em app.js), igual à rota de mídia do
// histórico — dado interno da loja, não público.
router.get("/catalogo/produtos/:codigo/fotos/:indice", servirFotoHandler);

module.exports = router;
