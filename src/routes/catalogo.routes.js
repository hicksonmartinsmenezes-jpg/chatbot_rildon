const express = require("express");
const multer = require("multer");
const router = express.Router();
const { uploadLimiter } = require("../middlewares/rate-limiters");
const {
  listarFotosHandler,
  servirFotoHandler,
  servirFotoPorNomeHandler,
  definirFotoPreferidaHandler,
  ocultarFotoHandler,
  adicionarFotoHandler,
  versaoFotosHandler,
  buscarProdutosHandler,
  listarSecoesHandler,
  listarLinhasHandler,
  listarFabricantesHandler,
  listarMontadorasHandler,
  listarFabricantesCatalogoCompletoHandler,
  buscarPorCodigoHandler,
  buscarPorNomeHandler,
  exportarPdfHandler,
  exportarPdfSelecionadosHandler,
  exportarPdfPromocionalHandler,
  importarArquivoPromocionalHandler,
  recarregarEstoqueHandler,
  recarregarCatalogoHandler,
  listarCategoriaLinhasHandler,
  definirLinhaProdutoHandler,
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

// Foto enviada manualmente pelo atendente (nova função, pedido do usuário
// 2026-09-08: "criar possibilidade de adicionar foto") — memória (não
// disco), o handler decide onde salvar via catalogo-fotos.service.js. Teto
// de 8MB combina com MAX_TAMANHO_FOTO_MANUAL do service (a validação real
// de conteúdo — magic bytes jpeg/png — é lá; aqui é só uma 1ª trava barata
// por mimetype/extensão pra rejeitar cedo o caso óbvio, sem baixar o corpo
// inteiro de um arquivo claramente errado).
const uploadFotoManual = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mimesAceitos = ["image/jpeg", "image/png"];
    if (!mimesAceitos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Envie apenas JPG ou PNG."));
    }
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
// Sugestões (datalist, texto livre continua aceito) pro campo "Montadora" da
// busca avançada — pedido do usuário (2026-09-04, referência KKI Vendas).
router.get("/catalogo/montadoras", listarMontadorasHandler);
// Pedido do usuário (2026-09-03): dropdown SEPARADO só pra aba "Catálogo
// Completo" — cada fabricante que tem peça em MECÂNICA e fora dela vira
// duas opções ("PERFECT - Mecânica" / "PERFECT - Elétrica") em vez de uma
// só. Ver listarFabricantesCatalogoCompletoHandler/catalogo-x2.service.js.
router.get("/catalogo/fabricantes-completo", listarFabricantesCatalogoCompletoHandler);
router.get("/catalogo/buscar-codigo", buscarPorCodigoHandler);
// Busca por nome/descrição da peça (pedido do usuário, 2026-08-14) — 3ª
// forma de busca do painel, útil quando o cliente só sabe o nome da peça,
// sem saber marca/modelo do veículo nem código nenhum.
router.get("/catalogo/buscar-nome", buscarPorNomeHandler);
// "Catálogo expresso" em PDF com foto (pedido do usuário, 2026-07-28): mesmos
// critérios de /catalogo/buscar (ou um `codigo` isolado), mas sem o teto de
// 200 da tela — traz tudo que bateu no filtro, até MAX_EXPORT_PDF.
router.get("/catalogo/exportar-pdf", exportarPdfHandler);
// "Exportar selecionados (PDF)" da aba Critérios de Pesquisa (melhoria,
// pedido do usuário 2026-09-19 — ver comentário completo no handler,
// catalogo.controller.js): lista de códigos escolhida manualmente na UI,
// mesmo layout do Catálogo Completo (gerarPdfCatalogo agora delega pra
// gerarPdfCatalogoCompleto). POST porque a lista de códigos não cabe
// confortavelmente numa query string GET; body JSON simples (sem upload de
// arquivo, ao contrário do Catálogo Promocional abaixo).
router.post("/catalogo/exportar-selecionados-pdf", uploadLimiter, exportarPdfSelecionadosHandler);
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
// Serve os bytes de uma foto por NOME de arquivo em vez de índice — só usada
// pra miniatura de foto OCULTA (ver foto-ocultar abaixo), que não tem
// posição estável na lista visível. Rota mais específica ("/fotos/nome/...")
// não colide com "/fotos/:indice" acima (segmentos diferentes).
router.get("/catalogo/produtos/:codigo/fotos/nome/:nomeArquivo", servirFotoPorNomeHandler);
// Escolhe manualmente qual foto é a principal de um produto (pedido do
// usuário, 2026-09-02) — ver comentário no handler/catalogo-fotos.service.js.
router.post("/catalogo/produtos/:codigo/foto-preferida", definirFotoPreferidaHandler);
// Oculta (ou restaura, com { oculta:false }) uma foto do produto — nunca
// deleta do zip/X2, só esconde da exibição (pedido do usuário, 2026-09-02;
// ver ocultarFoto/catalogo-fotos.service.js).
router.post("/catalogo/produtos/:codigo/foto-ocultar", ocultarFotoHandler);
// Envia uma foto do computador do atendente pra completar a galeria de um
// produto (nova função, pedido do usuário 2026-09-08) — guardada separada
// do X2, sobrevive a qualquer resync (ver adicionarFotoManual/
// catalogo-fotos.service.js). uploadLimiter reaproveitado dos outros
// uploads da mesma rota (promocional/preços acima) — mesmo throttle,
// mesmo motivo (upload é ação eventual do atendente, não tráfego normal).
router.post("/catalogo/produtos/:codigo/fotos/upload", uploadLimiter, uploadFotoManual.single("foto"), adicionarFotoHandler);
// Corrige a Linha de um produto específico (pedido do usuário, 2026-09-05 —
// achado real: M02051/M02038 cadastrados como "AMPERÍMETRO" em vez de
// "MANÔMETRO DO ÓLEO", confirmado ao vivo contra o próprio X2). `{ linha:
// "" }` remove a correção manual — ver definirLinhaProduto/catalogo-x2.service.js.
router.post("/catalogo/produtos/:codigo/linha", definirLinhaProdutoHandler);
// Sugestões de Seção/Linha pro formulário "Editar categoria" acima — todas
// as Linhas já cadastradas em cada Seção, evita duplicata por digitação.
router.get("/catalogo/categoria-linhas", listarCategoriaLinhasHandler);
// Versão global do "estado das fotos" — o frontend embute como ?v=<versao>
// em toda URL de foto pra garantir cache-busting real (ver comentário em
// versaoFotosHandler/catalogo-fotos.service.js).
router.get("/catalogo/fotos-versao", versaoFotosHandler);

module.exports = router;
