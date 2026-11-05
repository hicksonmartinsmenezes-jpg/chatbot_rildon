/**
 * catalogo-pdf.service.js — gera o PDF de "catálogo expresso" (pedido do
 * usuário, 2026-07-28): exporta em PDF, com foto, o resultado de uma busca
 * do painel de Catálogo de Produtos (por veículo, por Seção/Linha/Fabricante,
 * ou por código isolado) — pra mandar pro cliente ou imprimir.
 *
 * Histórico do layout (tudo no mesmo dia, 2026-07-28):
 * v1 — catálogo impresso "ASX" (barra colorida sobre a foto): ficou
 *      "desajustado" na avaliação do usuário.
 * v2 — grid estilo e-commerce (outro modelo que ele mandou): card branco,
 *      borda fina, foto centralizada numa área própria, código em azul e
 *      nome em negrito ABAIXO da foto, sem preço (pedido explícito, "por
 *      enquanto"). Essa ficou aprovada como base.
 * v3 — ajustes finos pedidos sobre a v2:
 *   - ROWS_POR_PAGINA=4 fixo (era ESCALA=0.8 fixo na foto) — é o que faz 4
 *     linhas de card caberem por página em vez de 3, sem mudar as 4 colunas.
 *   - photoBoxHeight agora é CALCULADO: pega a altura disponível da página,
 *     divide por 4 linhas, subtrai tudo que é texto fixo (código+nome+
 *     paddings) e o que sobra vira altura da foto. Assim, se o tamanho da
 *     fonte do código/nome mudar de novo no futuro, a foto cresce/encolhe
 *     sozinha pra preencher o espaço, sem sobrar vão branco embaixo.
 *   - Borda do card mais grossa (0.75pt → 1.75pt).
 *   - "Efeito vidro de leve": sombra suave em camadas (sem blur nativo no
 *     pdfkit, então empilha retângulos arredondados translúcidos) e cantos
 *     arredondados — fundo do card é branco chapado (pedido do usuário: o
 *     gradiente azul-pálido testado antes deixava o fundo "azul" em vez de
 *     branco), só a sombra por baixo tem cor.
 *
 * Rodapé (2026-07-28, pedido do usuário: "use exatamente esse modelo como
 * rodapé" / depois "deixe exatamente essa foto"): imagem real da logo
 * Rildon (src/assets/catalogo-rodape.png, enviada pelo usuário — 2ª versão,
 * já recortada exatamente no banner, sem espaço em branco em volta),
 * desenhada na largura inteira da página em toda página do PDF.
 * RODAPE_IMG_RATIO reflete a proporção exata desse arquivo (1372×156) —
 * FOOTER_HEIGHT é calculada a partir dela, então a imagem NUNCA é
 * distorcida (largura = página inteira, altura = largura ÷ proporção). Se
 * o usuário trocar o arquivo de novo por um com proporção diferente,
 * RODAPE_IMG_RATIO precisa ser atualizada junto. Nº de página escrito por
 * cima, no canto direito, onde a arte permanece azul (fora da cunha branca
 * diagonal).
 *
 * Cabeçalho (2026-07-29, pedido do usuário: "coloque exatamente isso sem
 * alterações como cabeçalho"): mesma lógica do rodapé — imagem opaca
 * (src/assets/catalogo-cabecalho.png, 456×92) cobrindo a largura inteira da
 * página, HEADER_HEIGHT calculada a partir de CABECALHO_IMG_RATIO pra nunca
 * distorcer. Título/subtítulo "RILDON PEÇAS"/"Catálogo Expresso" e o nome
 * da seção continuam desenhados por cima, nas mesmas posições de antes (a
 * área onde entram é cinza-claro/branca na arte, dá contraste suficiente
 * pro texto escuro sem precisar mudar cor).
 *
 * Borda + caixa do código (2026-07-29, mesmo dia, pedido seguinte): usuário
 * mandou print de um card real de outro e-commerce ("Sensor de
 * Estacionamento") pedindo pra bater a borda e "a caixa". Medido pixel a
 * pixel: borda ciano #00aeef bem mais grossa (era cinza fina), cantos
 * QUADRADOS (RAIO_CARD virou 0), e o código do fabricante virou uma CAIXA
 * cheia (#005aaa, texto branco) sobreposta no canto superior esquerdo da
 * FOTO — não é mais texto azul solto abaixo da foto (ver
 * _desenharCaixaCodigo). Isso liberou o espaço que o código ocupava
 * embaixo, que virou altura extra de foto (mesmo princípio de "preencher
 * espaço" da v3).
 *
 * Reusa a mesma fonte de fotos do painel (catalogo-fotos.service, que lê sob
 * demanda dos zips em src/config/catalogo-x2/fotos/ — ver comentário lá).
 * pdfkit só embute JPEG/PNG nativamente; produto com foto em outro formato
 * (ou sem foto cadastrada) cai no aviso "sem foto" em vez de quebrar a
 * exportação inteira.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const jpeg = require("jpeg-js");
const { ehMesmaFoto, limparCacheAhash } = require("./catalogo-foto-duplicada");
const { obterFoto } = require("./catalogo-fotos.service");
const { listarMarcasVeiculoConhecidas } = require("./catalogo-x2.service");

// Mapa codigo -> "Cód. Fornecedor" (2026-07-29): fonte extraída direto da
// própria tela de busca do X2 (mesma técnica/arquivo já usado antes pra
// achar as fotos — ver src/config/catalogo-x2/cod-fornecedor.json), NÃO a
// `ficha.referencia` que o catalogo-x2.service.js expõe. Motivo: a
// `referencia` às vezes vem com o fabricante GRUDADO nela mesma (ex:
// "IK2118 - IKRO"), enquanto esse mapa traz o código de fabricante puro
// (ex: "IK2118"), sem nenhum texto extra. Cobertura confirmada em
// 2026-07-29: 100% dos 17.417 produtos do catálogo tinham entrada aqui.
// Produto sincronizado DEPOIS dessa extração (via x2-catalogo-sync.js) não
// vai estar nesse mapa — nesse caso o rótulo cai pro fallback antigo
// (fabricante + referencia limpa) em vez de quebrar.
// 2026-10-14: src/config/catalogo-x2/ e gitignored (~157MB, gerado pelo
// scraper -- ver comentario no .gitignore) e nao existe em checkout novo
// (CI, clone recem-feito, ambiente de teste). Antes isso quebrava o
// require deste modulo inteiro (ENOENT direto no carregamento), o que por
// sua vez derrubava catalogo.controller.js -> catalogo.routes.js -> toda
// suite que so queria montar as rotas com os servicos mockados. O mapa ja
// era projetado pra ter buracos (ver comentario acima: produto fora dele
// cai no fallback antigo), entao "arquivo ausente" vira so mapa vazio,
// igual a todo produto estar fora dele -- comportamento real em producao
// (onde o arquivo existe) nao muda nada.
let CODIGO_FORNECEDOR_MAP;
try {
  CODIGO_FORNECEDOR_MAP = new Map(
    JSON.parse(fs.readFileSync(path.join(__dirname, "../config/catalogo-x2/cod-fornecedor.json"), "utf8"))
      .map(item => [String(item.codigo), item.cod_fornecedor])
  );
} catch (e) {
  console.warn("[catalogo-pdf.service] cod-fornecedor.json indisponivel (" + (e.code || e.message) + ") -- rotulo de fornecedor cai no fallback antigo pra todo produto.");
  CODIGO_FORNECEDOR_MAP = new Map();
}

// Carregada uma única vez no require — reusada em toda geração de PDF, sem
// I/O repetido por página.
//
// 2026-08-27 (revertido no mesmo dia): tentativa de trocar cabeçalho/rodapé
// por uma versão gerada a partir de um SVG de referência mandado pelo
// usuário ("padronize cabeçalho e rodape exatamente desse jeito, com lados
// preenchidos") — usuário achou o resultado "terrível" e pediu pra voltar
// pro cabeçalho/rodapé de antes. Revertido de volta pro arquivo original
// (o mesmo desde 2026-07-28). "Preencher os lados" nas laterais continua
// pendente/não resolvido — se for pedido de novo, considerar outra
// abordagem (ex: pedir uma arte já preenchida direto pro usuário, em vez
// de tentar reconstruir automaticamente).
//
// O rodapé tem uma área branca real (o triângulo onde o nº de página é
// desenhado, ver RODAPE_NUM_X_FRACAO/Y_FRACAO abaixo, pedido explícito
// 2026-07-28 "número centralizado ali"), e a mesma imagem também tem a
// LOGO e o texto "www.rildoneletro.com.br" em branco desenhados dentro do
// próprio arquivo — qualquer preenchimento automático de fundo branco
// precisa proteger essa área pra não apagar a logo por engano.
const RODAPE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-rodape.png"));
// Proporção exata do arquivo acima (1372×156 px) — ver comentário no topo
// do arquivo sobre por que isso precisa bater com a imagem de verdade.
const RODAPE_IMG_RATIO = 1372 / 156;

// 2026-08-31 (Catálogo Promocional, pedido do usuário: "poderá ser por linha
// ou por fabricante, padronize esses cabeçalhos e rodapés para o catalogo
// promocional e remova margens"): 4 artes NOVAS, dedicadas só ao Catálogo
// Promocional (gerarPdfCatalogoPromocional) — nunca usadas no Catálogo
// Completo/Expresso, que continuam com CABECALHO_IMG/RODAPE_IMG de sempre.
// Vêm de 2 mockups mandados pelo usuário (prints do WhatsApp), um pra cada
// "modo" de agrupamento pedido:
//   - "linha": título dinâmico é o NOME DA LINHA (ex.: "Alternadores"), pode
//     ter produtos de fabricantes diferentes dentro (fabricante aparece na
//     descrição do produto, como já é hoje) — cor azul-claro (#126DBC).
//   - "fabricante": título dinâmico é o NOME DO FABRICANTE (ex.: "Gauss",
//     "Perfect") — todos os produtos daquele card vêm do mesmo fabricante —
//     cor navy (#205490).
// Diferente de CABECALHO_IMG/RODAPE_IMG (que têm margem branca real no
// arquivo original e por isso precisam do zoom de bleed
// CABECALHO_ESCALA_BLEED/CABECALHO_CONTEUDO_*_FRACAO), esses 4 arquivos já
// foram recortados exatamente na borda do desenho (sem nenhuma margem
// branca sobrando) — "remova margens" foi resolvido no PRÓPRIO ARQUIVO, não
// precisa de zoom/sangria em tempo de desenho: basta esticar pra largura
// inteira da página (width=w) na altura real (height=w/ratio), y=0 pro
// cabeçalho e y=alturaPágina-altura pro rodapé — mesmo princípio de
// RODAPE_IMG_RATIO/CABECALHO_IMG_RATIO (altura sempre derivada da proporção
// real do arquivo, nunca esticada/espremida).
// O texto "Nome da categoria"/"Catálogo de marca" (cabeçalho) e "Página 1"
// (rodapé) que vinham desenhados NOS mockups originais foram apagados
// (pintados por cima com a cor sólida de fundo, medida pixel a pixel) —
// esse texto agora é dinâmico, desenhado por código em
// _desenharCabecalhoPromo/_desenharRodapePromo, igual ao padrão já usado em
// _desenharCabecalho/_desenharRodape pro Catálogo Completo.
const PROMO_CABECALHO_LINHA_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-cabecalho-linha.png"));
const PROMO_CABECALHO_LINHA_RATIO = 1085 / 151;
const PROMO_RODAPE_LINHA_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-rodape-linha.png"));
const PROMO_RODAPE_LINHA_RATIO = 1083 / 57;
const PROMO_CABECALHO_FABRICANTE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-cabecalho-fabricante.png"));
// 2026-09-01: usuário substituiu o arquivo de arte (pedido: "remova esse
// cabeçalho e coloque exatamente esse no lugar") por uma versão nova,
// 727×127 (antes 1099×193 — mesmo desenho, arquivo de origem diferente).
// RATIO precisa bater com as dimensões REAIS do arquivo atual, senão
// _desenharCabecalhoPromo distorce a imagem ao redimensionar pra largura da
// página (ver `h = w / ratio` lá).
const PROMO_CABECALHO_FABRICANTE_RATIO = 727 / 127;
const PROMO_RODAPE_FABRICANTE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-rodape-fabricante.png"));
const PROMO_RODAPE_FABRICANTE_RATIO = 1069 / 149;

// Área segura pro título dinâmico (fração da largura/altura do cabeçalho,
// medida pixel a pixel na arte já sem margem — mesmo princípio de
// RODAPE_NUM_X_FRACAO/Y_FRACAO abaixo): retângulo onde dá pra escrever texto
// sem invadir a faixa amarela/diagonal decorativa da arte.
const PROMO_TITULO_AREA = {
  linha: { xFrac0: 0.014, yFrac0: 0.053, xFrac1: 0.746, yFrac1: 0.642, cor: "#ffffff" },
  fabricante: { xFrac0: 0.02, yFrac0: 0.06, xFrac1: 0.67, yFrac1: 0.94, cor: "#ffffff" },
};
// Logo opcional no cabeçalho do modo "fabricante" (Issue #74): retângulo
// dentro da faixa azul-clara do canto direito da arte (medido pixel a pixel:
// a faixa vai de x≈567/727 a 726/727 e y≈21/127 a 95/127, com a diagonal
// recuando à esquerda conforme desce — o retângulo abaixo fica sempre dentro).
const PROMO_LOGO_AREA = { xFrac0: 0.80, xFrac1: 0.985, yFrac0: 0.19, yFrac1: 0.72 };
const PROMO_LOGOS_DIR = path.join(__dirname, "../assets/marcas-promocional");

// `chave` vem do cliente (campo `logo` do form): só aceita [a-z0-9-] e só
// devolve arquivo que existe na pasta fixa acima — nunca um caminho livre.
function carregarLogoPromocional(chave) {
  const k = String(chave || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(k)) return null;
  const arquivo = path.join(PROMO_LOGOS_DIR, `${k}.png`);
  try { return fs.readFileSync(arquivo); } catch { return null; }
}

// Centro do texto "Página N" (fração da largura/altura do rodapé) — mesma
// técnica de RODAPE_NUM_X_FRACAO/Y_FRACAO, mas aqui o texto é "Página N"
// (não só o número) pra bater exatamente com o mockup original, na mesma
// cor escura que o mockup já usava ali.
const PROMO_PAGINA_AREA = {
  linha: { xFrac: 0.943, yFrac: 0.561, cor: "#0b3a5c" },
  // 2026-08-31 (usuário pediu mockup fiel, depois voltou atrás no mesmo
  // dia: "deixe os lados preenchidos como o anterior que eu tinha pedido,
  // o rodapé também deixe os lados preenchidos" — ou seja, quer o MESMO
  // tratamento "preenche o canto" já aplicado na arte linha na 5ª rodada
  // (commit 4636918), não fidelidade ao mockup original). Recortado sem as
  // margens (mockup tinha ~32px reais dos dois lados, medidos pixel a
  // pixel — removidas de propósito aqui, igual foi feito pra linha) —
  // xFrac/yFrac recalculados pro novo asset (1069×149).
  fabricante: { xFrac: 0.948, yFrac: 0.718, cor: "#0b3a5c" },
};

// Pedido do usuário (2026-07-29): "coloque exatamente isso sem alterações
// como cabeçalho" — arte da cunha cinza/azul (mesma família visual do
// rodapé), usada tal como enviada, sem recortar/recolorir. O arquivo
// original enviado era só 456×92px SEM anti-aliasing (bordas diagonais já
// vinham serrilhadas no próprio arquivo) — esticado pra largura da página
// inteira isso ficou visivelmente pixelado ("qualidade caiu muito", relatado
// pelo usuário). Reamostrei o arquivo 8x com PIL/LANCZOS só pra suavizar esse
// serrilhado — a arte/cores/proporção continuam EXATAMENTE as mesmas, isso
// não é recriar o design, é só anti-aliasing que o arquivo original não tinha.
//
// 2026-07-29 (mesmo dia, versão 2): usuário mandou um 2º arquivo dessa arte
// (719×157px, proporção ligeiramente diferente da 1ª versão — provavelmente
// reexportado do Canva, nome do arquivo "Design sem nome (2).png") pedindo
// de novo "sem perdas de qualidade" — mesmo problema de origem (sem
// anti-aliasing no arquivo). Apliquei o MESMO tratamento (upscale 8x
// LANCZOS) preventivamente, sem esperar reclamação de novo. Se o usuário
// mandar uma versão já em alta resolução/vetorial no futuro, dá pra usar
// direto sem esse passo.
const CABECALHO_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-cabecalho.png"));
// Proporção exata do arquivo ATUAL — mesmo princípio do rodapé:
// HEADER_HEIGHT é derivada disso, nunca um valor fixo arbitrário, pra imagem
// nunca esticar/espremer. Se o usuário trocar esse arquivo de novo, essa
// proporção precisa ser remedida.
//
// 2026-07-30: pedido do usuário "suba um pouco mais o cabeçalho" — medi a
// imagem original (719×157) e havia margem branca real acima/abaixo do
// desenho (linhas 0-3 e 151-156 são brancas de verdade, sem nenhum pixel da
// arte). Recortei essa margem (ficou 719×149, começando/terminando exato no
// desenho) ANTES de aplicar o upscale 8x LANCZOS de sempre — isso NÃO
// distorce nem recorta a arte em si, só tira espaço em branco que não fazia
// parte do desenho.
//
// 2026-07-30 (mesmo dia, request seguinte): usuário notou que "a parte
// cinza está encostando no título" — medi pixel a pixel e o bico da cunha
// cinza chega bem perto do fundo da imagem numa faixa de x que cai embaixo
// do texto do título (ex: em x≈120/719 o cinza vai até a linha 143 de 157,
// a ~9px do fundo). Resolvido de duas formas juntas: (1) recortei mais um
// pouquinho do topo (linhas 0-5 em vez de 0-2 — a única coisa perdida aqui é
// a pontinha bem fina do pico azul, ~2px de 157, praticamente imperceptível
// no impresso, o resto do topo já era uma borda reta cobrindo a largura
// inteira) — ficou 719×146; (2) o título deixou de ficar SOBREPOSTO à
// imagem — agora é desenhado só DEPOIS que a arte termina (ver
// _desenharCabecalho), então não tem mais como encostar na arte, não
// importa até onde o bico do desenho desça.
const CABECALHO_IMG_RATIO = 719 / 146;

// 2026-07-30 (mesmo dia, 3ª rodada): usuário pediu "suba mais um pouco o
// cabeçalho" de novo. Naquela época, já não sobrava margem branca de
// verdade pra recortar do arquivo sem começar a cortar a própria cunha
// diagonal — o desenho é uma cunha inteira que ESTREITA de ~98% de largura
// no topo até um ponto no fundo, então o sangria (y negativo, "a imagem
// sangra pra fora do topo da página, a parte que passa de y=0 fica
// invisível") já mostrava quase o desenho inteiro, incluindo a parte de
// baixo, mais estreita — sobrava bastante branco nas laterais ali.
//
// 2026-08-27: pedido do usuário "preciso que suba mais o cabeçalho e
// preencha os lados" — resolvido em duas partes. (1) "preencha os lados":
// medi pixel a pixel (script Python/numpy+scipy) e confirmei que o branco
// nas laterais era real, não miragem visual — a cunha cobre só ~43% da
// largura na altura onde o cabeçalho terminava antes. Reprocessei o PNG
// (mesma técnica de inpainting 2D usada uma vez só, arquivo salvo direto
// em src/assets/catalogo-cabecalho.png — não é código, é o asset em si)
// pra "esticar" a cor de cada pixel branco até o vizinho colorido mais
// próximo, preenchendo TODO o retângulo do cabeçalho de lateral a
// lateral, sem nenhuma distorção/estica da cunha original (ela continua
// visível por cima, só o fundo que era branco virou cinza/azul). Seguro
// fazer isso aqui porque essa imagem NÃO tem texto/logo desenhado nela —
// título é sempre desenhado por código, depois, por cima (ver
// _desenharCabecalho) — diferente do rodapé, que tem logo+texto brancos
// embutidos na própria imagem e por isso NÃO recebeu o mesmo tratamento
// (risco real de apagar a logo por engano — ver comentário em RODAPE_IMG).
// (2) "suba mais": com o cabeçalho inteiro preenchido (sem mais branco pra
// se preocupar em não cortar), sangria subiu de 16 pra 32 — header fica
// mais baixo/compacto, título e cards começam mais cedo na página.
//
// 2026-08-27 (revertido — ver comentário em RODAPE_IMG acima): a tentativa
// de arte nova tinha zerado essa sangria (arquivo já vinha sem margem
// branca no topo). Revertido de volta pro arquivo/arte original, que
// precisa da sangria de 32 de novo.
//
// 2026-08-28: pedido do usuário "quero que a ponta do cabeçalho tope no
// canto direito" — medido pixel a pixel (mesmo arquivo, 719×146): com
// sangria=32, a fatia visível da arte (a partir da linha 309 de 1168px)
// já perdeu a parte mais larga do desenho — a ponta azul só chega a
// ~88% da largura da página, sobrando um vão branco real no canto
// direito. A linha y=0 do arquivo (a borda de cima da própria cunha) já
// cobre ~99% da largura sozinha (x≈44 a x≈5702 de 5752px) — zerando a
// sangria, quase toda a largura aparece sem precisar reprocessar a
// imagem (a mesma técnica de inpainting já tentada antes e revertida por
// causar artefato visual). Troca de: header fica mais alto na página
// (usa a altura REAL da imagem inteira, ~120.9pt, era ~88.9pt com
// sangria=32) — inevitável pra mostrar a parte mais larga da cunha; se o
// usuário achar o cabeçalho grande demais depois, dá pra revisitar.
// 2026-10-19: pedido do usuário "no cabeçalho suba mais um pouco; se as pontas
// cinzas não encostarem, pode esticar um pouco" — sobe CABECALHO_SANGRIA_TOPO pt
// (parte de cima da arte fica fora da página) e, como a cunha vai afinando
// pra baixo (a ponta direita perde ~2.1px de arte por linha), a imagem é
// ESTICADA SÓ NA HORIZONTAL (CABECALHO_ESTICAR_X) pra ponta cinza voltar a
// encostar na borda direita. Medido no PNG 5752×1168: tinta começa em x=46 e,
// na linha da sangria (~133px), termina em x≈5432.
const CABECALHO_SANGRIA_TOPO = 26; // 2026-10-19: 14 -> 26 ("suba mais o cabeçalho")

// 2026-08-28 (mesmo dia, pedido seguinte): "cole mais o cabeçalho na
// esquerda e direita" — medido pixel a pixel no MESMO arquivo (719×146,
// upscalado 8x = 5752×1168): na borda de cima da arte (onde a cunha é mais
// larga), o desenho de verdade começa em x=44 e termina em x=5702 de
// 5752px — sobra uma margem branca REAL de ~0.76% da largura à esquerda e
// ~0.87% à direita que nunca fez parte do desenho (mesma classe de
// problema do vão vertical acima, só que nas laterais). Fix: a arte é
// desenhada num ZOOM leve e uniforme — mesma escala nos dois eixos, não
// distorce a cunha — grande o bastante pra empurrar as duas margens
// brancas pra fora da página (bleed horizontal), então a parte colorida
// encosta nas duas bordas sem sobrar vão branco. É a mesma técnica que já
// tinha sido usada uma vez só na página do índice (INDICE_CABECALHO_ESCALA,
// removida no commit anterior) — mas agora a escala vem de medição exata
// (não um valor arbitrário como o 1.08 antigo) e é aplicada nas DUAS
// funções que desenham cabeçalho (_desenharCabecalho e
// _desenharCabecalhoIndice), então elas continuam idênticas uma à outra —
// não reabre a inconsistência "padronize o cabeçalho" que o usuário pediu
// pra tirar antes.
const CABECALHO_CONTEUDO_ESQUERDA_FRACAO = 44 / 5752;
const CABECALHO_CONTEUDO_DIREITA_FRACAO = 5702 / 5752;
const CABECALHO_ESCALA_BLEED = 1 / (CABECALHO_CONTEUDO_DIREITA_FRACAO - CABECALHO_CONTEUDO_ESQUERDA_FRACAO);

// Centro do triângulo branco da arte (pedido do usuário, 2026-07-28: número
// da página centralizado ali) — medido pixel a pixel na imagem real
// (1372×156): o triângulo tem o ápice perto de x≈1065/y≈0 e alarga pra
// baixo, ficando sempre centrado horizontalmente em x≈1060-1065. Escolhido
// y≈130 (não o fundo exato, y=155) pra sobrar respiro pro texto não
// encostar na borda inferior da página. Se a imagem do rodapé for trocada
// de novo, essas frações também precisam ser remedidas.
const RODAPE_NUM_X_FRACAO = 1062 / 1372;
const RODAPE_NUM_Y_FRACAO = 108 / 156;

// 2026-08-28: pedido do usuário "ajuste pra folha A4 escala 100% pra
// preencher a folha inteira" (depois esclarecido: "observe as margens de
// cima, de baixo e dos lados do papel") — o PDF já é A4 exato (595.28×
// 841.89pt, conferido com pdfinfo) e cabeçalho/rodapé já vão de borda a
// borda (ver CABECALHO_ESCALA_BLEED acima), sem faixa branca real ali. A
// margem que sobrava era a desse PAGE_MARGIN — 24pt (≈8.5mm) de cada lado
// do grid de cards, a maior faixa branca "de verdade" na página. Reduzido
// pra 10pt (≈3.5mm), mantendo uma margem de segurança mínima pro
// texto/código dos cards não correr risco de ser cortado por impressoras
// comuns (a maioria não imprime até a borda física sem um modo
// "sem margem" específico — diferente do cabeçalho/rodapé, que são arte
// decorativa e toleram um corte de alguns mm sem perder informação).
const PAGE_MARGIN = 10;
// Pedido do usuário (2026-07-31): "caiba o máximo de itens possíveis" — era
// 4 colunas. Foto/fontes/respiros foram encolhidos (ver ROWS_POR_PAGINA,
// PAD_CARD, CODIGO_FONTE/CODIGO_ALTURA, NOME_FONTE/NOME_ALTURA,
// GAP_DIVISORIA_TEXTO/GAP_FOTO_DIVISORIA abaixo) pra caber 5×6 = 30
// produtos por página (era 4×4 = 16) sem descaracterizar o card (ainda tem
// foto + código + nome, cabeçalho/rodapé da marca do mesmo tamanho de
// sempre) — usuário escolheu "deixa comigo" entre um meio-termo (~30/pág)
// e um modo mais agressivo (lista sem foto).
// 2026-09-19: COLS/ROWS_POR_PAGINA abaixo pararam de ser usadas por
// gerarPdfCatalogo (agora delega pra gerarPdfCatalogoCompleto, que usa
// COLS_COMPLETO/ROWS_POR_PAGINA_COMPLETO — ver comentário na função).
// Mantidas aqui (não deletadas) só como referência histórica da grade
// 5×6 antiga — Knip pode acusar como não usadas, é esperado.
const COLS = 5;
const GAP = 10;
// Largura de desenho da imagem do cabeçalho — página inteira (595.28pt em
// A4) MULTIPLICADA pelo zoom de bleed (ver CABECALHO_ESCALA_BLEED acima),
// e o X de desenho correspondente (negativo — a imagem começa um pouco
// antes da borda esquerda da página, de propósito, é o bleed).
const CABECALHO_IMG_LARGURA_BASE = 595.28 * CABECALHO_ESCALA_BLEED;
const CABECALHO_PX_L = 5752, CABECALHO_PX_A = 1168, CABECALHO_TINTA_ESQ_PX = 46;
const CABECALHO_ALTURA_BASE = CABECALHO_IMG_LARGURA_BASE / CABECALHO_IMG_RATIO;
// fim (px) da tinta na linha de corte da sangria: ~5699 - 2.12/linha (medido)
const CABECALHO_LINHA_CORTE_PX = CABECALHO_SANGRIA_TOPO * CABECALHO_PX_A / CABECALHO_ALTURA_BASE;
const CABECALHO_TINTA_DIR_PX = CABECALHO_SANGRIA_TOPO > 0 ? 5720 - 2.12 * CABECALHO_LINHA_CORTE_PX : 5699;
const CABECALHO_ESTICAR_X = (595.28 * 1.003 * CABECALHO_PX_L / (CABECALHO_TINTA_DIR_PX - CABECALHO_TINTA_ESQ_PX)) / CABECALHO_IMG_LARGURA_BASE;
const CABECALHO_IMG_LARGURA_DESENHO = CABECALHO_IMG_LARGURA_BASE * (CABECALHO_SANGRIA_TOPO > 0 ? CABECALHO_ESTICAR_X : 1);
const CABECALHO_IMG_X_DESENHO = -(CABECALHO_TINTA_ESQ_PX / CABECALHO_PX_L) * CABECALHO_IMG_LARGURA_DESENHO;
// Altura REAL/undistorcida da imagem do cabeçalho — calculada a partir da
// proporção verdadeira do arquivo e da largura de desenho acima (já com
// bleed), sem esticar/espremer o desenho (pedido do usuário original:
// "sem alterações" — o zoom aplicado é uniforme nos dois eixos, então a
// proporção da arte continua intacta). Usada só pra desenhar a imagem em
// si (ver _desenharCabecalho) — todo o resto do layout usa HEADER_HEIGHT
// (abaixo), que é a altura VISÍVEL na página (menor, por causa da
// sangria).
const CABECALHO_IMG_ALTURA_REAL = CABECALHO_ALTURA_BASE; // esticar só na horizontal
// Altura visível do cabeçalho na página — desconta a sangria (a imagem é
// desenhada em y negativo, então essa fatia do topo fica fora da página,
// invisível). Título, cards etc. usam ESTA altura, não a real.
const HEADER_HEIGHT = CABECALHO_IMG_ALTURA_REAL - CABECALHO_SANGRIA_TOPO;
// Calculada a partir da proporção real da imagem — largura sempre = página
// inteira, então a altura sai daqui, sem esticar/espremer o desenho.
const FOOTER_HEIGHT = 595.28 / RODAPE_IMG_RATIO;

// Pedido do usuário (2026-07-30, 2ª rodada): "a parte cinza está encostando
// no título" — o título ANTES ficava sobreposto à própria imagem do
// cabeçalho (posicionado por um offset negativo a partir de HEADER_HEIGHT),
// o que só funcionava enquanto sobrava margem branca de verdade ali dentro.
// Depois de recortar essa margem (ver CABECALHO_IMG_RATIO acima), o bico da
// cunha cinza passou a chegar perto demais do texto. Solução: o título agora
// é desenhado SÓ DEPOIS que a arte termina — TITULO_GAP_TOPO é o respiro
// entre o fim da imagem e o início do título, então não tem mais como
// encostar na arte, seja qual for o formato dela.
const TITULO_GAP_TOPO = 15;
// Pedido do usuário (2026-07-30, 1ª rodada): "desça mais o título, quase
// encostando nos produtos, deixe a distância parecida como a das colunas" —
// a distância entre o título e o topo dos cards é EXATAMENTE o mesmo valor
// do respiro entre colunas (GAP), em vez de um número arbitrário.
const TITULO_GAP_CARDS = 24; // 2026-10-19: 12 -> 24 ("desça do primeiro fabricante pra baixo")

// Pedido do usuário (2026-07-28): 4 linhas de card por página em A4 (antes
// cabiam só 3). A altura da foto NÃO é mais uma escala fixa — é calculada
// dinamicamente (ver gerarPdfCatalogo) pra sempre preencher exatamente o
// espaço vertical disponível pras ROWS_POR_PAGINA linhas, sem sobrar vão
// em branco embaixo (pedido do usuário: "preencher mais o espaço em branco
// que ficou aumentando as caixas das fotos") nem faltar espaço se o
// tamanho da fonte do código/nome mudar de novo no futuro.
// 2026-07-31: subiu pra 6 linhas (junto com COLS=5 acima) pra caber o
// máximo de produtos possível por página — ver comentário no COLS.
const ROWS_POR_PAGINA = 6;

// 2026-07-31: encolhido de 8 pra 5 (junto com o resto do bloco de texto
// abaixo) pra sobrar mais altura de linha útil pras ROWS_POR_PAGINA extras
// (ver comentário no COLS/ROWS_POR_PAGINA acima).
const PAD_CARD = 5;       // respiro interno do card (o "desajustado" da v1 era falta disso)
// Pedido do usuário (2026-07-29): referência mandada (site com cards de
// "Sensor de Estacionamento") tem cantos QUADRADOS, não arredondados —
// RAIO_CARD virou 0 (era 6). Ver também BORDA_CARD/BORDA_CARD_ESPESSURA
// logo abaixo, medidos pixel a pixel na imagem de referência.
const RAIO_CARD = 0;
// Pedido do usuário (2026-07-28): código do fabricante em 11pt (era 8pt) e
// nome/descrição maior (era 7pt, agora 9pt, depois 8pt em 2026-07-30).
// 2026-07-30 (request seguinte, mesmo dia): usuário pediu pra tirar a CAIXA
// do código de cima da foto e juntar o código de novo com a descrição
// abaixo da foto (voltando a ter uma faixa de texto própria) — por isso
// CODIGO_ALTURA volta a existir aqui (tinha sido removida quando o código
// virou caixa/badge).
// 2026-07-31: todo esse bloco de texto (código+nome+respiros) encolhido de
// novo — pedido do usuário "caiba o máximo de itens possíveis" (ver COLS/
// ROWS_POR_PAGINA acima). Prioridade foi manter a PROPORÇÃO fonte↔altura de
// linha de antes (CODIGO_ALTURA/CODIGO_FONTE e NOME_ALTURA/NOME_FONTE
// seguem a mesma razão ~1.36-1.37x), só em escala menor — o texto continua
// legível, só ocupa menos espaço fixo, sobrando mais altura pra foto em
// cada uma das 6 linhas.
// 2026-08-27: código voltou a ser um SELO sobre a foto (_desenharCaixaCodigo)
// — CODIGO_ALTURA e GAP_CODIGO_NOME abaixo ficaram SEM USO no bloco de texto
// (não entram mais em alturaFixaTexto nem em _desenharCard), mas mantidas
// documentadas caso o código volte a virar linha de texto solta de novo (já
// foi e voltou 2x neste arquivo — ver histórico dos comentários acima).
// CODIGO_FONTE continua em uso (fonte do texto dentro do próprio selo).
const CODIGO_FONTE = 8;
// 2026-08-27: pedido do usuário — "no card do meu codigo por mais que ele
// seja grande nunca deixe '...' sempre coloque completo nem que precise
// reduzir tamanho". Piso de segurança pro auto-encolhimento de fonte do
// selo (ver _ajustarFonteSeloParaCaber) — só entra em jogo em código
// absurdamente longo; na prática nenhum código real do catálogo chega perto.
const CODIGO_FONTE_MIN = 4;
const CODIGO_ALTURA = 11; // sem uso atualmente — ver comentário acima
const NOME_FONTE = 6;
const NOME_ALTURA = 16;  // ~2 linhas no tamanho novo
// Espaço entre a linha divisória e o bloco de texto (nome) — pedido
// do usuário 2026-07-30 "desça um pouco mais" (era GAP_DIVISORIA_NOME=10,
// usado quando só o nome ficava aqui; depois 12; "desça mais a descrição
// se possível" — mais uma rodada, agora 16). Nomeado como constante porque
// entra também no cálculo de alturaFixaTexto lá embaixo — evita os dois
// lugares dessincronizarem.
// 2026-07-31: reduzido de 16 pra 6 — junto com o resto do bloco de texto
// (ver comentário acima em CODIGO_FONTE), pra caber mais linhas de card.
const GAP_DIVISORIA_TEXTO = 6;
// 2026-08-27: "desça mais um pouco" o nome, pedido específico sobre o card
// do Catálogo Completo (comAplicacao=true) — respiro ADICIONAL somado só
// nesse modo, em cima do GAP_DIVISORIA_TEXTO padrão acima (que continua
// valendo sozinho pro catálogo comum).
// SEM USO desde o redesenho do card do Catálogo Completo (mesmo dia,
// pedido seguinte: referência visual "SENSOR DE TEMPERATURA") — o nome
// saiu de baixo da foto e foi pro cabeçalho, lado a lado com o selo (ver
// _desenharCardCatalogoCompleto). Mantida documentada, não removida, caso
// o layout antigo (nome abaixo da foto) volte a ser usado no futuro.
const GAP_DIVISORIA_TEXTO_EXTRA_COMPLETO = 5;
// Respiro entre o código e o nome — sem uso atualmente (ver comentário
// acima em CODIGO_ALTURA), mantida documentada pelo mesmo motivo.
const GAP_CODIGO_NOME = 2; // era 3 — reduzido em 2026-07-31, mesmo motivo acima
// Respiro entre o fim da foto e a linha divisória — era um "5" hardcoded
// direto no cálculo (gerarPdfCatalogo) e em alturaFixaTexto; virou
// constante nomeada em 2026-07-31 (reduzida pra 3) pra não desencontrar os
// dois lugares, mesmo motivo do resto deste bloco.
const GAP_FOTO_DIVISORIA = 3;

// Bloco de "aplicação organizada" (Issue #23, pedido do usuário 2026-08-26)
// — texto de veículo/máquina compatível, já reorganizado pela IA (ver
// catalogo-aplicacao-ia.service.js), exibido abaixo do nome do produto. SÓ
// no modo "Catálogo Completo" (comAplicacao=true em _geometriaGrid/
// _desenharCard) — o catálogo expresso comum não ganha esse bloco, mantém
// a grade mais densa (5×6) sem mudança. Altura reservada é FIXA (entra em
// alturaFixaTexto abaixo) independente de o produto ter ou não aplicação
// organizada em cache — isso mantém a foto do mesmo tamanho em toda a
// grade, evitando cards desalinhados entre si numa mesma linha.
const APLICACAO_FONTE = 5.5;
// 2026-08-27: usuário pediu "padronize até 3 linhas na Aplicação" — era 13
// (~2 linhas), textos mais longos cortavam no meio de uma palavra/vírgula
// (ver teste real "FORD: Cargo 712, 814, 815, 915, 1317E,"). Aumentado pra
// caber uma 3ª linha antes do ellipsis entrar em ação.
// 2026-08-27 (ajuste seguinte, reorganização do card): "aplicação até duas
// linhas" — reduzida de volta pra caber só 2 linhas (a 3ª agora corta com
// "..." via ellipsis:true em _desenharCardCatalogoCompleto).
const APLICACAO_ALTURA = 15; // ~2 linhas nesse tamanho
// 2026-08-27: usuário pediu "desça mais as aplicações no card" — era 3,
// mais respiro entre o fim do nome e o início do bloco de aplicação.
const APLICACAO_GAP = 9;     // respiro entre o nome e esse bloco
// 2026-08-27: usuário mandou um card de referência ("SENSOR DE
// TEMPERATURA") de outro catálogo pedindo "ajuste melhor... aplicação" —
// era cinza claro (#4b5563), quase ilegível na referência mandada, virou
// preto igual ao resto do texto do card.
const APLICACAO_COR = "#111827";

// --- Redesenho do card do Catálogo Completo (2026-08-27, 3ª rodada) ---
// Layout MUDOU DE NOVO — pedido do usuário, com esboço em texto:
//   codigo do fabricante
//   codigo original
//
//         *foto*
//
//   codigo da loja + Descrição resumida
//   aplicação até duas linhas
// Ou seja: cabeçalho volta a ser só o selo do fabricante + código
// original/OEM, EMPILHADOS (não mais lado a lado com a descrição — essa
// desceu). Descrição agora fica embaixo da foto, resumida numa linha só
// junto com o código da loja (produto.codigo, o código interno — diferente
// do código do fabricante que vai no selo azul). Aplicação limitada a até
// 2 linhas, logo abaixo dessa linha de resumo.
// Código OEM/equivalente em vermelho, embaixo do selo (ex: "A011.542.96.17"
// na referência) — usa o 1º item de `produto.equivalentes` (já indexado por
// catalogo-x2.service.js), sem novo campo/dado a buscar.
// 2026-08-27: "reduza o tamanho dos códigos originais" — era 6.5.
const OEM_FONTE = 5.5;
const OEM_COR = "#dc2626"; // mesmo vermelho de VERMELHO_CATEGORIA
const OEM_ALTURA = 8;      // 1 linha
const GAP_BADGE_OEM = 3;   // respiro vertical entre o selo e o código OEM
const GAP_HEADER_FOTO = 6; // respiro entre o cabeçalho (selo+OEM) e a foto
// Respiro horizontal entre as 2 fotos, quando o produto tem 2+ cadastradas
// (pedido do usuário, 2026-09-05 — ver comentário completo junto ao
// desenho da foto em _desenharCardCatalogoCompleto).
const GAP_DUAS_FOTOS = 4;

// Pedido do usuário (2026-09-05): o código OEM/equivalente em vermelho
// (acima) às vezes vem do X2 com acento, vírgula ou traço dentro do valor
// (ex: "CITROËN:1525VZ", "YN-AMGM015") — aqui padroniza só a EXIBIÇÃO desse
// selo específico, sem tocar no dado bruto (produto.equivalentes/
// ficha.equivalentesLista continuam intactos em catalogo-x2.service.js —
// usados também pra busca por código equivalente, que já ignora pontuação
// nessa comparação via _normalizarCodigo, então não tinha bug funcional
// aqui, só estética no PDF). Acento removido via NFD (mesma técnica de
// _chaveLogoFabricante, acima); vírgula e traço removidos por substituição
// direta.
function _limparCodigoOemParaExibicao(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[,-]/g, "")
    .trim();
}
// Linha de resumo abaixo da foto: "código da loja + descrição resumida",
// 1 linha só (a descrição completa saiu daqui — ficou "resumida" mesmo,
// corta com "..." se não couber; ver TITULO_FONTE em
// _desenharCardCatalogoCompleto, mesma fonte do selo/OEM).
// 2026-08-27 (ajuste seguinte): "deixe o tamanho da fonte da descrição um
// pouco menor e que caiba tudo de forma resumida" — era 6.5, reduzida pra
// 5.5 (mesmo tamanho do OEM/aplicação) pra sobrar mais espaço na linha e
// cortar menos cedo com "...".
const RESUMO_FONTE = 5.5;
const RESUMO_ALTURA = 8;        // 1 linha nesse tamanho
// 2026-08-28: pedido do usuário "descer um pouquinho a descrição" — era 6,
// subiu pra 9. Mesmo dia, pedido seguinte "desça mais descrição" — sobe
// de novo, 9 pra 13. Como _geometriaGrid deriva photoBoxHeight subtraindo
// essa constante da altura total do card, a foto encolhe automaticamente
// esses mesmos pontos — não precisa mexer em mais nada pra layout
// continuar batendo certo.
const GAP_FOTO_RESUMO = 16;     // respiro entre a foto e a linha de resumo (era 13 — 2026-10-19, "desce um pouquinho mais a descrição")
const GAP_RESUMO_APLICACAO = 3; // respiro entre a linha de resumo e a aplicação

// Cor do texto do código — pedido do usuário (2026-07-30): "azul oceano/
// petróleo", rgb(0, 96, 151), mais sóbrio que o azul do painel usado antes.
const AZUL = "#006097";

// Pedido do usuário (2026-07-29): "use isso de referência, preciso que
// fique exatamente assim as bordas e caixa" — cor medida pixel a pixel na
// imagem de referência (site real de e-commerce, cards de "Sensor de
// Estacionamento"): borda ciano rgb(0,174,239) = #00aeef, bem mais grossa
// que a cinza anterior.
// 2026-08-27: ajuste fino de cor pedido pelo usuário — #00aeef -> #00AFEF
// (praticamente o mesmo tom, 1 dígito de diferença no canal G).
const BORDA_CARD = "#00afef";
const BORDA_CARD_ESPESSURA = 3; // era 1.75 (cinza) — bem mais grossa, igual à referência
// 2026-08-27 (mesmo dia, request seguinte): "na borda de dentro da parte
// branca coloque um preto" — 2ª borda, fina e preta, desenhada por DENTRO
// da borda ciano (ver _desenharCardVidro), enquadrando a área branca do
// card. BORDA_CARD_INTERNA_GAP é a distância entre a borda ciano e essa
// borda preta interna.
const BORDA_CARD_INTERNA = "#000000";
const BORDA_CARD_INTERNA_ESPESSURA = 0.75;
// 2026-08-27 (mesmo dia, ajuste fino): "cole essa preta como na referência"
// — usuário circulou o canto do card mostrando que sobrava vão branco
// entre a ciano e a preta (era 3, ficou colada quase na borda ciano).
const BORDA_CARD_INTERNA_GAP = 1;
// Pedido do usuário (2026-07-30): "remova o fundo de vidro" — CINZA_SOMBRA
// não é mais usada (era a cor da sombra em camadas do efeito vidro, ver
// _desenharCardVidro). Mantida como constante só documentada, não removida,
// caso o efeito volte a ser pedido no futuro.
const CINZA_SOMBRA = "#9aa1ab";
const VERMELHO_CATEGORIA = "#dc2626";
// Caixa cheia do código (pedido do usuário 2026-07-29, "a caixa" da
// referência) — cor medida na mesma imagem: rgb(0,90,170) = #005aaa.
// Pedido do usuário (2026-07-30, request seguinte): tirar essa caixa de cima
// da foto e voltar o código pra junto da descrição, abaixo da foto (ver
// _desenharCaixaCodigo — função mantida, só não é mais chamada em
// gerarPdfCatalogo — e o bloco código+nome logo abaixo). Constantes abaixo
// mantidas documentadas caso o design da caixa volte a ser pedido.
const CAIXA_CODIGO_FUNDO = "#005aaa";
const CAIXA_CODIGO_TEXTO = "#ffffff";
// Pedido do usuário (2026-07-30): "encurte um pouco o diâmetro da caixa
// azul pra ficar ajustada ao tamanho do código" — reduzido de 7 pra 4
// (menos respiro nas laterais, caixa mais colada ao texto).
const CAIXA_CODIGO_PAD_H = 4;
// Pedido do usuário (2026-07-30, mesmo request): "ajuste a altura das
// background dos códigos pra ficar na altura exata do código, se tiver
// espaço remova". CAIXA_CODIGO_ALTURA fixa (18) foi removida — a altura da
// caixa agora é CALCULADA a partir da altura real da linha de texto no
// fontSize do código (doc.currentLineHeight()) + esse respiro vertical
// mínimo, não mais um valor arbitrário.
// 2026-08-27 (mesmo dia, request seguinte): "deixe a altura do tamanho do
// código mesmo para ganharmos espaço" — reduzido de 3 pra 1, caixa mais
// colada ao texto (era um respiro perceptível em cima/embaixo do código).
const CAIXA_CODIGO_PAD_V = 1;

// 2026-08-29 ("Catálogo Promocional", nova função — pedido do usuário: "na
// parte superior direita iremos deixar um espaço para preços", "por
// produto, em cada card"): badge de preço promocional, canto superior
// DIREITO do card — o mesmo espaço que hoje fica vazio ao lado do selo do
// código (canto superior esquerdo, ver _desenharCardCatalogoCompleto).
// Preço é OPCIONAL por produto (usuário sobe um CSV código->preço próprio,
// nem todo código selecionado precisa vir nele) — sem preço pro código, o
// card simplesmente não desenha o badge (ver _desenharBadgePreco), sem
// placeholder feio tipo "R$ --".
// 2026-09-01 (pedido do usuário: "no background do preço deixe amarelo") —
// era verde (#0f8a3c) + texto branco; amarelo (#FFCB2A, mesmo tom da faixa
// diagonal da arte do cabeçalho/rodapé promocional, ver
// src/assets/catalogo-promocional-cabecalho-*.png) exige texto escuro em
// vez de branco pra manter contraste — reaproveita o #111827 já usado no
// texto de aplicação/descrição do card, não um cinza/preto novo.
const BADGE_PRECO_FUNDO = "#FFCB2A";
const BADGE_PRECO_TEXTO = "#111827";
const BADGE_PRECO_FONTE = 7;

// Formata um preço numérico (Number ou string numérica) em "R$ 1.234,56" —
// mesma convenção pt-BR já usada no frontend (_formatarPrecoBRL em
// 18-catalogo.js), reimplementada aqui porque o PDF é gerado no backend,
// sem acesso ao código do frontend. `null`/`undefined`/NaN retornam null
// (chamador decide não desenhar nada nesse caso).
function _formatarPrecoPdf(valor) {
  const num = Number(valor);
  if (!Number.isFinite(num)) return null;
  return "R$ " + num.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Desenha o badge de preço no canto superior direito da área de conteúdo do
// card (xConteudo/yTopo/larguraConteudo = mesmos parâmetros já usados pro
// selo do código, ver _desenharCardCatalogoCompleto). `larguraSelo` é
// passada só pra checar colisão: em código de fabricante muito longo o
// selo (canto esquerdo, largura variável — nunca trunca, ver
// _ajustarFonteSeloParaCaber) pode ocupar quase o card inteiro; nesse caso
// raro, em vez de desenhar o preço por cima do selo, o badge é
// silenciosamente OMITIDO nesse card específico (o preço continua correto
// nos outros cards da mesma leva/página — não vale complicar o layout por
// um caso de borda de código gigante).
function _desenharBadgePreco(doc, preco, xConteudo, yTopo, larguraConteudo, larguraSelo) {
  const texto = _formatarPrecoPdf(preco);
  if (!texto) return;

  doc.font(TITULO_FONTE).fontSize(BADGE_PRECO_FONTE);
  const larguraTexto = doc.widthOfString(texto);
  const larguraBadge = larguraTexto + CAIXA_CODIGO_PAD_H * 2 + 1.5;
  const alturaLinha = doc.currentLineHeight();
  const alturaBadge = alturaLinha + CAIXA_CODIGO_PAD_V * 2;

  const xBadge = xConteudo + larguraConteudo - larguraBadge;
  const yBadge = yTopo;

  if (xBadge < xConteudo + larguraSelo + 4) return; // colidiria com o selo — omite

  doc.rect(xBadge, yBadge, larguraBadge, alturaBadge).fillColor(BADGE_PRECO_FUNDO).fill();
  doc.fillColor(BADGE_PRECO_TEXTO).font(TITULO_FONTE).fontSize(BADGE_PRECO_FONTE)
    .text(texto, xBadge + CAIXA_CODIGO_PAD_H, yBadge + CAIXA_CODIGO_PAD_V, {
      width: larguraBadge - CAIXA_CODIGO_PAD_H * 2,
      height: alturaLinha,
      lineBreak: false,
      align: "center",
    });

  doc.fillColor("#111827").font("Helvetica");
}

// 2026-10-19 (pedido do usuário: "se padronizarmos nos catálogos de
// elétrica a corrente e tensão no canto superior direito?"): selo de
// ESPECIFICAÇÃO ELÉTRICA — "12V | 90A" — no canto superior direito do card,
// na mesma altura do selo do código (canto esquerdo), pra o balconista bater
// o olho e ver a tensão/corrente sem ler a descrição. Lê primeiro o campo
// estruturado da ficha (dadosTecnicos: "Tensão: 12V\nCorrente: 90A" /
// "Voltagem: 12V") e, na falta dele, o padrão do nome do X2 ("... 12V 90A
// ..."). Só aparece se achar ao menos um dos dois; nunca inventa valor.
// Não desenha no Catálogo Promocional (o canto direito é do preço) nem no
// estilo Mecânica. Seções sem relação com elétrica (mecânica, filtros,
// química, consumo, engates) ficam de fora pra "12V" solto no nome de uma
// peça mecânica não virar selo.
const SECOES_SEM_SELO_ELETRICO = /MEC[ÂA]NICA|FILTRO|QU[ÍI]MICA|CONSUMO|ENGATE/i;
const SELO_ELETRICO_FUNDO = "#e6eef8";
const SELO_ELETRICO_TEXTO = "#005aaa";
const SELO_ELETRICO_FONTE = 7;

function _limparEspecEletrica(texto) {
  return String(texto).replace(/\s*\/\s*/g, "/").replace(/,/g, ".").replace(/\s+/g, "").toUpperCase();
}

function _extrairEspecEletrica(produto) {
  if (SECOES_SEM_SELO_ELETRICO.test(String(produto.secao || ""))) return null;
  const dados = String(produto.dadosTecnicos || "");
  const nome = String(produto.nome || "");

  let tensao = null;
  const linhaTensao = dados.match(/^\s*(?:Tens[aã]o|Voltagem)[^:\n]*:\s*(.+)$/im);
  const reTensao = /(\d{1,2}(?:[.,]\d)?(?:\s*\/\s*\d{1,2})?)\s*V(?:OLTS?|DC)?\b/i;
  const mTensao = (linhaTensao && linhaTensao[1].match(reTensao)) || nome.match(new RegExp("\\b" + reTensao.source, "i"));
  if (mTensao) tensao = _limparEspecEletrica(mTensao[1]) + "V";

  let corrente = null;
  const linhaCorrente = dados.match(/^\s*(?:Corrente|Amperagem)[^:\n]*:\s*(.+)$/im);
  const reCorrente = /(\d{1,4}(?:\s*\/\s*\d{1,4})?)\s*A(?:MP(?:ERES?)?)?(?![A-Za-z0-9])/i;
  const mCorrente = (linhaCorrente && linhaCorrente[1].match(reCorrente)) || nome.match(new RegExp("\\b" + reCorrente.source, "i"));
  if (mCorrente) corrente = _limparEspecEletrica(mCorrente[1]) + "A";

  if (!tensao && !corrente) return null;
  return { tensao, corrente };
}

// Desenha o selo no canto superior direito. Mesma altura do selo do código;
// se o selo do código ocupar quase o card inteiro (código gigante) e o
// selo elétrico colidir, ele é omitido naquele card — mesma regra do badge
// de preço.
function _desenharSeloEletrico(doc, spec, xConteudo, yTopo, larguraConteudo, larguraSelo, alturaSelo) {
  if (!spec) return;
  const partes = [spec.tensao, spec.corrente].filter(Boolean);
  doc.font(TITULO_FONTE).fontSize(SELO_ELETRICO_FONTE);
  const larguras = partes.map(t => doc.widthOfString(t));
  const sep = partes.length === 2 ? 5 : 0; // espaço do divisor entre tensão e corrente
  const larguraBadge = larguras.reduce((a, b) => a + b, 0) + sep + CAIXA_CODIGO_PAD_H * 2 + 1.5;
  const xBadge = xConteudo + larguraConteudo - larguraBadge;
  if (xBadge < xConteudo + larguraSelo + 4) return; // colidiria com o selo do código — omite

  const alturaLinha = doc.currentLineHeight();
  const yTexto = yTopo + (alturaSelo - alturaLinha) / 2;
  doc.rect(xBadge, yTopo, larguraBadge, alturaSelo).fillColor(SELO_ELETRICO_FUNDO).fill();
  doc.fillColor(SELO_ELETRICO_TEXTO).font(TITULO_FONTE).fontSize(SELO_ELETRICO_FONTE);
  let x = xBadge + CAIXA_CODIGO_PAD_H + 0.75;
  partes.forEach((t, i) => {
    doc.text(t, x, yTexto, { width: larguras[i] + 2, height: alturaLinha, lineBreak: false });
    x += larguras[i];
    if (i === 0 && partes.length === 2) {
      const xDiv = x + sep / 2;
      doc.moveTo(xDiv, yTopo + 2).lineTo(xDiv, yTopo + alturaSelo - 2)
        .lineWidth(0.6).strokeColor(SELO_ELETRICO_TEXTO, 0.55).stroke();
      x += sep;
    }
  });
  doc.fillColor("#111827").font("Helvetica");
}

// Pedido do usuário (2026-07-28): título da seção ("AMORTECEDORES" etc.) em
// "Futura Md BT" 17pt. Fonte recebida em 2026-08-26 (arquivo .ttf enviado
// pelo usuário, peso Bold Italic — único peso disponível; o desenho de
// referência que o usuário mandou junto (3-RHO.pdf) já usa esse mesmo
// peso itálico em todos os títulos, então não há necessidade de um peso
// reto/regular aqui). Registrada como fonte nomeada no pdfkit
// (doc.registerFont) — TITULO_FONTE_ARQUIVO é o caminho do arquivo,
// TITULO_FONTE é o nome interno usado depois em doc.font(TITULO_FONTE).
const TITULO_FONTE_ARQUIVO = path.join(__dirname, "../assets/fonts/Futura-Md-BT-Bold-Italic.ttf");
const TITULO_FONTE = "FuturaMdBT-BoldItalic";
const TITULO_TAMANHO = 17;
// 2026-08-31 (pedido do usuário: "padronize fonte montserrat 40px" pro
// título do cabeçalho do Catálogo Promocional) — fonte separada de
// TITULO_FONTE porque essa é usada em muitos outros lugares do arquivo
// (código do produto, índice, selo de preço) que não foram tocados por
// esse pedido; só o título grande de _desenharCabecalhoPromo usa
// PROMO_TITULO_FONTE. Peso Bold Italic (baixado via @fontsource/montserrat
// e convertido de woff2 pra ttf com fonttools) pra manter a inclinação
// itálica que já existia no mockup original — se o usuário pedir reto,
// trocar pro peso Bold normal (sem "-italic" no nome do arquivo fonte).
const PROMO_TITULO_FONTE_ARQUIVO = path.join(__dirname, "../assets/fonts/Montserrat-BoldItalic.ttf");
const PROMO_TITULO_FONTE = "Montserrat-BoldItalic";
const PROMO_TITULO_TAMANHO = 30;
// 2026-08-31 (pedido do usuário: comparou o cabeçalho fabricante renderizado
// ["SEM FABRICANTE IDENTIFICADO"] com o mockup ["Catálogo de marca"] e achou
// "distorcido" — o fundo (png) bate exato pixel a pixel com o mockup
// (conferido), a diferença real é só o título: 40px + nomes de fabricante
// mais longos que "Catálogo de marca" (18 caracteres) força o loop de
// auto-encolher a reduzir bastante a fonte, ficando desproporcional ao
// mockup. Usuário escolheu, entre as opções oferecidas: fonte máxima menor
// e fixa (em vez de partir de 40 e só encolher), sem centralizar tanto —
// só o modo "fabricante" muda; "linha" continua 40px centralizado (pedido
// explícito da 5ª rodada, ver PROMO_TITULO_AREA/histórico no início do
// arquivo).
const PROMO_TITULO_TAMANHO_FABRICANTE = 24;

// Pedido do usuário (2026-09-08): "padronize essa fonte para o número nos
// rodapés" (arquivo enviado, Gloucester MT Extra Condensed) — troca só o
// NÚMERO DE PÁGINA que aparece no rodapé (Helvetica-Bold até aqui), nos 3
// estilos de rodapé que o serviço desenha: elétrica e mecânica
// (_desenharRodape) e promocional (_desenharRodapePromo). Constante única
// reaproveitada nas 3 chamadas de doc.registerFont (uma por função
// geradora de PDF) — mesmo padrão de TITULO_FONTE/PROMO_TITULO_FONTE acima.
const RODAPE_NUMERO_FONTE_ARQUIVO = path.join(__dirname, "../assets/fonts/Gloucester-MT-Extra-Condensed.ttf");
const RODAPE_NUMERO_FONTE = "GloucesterMTExtraCondensed";

// --- Estilo "Mecânica" do Catálogo Completo (pedido do usuário, 2026-09-03) ---
// Até aqui o Catálogo Completo tinha UM template visual só (o "estilo
// elétrica", calibrado a partir do 3-RHO.pdf original — ver TITULO_FONTE/
// CAIXA_CODIGO_FUNDO/COLS_COMPLETO/ROWS_POR_PAGINA_COMPLETO acima, e o
// histórico de comentários no topo do arquivo). Usuário mandou um 2º
// conjunto de mockups (grade com guias de medição do CorelDRAW, igual à
// técnica já usada pra calibrar o estilo elétrica) pra um "estilo
// mecânica" — usado no catálogo do fabricante PERFECT (ver
// _estiloCatalogoCompleto abaixo). Medido pixel a pixel nos mockups
// ("Marcação de Cards de Produtos Mecânica - 01/02.png", 406×577 —
// proporção A4 quase exata, 0.704 vs 0.707 real):
//   - Selo do código: NÃO é mais um selo pequeno ajustado ao texto (como
//     no estilo elétrica, ver CAIXA_CODIGO_FUNDO) — é uma barra AMARELA
//     que ocupa a largura inteira do card, texto centralizado.
//   - Cores medidas direto nos pixels do mockup (amostra em x=350,
//     y=74-86 pra amarelo/laranja, y=39-52 pra navy do título de seção):
//     amarelo #ffca01, laranja/vermelho #f1471b (acento, não usado ainda
//     nesta 1ª versão — ver limitações no PR), navy #001760.
//   - Grade: mesmas 4 colunas do estilo elétrica (COLS_COMPLETO já serve,
//     não precisa de uma constante de colunas separada), mas só 4 linhas
//     por página (era 5) — cabeçalho "PERFECT AUTOMOTIVE" do mockup é mais
//     alto que a cunha fina do cabeçalho elétrica, sobra menos altura útil.
//   - Fonte do título de seção: arquivo novo enviado junto (Montserrat
//     ExtraBold, family completa baixada do Google Fonts pelo usuário —
//     bem maior que os outros .ttf estáticos deste projeto, 191KB vs
//     ~35-49KB, mas ainda um TTF estático comum, registra normal no
//     pdfkit).
// LIMITAÇÃO CONHECIDA (documentada no PR): o cabeçalho/rodapé de PÁGINA
// (arte "PERFECT AUTOMOTIVE" cheia, cunha decorativa, rodapé da marca)
// ainda NÃO tem asset próprio — o usuário confirmou que "já temos o
// design das páginas" e que o pedido desta rodada é especificamente
// alinhar os CARDS às grades tracejadas, não extrair/recriar a arte de
// cabeçalho a partir do mockup (que tem linhas de medição sobrepostas,
// não é arte limpa). Catálogo do fabricante PERFECT continua usando
// CABECALHO_IMG/RODAPE_IMG (arte Rildon padrão) até o usuário mandar a
// arte definitiva — só o GRID DE CARDS (selo, cores, 4×4) e o TÍTULO DE
// SEÇÃO (barra navy) usam o estilo novo.
const MECANICA_BADGE_FUNDO = "#ffca01";
const MECANICA_BADGE_TEXTO = "#001760";
const MECANICA_TITULO_FUNDO = "#001760";
const MECANICA_TITULO_TEXTO = "#ffffff";
const ROWS_POR_PAGINA_COMPLETO_MECANICA = 4;
const MECANICA_TITULO_FONTE_ARQUIVO = path.join(__dirname, "../assets/fonts/Montserrat-ExtraBold.ttf");
const MECANICA_TITULO_FONTE = "Montserrat-ExtraBold";

// Decide qual estilo visual o Catálogo Completo usa pra um fabricante —
// fixo por fabricante (decisão do usuário: "3RHO sempre usa o template
// elétrica, PERFECT sempre usa o template mecânica"). Qualquer fabricante
// que não seja PERFECT cai no estilo elétrica (comportamento de sempre,
// nenhuma mudança pros outros ~3600 fabricantes cadastrados). Comparação
// por "includes" (não igualdade exata) pra tolerar variação de digitação
// no nome do fabricante extraído do nome do produto (ver
// catalogo-x2.service.js) — ex.: "PERFECT" isolado ou dentro de um nome
// mais longo continuam batendo.
//
// Pedido do usuário (2026-09-03): separação Mecânica/Elétrica dentro do
// MESMO fabricante (ex. "PERFECT - Elétrica" só com os produtos da seção
// X2 "MECÂNICA" excluídos, ver tipoCompleto/catalogo-x2.service.js). Sem o
// parâmetro tipoCompleto, o "PERFECT - Elétrica" herdaria errado o estilo
// "mecanica" só por causa do .includes("PERFECT") acima — então
// tipoCompleto === "eletrica" força o estilo "eletrica" incondicionalmente,
// e tipoCompleto === "mecanica"/null preserva o comportamento de sempre.
//
// CORRIGIDO (2026-09-22, pedido do usuário: "itens que existem Mecânica no
// cadastro preciso que virem catálogos específicos de Mecânica [...]
// padronize mesmo template e layout de perfect"): o lado de DADOS já
// oferecia "{fabricante} - Mecânica" como opção pra QUALQUER fabricante com
// produto na seção MECÂNICA, não só PERFECT (ver
// listarFabricantesCatalogoCompleto em catalogo-x2.service.js — tipoCompleto
// chega aqui certinho pra qualquer um deles). Mas esta função só decidia o
// ESTILO VISUAL "mecanica" checando o NOME "PERFECT" — pra todo fabricante
// diferente de PERFECT, mesmo selecionando "{fabricante} - Mecânica" no
// seletor, o PDF saía no estilo "eletrica" por engano (nunca padronizava
// com o layout do PERFECT como o pedido original de 2026-09-03 pretendia).
// Agora tipoCompleto === "mecanica" força o estilo "mecanica"
// incondicionalmente (era só "eletrica" que tinha esse tratamento) — o
// fallback por nome (.includes("PERFECT")) continua existindo só pra
// chamadas antigas sem tipoCompleto (ex.: scripts/x2-drive-lancamentos.js,
// que chama ?fabricante=PERFECT sem esse parâmetro).
function _estiloCatalogoCompleto(fabricante, tipoCompleto = null) {
  // Catálogo com layout PRÓPRIO do fabricante (Arielo, 2026-10-01) — ver
  // catalogo-pdf-arielo.service.js. Vale antes de qualquer outra regra.
  if (/ARIELO/i.test(String(fabricante || ""))) return "arielo";
  if (tipoCompleto === "mecanica") return "mecanica";
  if (tipoCompleto === "eletrica") return "eletrica";
  return String(fabricante || "").toUpperCase().includes("PERFECT") ? "mecanica" : "eletrica";
}

// Pedido do usuário (2026-09-04, arquivo de referência "Mecânica.pdf" —
// exemplo real com o fabricante "Filtros Brasil"): fundo em degradê azul
// claro cobrindo a página INTEIRA (não só uma faixa no cabeçalho), logo do
// FABRICANTE no topo (não a arte genérica Rildon), e rodapé trocado pra
// "Grupo Rildon" + "OMRE+ Distribuidora de Peças Automotivas" — só nos
// catálogos Mecânica; Elétrica continua 100% com CABECALHO_IMG/RODAPE_IMG
// genéricos de sempre (decisão explícita do usuário nas 3 perguntas de
// confirmação: fundo página inteira = sim, logo por fabricante = sim,
// rodapé só na Mecânica = sim).
//
// Cores do degradê amostradas por pixel no PDF de referência (não é uma
// réplica pixel-a-pixel — a arte original tem uma textura diagonal sutil
// que o pdfkit não reproduz sem complexidade desproporcional ao ganho
// visual; os tons/posições dos degradês batem com o original: claro nas
// bordas topo/fundo, mais azulado no meio e antes do rodapé).
const MECANICA_GRADIENTE_STOPS = [
  { offset: 0, color: "#ffffff" },
  { offset: 0.06, color: "#c7e4f2" },
  { offset: 0.5, color: "#f7fbfe" },
  { offset: 0.92, color: "#bbe1f4" },
  { offset: 1, color: "#ffffff" },
];

// Mesmo navy da barra de título Mecânica (MECANICA_TITULO_FUNDO) — usado
// também na linha fina do cabeçalho/rodapé Mecânica v2, pra manter as
// cores consistentes entre os elementos novos e os que já existiam.
const MECANICA_LINHA_FINA_COR = MECANICA_TITULO_FUNDO;
const MECANICA_LINHA_FINA_ESPESSURA = 1.9; // ~8px @300dpi na referência

const MECANICA_RODAPE_LOGO_RILDON_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-mecanica-rodape-grupo-rildon.png"));
const MECANICA_RODAPE_LOGO_RILDON_RATIO = 473 / 125;
const MECANICA_RODAPE_LOGO_OMRE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-mecanica-rodape-omre.png"));
const MECANICA_RODAPE_LOGO_OMRE_RATIO = 447 / 129;
// Altura reservada pro rodapé Mecânica (linha navy + logos) — medida por
// pixel na referência (~56pt do fim da página até a linha).
const MECANICA_RODAPE_ALTURA = 58;

// PEDIDO DO USUÁRIO (2026-09-22): "muito espaço do cabeçalho até a linha e
// embaixo tem muito espaço também" — antes o cabeçalho Mecânica reusava
// HEADER_HEIGHT (~123pt, calculado a partir da ARTE da elétrica, CABECALHO_
// IMG_RATIO 719/146) mesmo só precisando centralizar um texto/logo de
// ~22pt, sobrando quase 50pt de vão vazio em cima E embaixo do texto até a
// linha fina navy. MECANICA_HEADER_HEIGHT é uma altura própria, medida pro
// conteúdo real do cabeçalho Mecânica (texto 22pt + respiro), e passa a ser
// usada em TODA a área do cabeçalho Mecânica — página de índice e páginas
// de conteúdo (_desenharLogoCabecalhoMecanica/_desenharCabecalho/
// _desenharCabecalhoIndice) — e também no cálculo de onde a grade de cards
// começa (areaTopoY em gerarPdfCatalogoCompleto, via overrides de
// _geometriaGrid), senão o cabeçalho encolhe mas os cards continuam
// começando na mesma altura de antes, só aumentando o vão em outro lugar.
// Ainda sobra espaço suficiente pra uma logo de fabricante de verdade
// (alturaMax = MECANICA_HEADER_HEIGHT - 16 = 44pt) quando o usuário
// registrar os arquivos em MECANICA_LOGOS_FABRICANTE.
const MECANICA_HEADER_HEIGHT = 60;

// Registry de logo por fabricante pro cabeçalho Mecânica (pedido do
// usuário: "logo de cada fabricante", 2026-09-04). Vazio de propósito:
// nenhum arquivo de logo LIMPO (sem a grade de medição/marca d'água que
// veio nas referências) foi fornecido ainda pra nenhum fabricante — a
// tentativa de recortar a logo da PERFECT a partir do print de medição
// saiu contaminada com as linhas tracejadas por cima, então não foi usada.
// _logoFabricante() cai no fallback (nome do fabricante em texto,
// MECANICA_TITULO_FONTE) até o usuário enviar arquivo limpo (PNG/SVG,
// sem marca d'água) — colocar em src/assets/logos-fabricante/<chave>.png
// e registrar aqui: "perfect": { img: fs.readFileSync(...), ratio: W/H }.
const MECANICA_LOGOS_FABRICANTE = {};

function _chaveLogoFabricante(fabricante) {
  return String(fabricante || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim().replace(/\s+/g, "-");
}

function _logoFabricante(fabricante) {
  return MECANICA_LOGOS_FABRICANTE[_chaveLogoFabricante(fabricante)] || null;
}

// Fundo em degradê cobrindo a página inteira — chamada uma vez por página
// nova, ANTES de qualquer outro desenho (cabeçalho/cards/rodapé ficam por
// cima). Só usada quando estilo === "mecanica" (ver chamadas em
// gerarPdfCatalogoCompleto).
function _desenharFundoGradienteMecanica(doc) {
  const w = doc.page.width;
  const h = doc.page.height;
  const gradiente = doc.linearGradient(0, 0, 0, h);
  MECANICA_GRADIENTE_STOPS.forEach((s) => gradiente.stop(s.offset, s.color));
  doc.rect(0, 0, w, h).fill(gradiente);
}

// Logo do fabricante (ou fallback em texto) centralizada na área do
// cabeçalho, seguida da linha fina navy — compartilhada entre
// _desenharCabecalho e _desenharCabecalhoIndice (estilo mecânica).
function _desenharLogoCabecalhoMecanica(doc, fabricante) {
  const w = doc.page.width;
  const logo = _logoFabricante(fabricante);
  // 2026-09-22: usa MECANICA_HEADER_HEIGHT (própria, mais enxuta) em vez de
  // HEADER_HEIGHT (herdada da arte da elétrica) — ver comentário na
  // constante acima.
  const alturaMax = MECANICA_HEADER_HEIGHT - 16;
  const larguraMax = 260;
  if (logo) {
    let largura = larguraMax;
    let altura = largura / logo.ratio;
    if (altura > alturaMax) {
      altura = alturaMax;
      largura = altura * logo.ratio;
    }
    doc.image(logo.img, (w - largura) / 2, (MECANICA_HEADER_HEIGHT - altura) / 2, { width: largura, height: altura });
  } else {
    // Fallback: nome do fabricante em texto (sem logo cadastrada ainda —
    // ver MECANICA_LOGOS_FABRICANTE acima).
    doc.font(MECANICA_TITULO_FONTE).fontSize(22).fillColor(MECANICA_TITULO_FUNDO)
      .text(String(fabricante || "").toUpperCase(), 0, (MECANICA_HEADER_HEIGHT - 22) / 2, { width: w, align: "center" });
    doc.fillColor("#111827").font("Helvetica");
  }
  doc.moveTo(PAGE_MARGIN, MECANICA_HEADER_HEIGHT).lineTo(w - PAGE_MARGIN, MECANICA_HEADER_HEIGHT)
    .lineWidth(MECANICA_LINHA_FINA_ESPESSURA).strokeColor(MECANICA_LINHA_FINA_COR).stroke();
}

// Pedido do usuário (2026-08-27): "esse catalogo que estou usando de
// referencia [3-RHO.pdf original], observe as descriçoes e como estão as
// aplicações, a ideia e que fique exatamente igual". O selo/descrição/
// aplicação do catálogo original usam uma fonte geométrica arredondada
// (não é Futura, não é Helvetica) que não está entre os assets do projeto
// e cuja identidade exata não foi possível confirmar. Quicksand (Google
// Fonts, open source, obtida via `npm pack @fontsource/quicksand` porque
// fonts.google.com/gstatic estão bloqueados no sandbox) foi escolhida como
// a substituta gratuita visualmente mais próxima — mesma família de curvas
// arredondadas nos "a", "o", "g". Não é o arquivo original: se o usuário
// tiver a fonte real do catálogo 3-RHO, trocar aqui é só substituir estes
// dois arquivos. Os .woff2 baixados pelo Fontsource não renderizavam no
// pdftoppm/poppler (glyphs invisíveis apesar de pdfkit/pdftotext aceitarem
// o arquivo sem erro) — convertidos para .ttf estático via Python
// fonttools (`font.flavor = None; font.save(...)`) antes de entrar no
// projeto, o que resolveu o problema.
const QUICKSAND_BOLD_ARQUIVO = path.join(__dirname, "../assets/fonts/Quicksand-Bold.ttf");
const QUICKSAND_BOLD = "Quicksand-Bold";
const QUICKSAND_MEDIUM_ARQUIVO = path.join(__dirname, "../assets/fonts/Quicksand-Medium.ttf");
const QUICKSAND_MEDIUM = "Quicksand-Medium";

// Onde o topo dos cards começa: fim da arte do cabeçalho + respiro antes do
// título + altura do título + respiro depois do título (TITULO_GAP_CARDS,
// igual ao GAP das colunas). Uma única fórmula usada tanto pra desenhar o
// título (_desenharCabecalho) quanto pra saber onde os cards começam
// (gerarPdfCatalogo) — evita os dois lugares dessincronizarem se qualquer
// uma dessas peças mudar de novo no futuro.
const AREA_TOPO_Y = HEADER_HEIGHT + TITULO_GAP_TOPO + TITULO_TAMANHO + TITULO_GAP_CARDS;

// --- Modo "Catálogo Completo" (Issue #21, pedido do usuário 2026-08-26) ---
// Grade separada da grade padrão (COLS/ROWS_POR_PAGINA acima, ajustada em
// 2026-07-31 pra "caber o máximo de itens possíveis" — pedido de outro
// contexto). O usuário mandou como referência o catálogo 3-RHO.pdf e depois
// confirmou com dois prints recortados com guias de medição do CorelDRAW
// visíveis: grade 4 colunas × 5 linhas = 20 produtos/página, mais espaçosa
// que a 5×6 do resto do sistema. Só o modo "Catálogo Completo" (por
// fabricante, sem marca/modelo/categoria) usa essa densidade — os outros
// modos de exportação continuam com COLS/ROWS_POR_PAGINA, sem mudança.
const COLS_COMPLETO = 4;
const ROWS_POR_PAGINA_COMPLETO = 5;
// 2026-10-19 (pedido do usuário: "as fotos estão muito pequenas... desce um
// pouquinho mais a descrição e aumenta imagem, deixe mais organizado"):
// medido no layout de então — card de 106,99pt com 77,4pt de texto fixo
// (selo + OEM + resumo + aplicação + respiros), sobrando só 29,59pt de
// ALTURA pra foto num quadro de 126,32pt de largura. Como a foto é
// encaixada mantendo proporção (_desenharFotoAjustada), uma peça quase
// quadrada (alternador, motor de partida) ficava com ~29pt de lado e
// desperdiçava metade da largura do quadro — daí a sensação de foto
// minúscula. 5 linhas por página era o teto que sobrava depois do texto,
// não uma escolha de leitura. Com 4 linhas o card vai a ~136pt e a foto
// mais que dobra (~56pt), sem mexer em nenhuma fonte nem no texto do card.
// Custo: ~25% mais páginas por catálogo (16 peças/página em vez de 20).
// Vale só pra ELÉTRICA — a Mecânica já roda em 4 (ver
// ROWS_POR_PAGINA_COMPLETO_MECANICA) e o Catálogo Promocional segue em 5
// (constante acima, usada lá e na conta de rebalanceamento das duas
// últimas páginas), que não foi o que o usuário pediu pra mexer.
const ROWS_POR_PAGINA_COMPLETO_ELETRICA = 4;

// BUG REAL corrigido 2026-09-01 (usuário reportou "catálogo completo não
// está gerando" — na real ficava carregando pra sempre): as 3 funções que
// geram PDF (gerarPdfCatalogo, gerarPdfCatalogoCompleto,
// gerarPdfCatalogoPromocional) desenhavam TODOS os cards num laço síncrono
// só, sem devolver o controle ao event loop em nenhum momento. Medido ao
// vivo: um fabricante grande (WEGA, 682 produtos) leva mais de 2 minutos
// pra desenhar — e o Node é single-threaded, então esses 2 minutos travam
// o processo INTEIRO (bot do WhatsApp para de responder, painel trava pra
// todo mundo, não só quem pediu o PDF), não só a resposta HTTP de quem
// pediu o catálogo. Pedido explícito do usuário: catálogo tem que
// continuar completo (sem cortar produto nenhum) — a correção não reduz
// quantidade, só devolve o controle ao event loop periodicamente durante o
// desenho, deixando o servidor respirar entre lotes de cards. O tempo
// total de geração continua parecido; o que muda é que o resto do sistema
// não fica mais refém disso.
// 2026-09-01 (medido ao vivo): a 1ª tentativa cedia a cada 20 blocos
// (~1 página) supondo que desenhar 20 cards fosse rápido — na prática um
// lote de 20 chegou a levar 4,6s (foto grande/decodificação variam muito
// de card pra card), o que ainda deixava o event loop preso por segundos
// de cada vez. Cede a cada bloco: overhead de setImmediate é
// desprezível (microssegundos) comparado ao tempo de desenhar 1 card
// (dezenas a centenas de ms), e isso garante que o servidor nunca fica
// mais que ~1 card de tempo sem poder atender outra coisa.
const CEDER_A_CADA_N_BLOCOS = 1;
function _cederEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// 2026-08-28: pedido do usuário — mostrando um catálogo de referência
// (outro material da loja) que separa os produtos em seções por MARCA DE
// VEÍCULO (ex. "MERCEDES-BENZ"), pediu pra usar esse padrão de referência
// também. Esclarecido em follow-up ("observe tenha a linha e fabricante:
// Motor de partida / Agrale / Citroen / etc"): não é pra SUBSTITUIR o
// agrupamento por Linha que já existe (Issue #21) — é pra ACRESCENTAR um
// nível: dentro de cada Linha, os cards agora ficam sub-agrupados por
// marca de veículo, com um cabeçalho inline antes de cada sub-grupo. Ver
// _agruparPorMarca/_extrairMarcas/_desenharCabecalhoMarca.
//
// Estilo do cabeçalho de marca (2ª rodada, mesmo dia — pedido do usuário
// "retire background azul da sub categoria e coloque a centralizada no
// meio com a mesma cor da linha"): a 1ª versão usava uma faixa azul
// sólida (mesma cor do selo de código); trocada por texto centralizado
// SEM fundo, na mesma cor/fonte do título de Linha (VERMELHO_CATEGORIA +
// TITULO_FONTE, com a mesma sombra de _textoComSombra) — só menor, pra
// não competir em hierarquia com o título da página. Uma divisória fina
// (LINHA_DIVISORIA, mesma cor usada no índice) desenhada logo abaixo
// mantém a separação visual clara entre sub-grupos mesmo sem o bloco de
// cor cheio.
const MARCA_HEADER_FONTE = 12;
// 2026-08-28 (3ª rodada, pedido "organize melhor os espaços entre os
// cards"): a versão anterior tinha o respiro invertido — pouco espaço
// SEPARANDO um sub-grupo do anterior (só o GAP normal de linha, 10pt) e
// bastante espaço PRENDENDO o cabeçalho aos próprios cards (PAD_V+GAP
// antigos, ~12pt combinados, sobrando uma faixa em branco logo abaixo do
// texto desde que a divisória/hr foi removida). Invertido pra seguir o
// princípio "mais perto do que rotula": bastante respiro ANTES de um
// cabeçalho novo (separa do sub-grupo anterior), pouco respiro DEPOIS
// (liga o cabeçalho às suas próprias cards).
const MARCA_HEADER_GAP_ANTES = 18; // espaço extra antes de um cabeçalho de marca que não é o 1º da página
// PEDIDO DO USUÁRIO (2026-09-14, print MASSEY FERGUSON/MAZDA): espaço
// maior especificamente quando EXATAMENTE 2 marcas caem juntas na MESMA
// PÁGINA — decidido em _calcularLayoutConteudo via 2 passadas (só dá pra
// saber quantas marcas caem numa página depois de rodar a paginação; ver
// comentário lá). Com 3+ marcas pequenas na mesma página, continua usando
// MARCA_HEADER_GAP_ANTES normal (usuário reportou "bugada" quando testei
// aplicar geral). Pra ajustar de novo no futuro, é só mudar este número.
// 2026-09-14: reduzido de 100 pra 85 ("suba apenas um pouco") — libera um
// pouco mais de espaço embaixo do card final, pra fechar mais perto do
// mesmo padrão de distância até o rodapé que as páginas de 1 marca só já
// usam (ver o preenchimentoFinal em _calcularLayoutConteudo, agora sem
// restrição de "só quando 1 marca").
const MARCA_HEADER_GAP_ANTES_DUAS_MARCAS = 85;
const MARCA_HEADER_GAP_DEPOIS = 6; // espaço entre o texto do cabeçalho e a 1ª linha de cards do sub-grupo
// Pedido do usuário (2026-08-28, follow-up "se caso uma peça aparecer
// para ford e também kia, deixe os duplicados"): produto sem marca de
// veículo identificável em aplicacaoOrganizada (campo vazio, ou nenhum
// segmento no formato "MARCA: modelos") não pode sumir do catálogo
// impresso — cai num sub-grupo catch-all ao final de cada Linha, em vez
// de ser descartado.
//
// 2026-09-05 (pedido do usuário "outras aplicações deixe em Universal /
// Diversos"): o rótulo mudou de "OUTRAS APLICAÇÕES" pro mesmo texto usado
// pra peças que já citam "Universal"/"Diversos" na aplicação
// (MARCA_UNIVERSAL_CANONICA, definida mais abaixo em _extrairMarcas — não
// dá pra referenciar direto aqui por causa da ordem de declaração, mas o
// texto tem que ser IDÊNTICO de propósito). Efeito colateral desejado: se
// uma Linha tem produto explicitamente "Universal" E produto sem marca
// nenhuma, os dois agora caem na MESMA chave do Map em _agruparPorMarca —
// um cabeçalho só, em vez de dois cabeçalhos idênticos um atrás do outro
// (o mesmo tipo de confusão que o fix de troca-de-Linha-no-meio-da-página
// resolveu um passo acima, ver `inicioDeLinha`).
const MARCA_OUTRAS = "UNIVERSAL / DIVERSOS";

// Tamanhos de fonte do índice — pedido explícito do usuário (2026-08-26):
// "Indice deixa 36pt, pg deixa 12pt... Linhas deixa 17 pt" (17pt é o mesmo
// TITULO_TAMANHO já usado nos títulos de seção — reaproveitado, não é
// coincidência).
const INDICE_TITULO_TAMANHO = 36;
const INDICE_LINHA_TAMANHO = TITULO_TAMANHO;
const INDICE_PG_LABEL_TAMANHO = 12;
// Não especificado pelo usuário — escolha própria de proporção visual (maior
// que o label "PG" pra destacar o número, sem ter sido medido/pedido na
// referência) só pra dar hierarquia ao número da página.
const INDICE_PG_NUMERO_TAMANHO = 18;
// Altura de cada linha do índice (nome + líder pontilhado + "PG nn") —
// estimada a partir do INDICE_LINHA_TAMANHO + respiro; as imagens que o
// usuário mandou confirmaram a ESTRUTURA da linha, não uma régua de altura
// exata, então esse valor é uma estimativa própria, ajustável se o resultado
// impresso ficar apertado/solto demais.
const INDICE_LINHA_ALTURA = 36;
// Tamanho de página "A4" que o pdfkit usa (595.28 × 841.89pt) — o mesmo
// doc.page.height que o resto do arquivo lê de `doc.page` depois do 1º
// addPage(). Usado SÓ no pré-cálculo de paginação do índice em
// gerarPdfCatalogoCompleto, que precisa rodar ANTES de existir uma página de
// verdade (pdfkit renderiza sequencialmente, sem "olhar adiante" pra saber
// em que página cada Linha vai cair).
const A4_LARGURA = 595.28;
const A4_ALTURA = 841.89;

// Pedido do usuário (2026-08-26): cabeçalho da página de ÍNDICE um
// pouquinho maior que o cabeçalho compartilhado (_desenharCabecalho,
// usado nas páginas de conteúdo), mas "colado" nas margens laterais
// (sem gap branco) — rodada anterior tinha zerado a escala (voltando ao
// tamanho padrão); usuário pediu um aumento pequeno de novo, então
// escala > 1 de novo (bem menor que a tentativa anterior de 1.35).
// Técnica de zoom + center-crop: a arte é desenhada mais larga que a
// página e centralizada horizontalmente — a borda da própria página
// corta simetricamente os dois lados em x=0/x=w, "colando" nas margens
// sem distorcer a arte original.
// 2026-08-28 (revertido — pedido do usuário "preciso que padronize o
// cabeçalho da primeira pagina com o restante"): o zoom de 1.08x acima
// deixava o cabeçalho do índice ligeiramente DIFERENTE do resto do PDF
// (maior, cortado nas laterais de um jeito próprio) — exatamente a
// inconsistência que o usuário pediu pra tirar. INDICE_HEADER_HEIGHT
// agora é só um alias de HEADER_HEIGHT (mesma arte, mesmo tamanho, mesma
// posição da sangria=0 — ver CABECALHO_SANGRIA_TOPO acima) — cabeçalho do
// índice fica idêntico ao das páginas de conteúdo, só o texto abaixo dele
// muda ("ÍNDICE" em vez do nome da busca, ver _desenharCabecalhoIndice).
const INDICE_HEADER_HEIGHT = HEADER_HEIGHT;

// Pedido do usuário (2026-08-26): mais respiro entre o cabeçalho e o título
// "ÍNDICE", e entre o título e a 1ª linha da lista — valores escolhidos
// (não pedidos em pt exatos) bem maiores que os respiros padrão
// (TITULO_GAP_TOPO=8 / TITULO_GAP_CARDS=10) usados no resto do PDF.
const INDICE_TITULO_GAP_TOPO = 26;
const INDICE_TITULO_GAP_LINHAS = 34;

// Início da área de conteúdo da página de índice — mesma lógica de
// AREA_TOPO_Y acima, só com as constantes maiores específicas do índice
// (cabeçalho/respiros/título) em vez das compartilhadas.
// 2026-09-22: a fórmula em si passou a ser calculada localmente dentro de
// gerarPdfCatalogoCompleto (`areaTopoYIndiceEfetivo`), porque o estilo
// mecânica precisa trocar INDICE_HEADER_HEIGHT por MECANICA_HEADER_HEIGHT
// (ver Issue #377) — não dá mais pra ser uma constante fixa de módulo.

// Pedido do usuário (2026-07-30): remover o fundo cinza clarinho atrás da
// foto (existia desde 2026-07-28 pra dar contraste com fotos de fundo
// branco) — perguntei explicitamente branco/azul-clarinho/cinza mais forte
// e o usuário escolheu branco (ou seja, tirar o cinza, sem substituir por
// outra cor). FUNDO_FOTO mantido como constante (não removida) só porque
// pode voltar a ser pedida no futuro; hoje não é mais usada no desenho do
// card (ver gerarPdfCatalogo).
const FUNDO_FOTO = "#f3f4f6";
const LINHA_DIVISORIA = "#e5e7eb"; // separa a área da foto da área de texto

// Rótulo azul de cada card: só o código de fabricante (ex: "AMD0637"), sem
// o nome do fabricante junto (pedido explícito do usuário, 2026-07-30: "
// remova o nome dos fabricantes, deixe apenas o codigo mesmo") — é o
// código que o cliente reconhece, não o código interno de estoque. Cai pro
// código interno só se a peça não tiver código de fabricante cadastrado.
//
// Bug achado em 2026-07-29 (usuário: "não está captando especificamente
// apenas os códigos de fabricante"): a `referencia` que vem da ficha às
// vezes já traz o fabricante GRUDADO nela (ex: "IK2118 - IKRO"), coisa que
// catalogo-x2.service.js preserva de propósito "pra exibição". Primeira
// correção (mesmo dia) só cortava a parte depois do " - ", mas o usuário
// apontou que existe uma fonte melhor: o mapa `CODIGO_FORNECEDOR_MAP` (ver
// topo do arquivo), extraído direto do site X2, sem nenhuma sujeira. Esse
// mapa é a fonte PRIMÁRIA; o corte por " - " continua só como fallback pra
// produto que não estiver no mapa (sincronizado depois da extração).
// 2026-10-19: produto novo (lançamento sincronizado depois da extração do
// cod-fornecedor.json, sem ficha) não tinha código de fabricante nem
// referencia, então o selo do topo caía pro código da LOJA — igual ao de
// baixo (ex: induzidos MARILIA 129452-4; 211 produtos no total). O X2 nomeia
// o produto no padrão "DESCRIÇÃO - FABRICANTE - CÓDIGO", então o último
// trecho depois de " - " é o código do fabricante. Aceita um espaço interno
// ("IK 5582" -> "IK5582", mesmo formato do mapa) e recusa trechos que são
// quantidade/embalagem ("PCT C/ 50", "KIT 2") ou o próprio código da loja.
const _PREFIXOS_NAO_CODIGO = new Set(["PCT", "C/", "KIT", "CX", "PAR", "UN", "UND", "JOGO", "JG", "PC", "PCS"]);
function _codigoFabricanteDoNome(produto) {
  const partes = String(produto.nome || "").split(" - ");
  if (partes.length < 2) return null;
  const ultimo = partes[partes.length - 1].trim();
  const tokens = ultimo.split(/\s+/);
  if (tokens.length > 2 || ultimo.length > 26 || !/\d/.test(ultimo)) return null;
  if (_PREFIXOS_NAO_CODIGO.has(tokens[0].toUpperCase())) return null;
  const codigo = tokens.join("");
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-/]*$/.test(codigo)) return null;
  if (codigo === String(produto.codigo)) return null;
  return codigo;
}

function _rotuloProduto(produto) {
  // Catálogos de layout próprio (Arielo): o card representa uma FAMÍLIA de
  // códigos (EST349 = EST800349/EST600349…), então o rótulo vem de fora.
  if (produto._rotuloOverride) return produto._rotuloOverride;
  const codigoFornecedor =
    CODIGO_FORNECEDOR_MAP.get(String(produto.codigo)) ||
    (produto.referencia ? String(produto.referencia).split(" - ")[0].trim() : null) ||
    _codigoFabricanteDoNome(produto);
  return codigoFornecedor || String(produto.codigo);
}

// Altura do selo do código, dado o fontSize/fonte fixos (CODIGO_FONTE em
// TITULO_FONTE) — não depende do texto (só a LARGURA varia por produto),
// então pode ser calculada uma vez e reusada tanto em _geometriaGrid quanto
// em _desenharCardCatalogoCompleto sem duplicar a fórmula.
function _alturaSelo(doc) {
  // 2026-08-27: "a fonte do meu codigo e descrição deixe futura mb bt" —
  // voltou a usar TITULO_FONTE (era QUICKSAND_BOLD, testado no pedido
  // anterior). Usa CODIGO_FONTE "cheio" (não o tamanho encolhido de um
  // código específico) de propósito: é o valor usado só pela geometria do
  // grid (_geometriaGrid), que precisa de uma altura de cabeçalho ÚNICA pra
  // todos os cards da mesma linha — reserva o pior caso (maior altura
  // possível). O auto-encolhimento por código (ver
  // _ajustarFonteSeloParaCaber) só reduz a LARGURA reservada por card
  // individual, nunca aumenta a altura além deste valor de referência.
  doc.font(TITULO_FONTE).fontSize(CODIGO_FONTE);
  return doc.currentLineHeight() + CAIXA_CODIGO_PAD_V * 2;
}

// 2026-08-27: pedido do usuário — "no card do meu codigo por mais que ele
// seja grande nunca deixe '...' sempre coloque completo nem que precise
// reduzir tamanho". Antes o selo cortava com ellipsis quando o texto não
// cabia em larguraMaxima (50% do conteúdo do card); agora, em vez de
// cortar, encolhe o fontSize em passos de 0.5pt até caber (ou até bater no
// piso CODIGO_FONTE_MIN) — o texto do código NUNCA é truncado.
function _ajustarFonteSeloParaCaber(doc, rotulo, larguraMaxima) {
  let tamanho = CODIGO_FONTE;
  doc.font(TITULO_FONTE).fontSize(tamanho);
  let largura = doc.widthOfString(rotulo);
  while (largura + CAIXA_CODIGO_PAD_H * 2 + 1.5 > larguraMaxima && tamanho > CODIGO_FONTE_MIN) {
    tamanho -= 0.5;
    doc.fontSize(tamanho);
    largura = doc.widthOfString(rotulo);
  }
  return { tamanho, largura };
}

// Pedido do usuário (2026-07-29): "a caixa" da referência — o código do
// fabricante agora é uma CAIXA cheia (fundo azul, texto branco) sobreposta
// no canto superior esquerdo da foto, igual ao card de "Sensor de
// Estacionamento" mandado como modelo. Substitui o texto azul solto que
// existia antes (ver histórico no topo do arquivo). Largura da caixa segue
// o texto (com um mínimo/máximo), não é um tamanho fixo — evita caixa
// gigante pra código curto ou cortando código longo sem necessidade.
// Pedido do usuário (2026-08-27): "remova o fabricante e o código [do nome]
// já que estamos no catálogo do próprio [fabricante] e o código está acima"
// — só no Catálogo Completo (comAplicacao=true): o `produto.nome` cru do X2
// vem no formato "DESCRIÇÃO - FABRICANTE - CÓDIGO" (ex: "INTERRUPTOR
// PRESSÃO DIREÇÃO HIDRÁULICA - 3RHO - I 9901"), redundante aqui porque o
// fabricante já é o assunto do catálogo inteiro e o código já está no selo
// azul sobre a foto (_desenharCaixaCodigo). Remove só os segmentos finais
// (separados por " - ") que baterem com o fabricante ou com o código
// (rótulo do selo OU código interno) — pra ou dos dois estar ausente/em
// ordem diferente não quebra, e a descrição real nunca é tocada.
function _nomeExibicao(produto, comAplicacao) {
  const nomeCru = String(produto.nome || "");
  if (!comAplicacao) return nomeCru;

  // BUG REAL corrigido no mesmo commit: o nome cru vem com espaço dentro do
  // código ("... - I 321"), mas o rótulo do selo/código interno não tem
  // ("I321") — comparação exata nunca batia e nada era removido. Normaliza
  // os DOIS lados removendo espaço antes de comparar (só pra comparação;
  // o texto original de `partes` continua intacto se não for removido).
  const rotulo = _rotuloProduto(produto);
  const normalizar = (v) => String(v).trim().toUpperCase().replace(/\s+/g, "");
  const alvos = [produto.fabricante, rotulo, produto.codigo].filter(Boolean).map(normalizar);

  const partes = nomeCru.split(" - ");
  while (partes.length > 1 && alvos.includes(normalizar(partes[partes.length - 1]))) {
    partes.pop();
  }
  return partes.join(" - ");
}

function _desenharCaixaCodigo(doc, produto, xFoto, yFoto, larguraMaxima) {
  const rotulo = _rotuloProduto(produto);
  // Pedido do usuário (2026-08-27): "padronize a fonte do código também
  // para Futura Md BT" — era Helvetica-Bold, agora usa a mesma fonte dos
  // títulos de seção/índice (TITULO_FONTE, registrada em gerarPdfCatalogo/
  // gerarPdfCatalogoCompleto antes de qualquer card ser desenhado).
  doc.font(TITULO_FONTE).fontSize(CODIGO_FONTE);
  const larguraTexto = doc.widthOfString(rotulo);
  // BUG REAL corrigido em 2026-08-27 (achado reativando esta função depois
  // de ficar sem uso desde 2026-07-30): quando a caixa cabia EXATAMENTE do
  // tamanho do texto medido (sem sobra nenhuma), o próprio pdfkit.text()
  // reconstruía a largura da string de um jeito levemente diferente de
  // doc.widthOfString() e cortava com "…" mesmo sobrando espaço de sobra na
  // foto (ex: "I332" virava "I3…" numa caixa de 111pt de largura máxima
  // disponível). +1.5pt de folga aqui é imperceptível visualmente e evita
  // esse acerto de contas exato entre as duas medições.
  const larguraBadge = Math.min(larguraTexto + CAIXA_CODIGO_PAD_H * 2 + 1.5, larguraMaxima - 8);

  // Altura real da linha de texto nesse fontSize (pedido do usuário
  // 2026-07-30: "altura exata do código, se tiver espaço remova") — em vez
  // de um valor fixo, uso a métrica de verdade da fonte via
  // doc.currentLineHeight(), então a caixa nunca sobra espaço vazio em
  // cima/embaixo do texto, só o respiro mínimo de CAIXA_CODIGO_PAD_V.
  const alturaLinha = doc.currentLineHeight();
  const alturaBadge = alturaLinha + CAIXA_CODIGO_PAD_V * 2;

  // Pedido do usuário (2026-08-27, 2ª rodada — "arraste mais um pouco o
  // card do código para esquerda como nessa referência"): encostado ainda
  // mais perto do canto esquerdo da foto (era +2, foi pra 0 — o selo agora
  // começa exatamente na borda esquerda da área da foto, sem respiro).
  const xBadge = xFoto;
  const yBadge = yFoto + 4;

  doc.rect(xBadge, yBadge, larguraBadge, alturaBadge).fillColor(CAIXA_CODIGO_FUNDO).fill();
  // Pedido do usuário (2026-08-27): "centralize mais o código no card azul"
  // — align:"center" garante que o texto fique centralizado na largura do
  // selo mesmo com a folga de +1.5pt de larguraBadge acima (antes ficava
  // encostado à esquerda da caixa de texto, com toda a folga sobrando à
  // direita).
  doc.fillColor(CAIXA_CODIGO_TEXTO).font(TITULO_FONTE).fontSize(CODIGO_FONTE)
    .text(rotulo, xBadge + CAIXA_CODIGO_PAD_H, yBadge + CAIXA_CODIGO_PAD_V, {
      width: larguraBadge - CAIXA_CODIGO_PAD_H * 2,
      height: alturaLinha,
      ellipsis: true,
      lineBreak: false,
      align: "center",
    });

  doc.fillColor("#111827").font("Helvetica");
}

// Pedido do usuário (2026-07-30): "remova o fundo de vidro" — removido o
// efeito vidro (sombra em camadas translúcidas + brilho/glint no topo) que
// existia desde a v3 (2026-07-28). Card agora é só fundo branco chapado +
// borda ciano grossa, sem nenhuma camada extra. CINZA_SOMBRA ficou sem uso
// (mantida como constante só documentada, caso o efeito volte a ser pedido).
function _desenharCardVidro(doc, x, y, w, h) {
  // Fundo do card branco chapado.
  doc.roundedRect(x, y, w, h, RAIO_CARD).fillColor("#ffffff").fill();

  // Borda ciano grossa, cantos quadrados — pedido do usuário 2026-07-29,
  // medida na imagem de referência (ver BORDA_CARD/BORDA_CARD_ESPESSURA).
  doc.roundedRect(x, y, w, h, RAIO_CARD).lineWidth(BORDA_CARD_ESPESSURA).strokeColor(BORDA_CARD, 1).stroke();

  // 2026-08-27: "na borda de dentro da parte branca coloque um preto" — 2ª
  // borda fina preta, desenhada um pouco pra dentro da ciano (inset de
  // BORDA_CARD_INTERNA_GAP), enquadrando a área branca do card.
  const inset = BORDA_CARD_INTERNA_GAP;
  doc.roundedRect(x + inset, y + inset, w - inset * 2, h - inset * 2, RAIO_CARD)
    .lineWidth(BORDA_CARD_INTERNA_ESPESSURA).strokeColor(BORDA_CARD_INTERNA, 1).stroke();

  doc.fillOpacity(1).strokeOpacity(1);
}

// Placeholder de "coluna vazia" no Catálogo Completo (pedido do usuário,
// 2026-08-28: sub-grupo de marca com menos produtos que COLS_COMPLETO não
// deve nem esticar os cards reais nem deixar espaço em branco sem nada —
// as colunas que sobrarem na leva final recebem este card vazio).
// 1ª versão usava um traço tracejado cinza-claro pra não parecer produto
// de verdade; usuário pediu pra tirar o tracejado e usar "os cards vazios
// mesmo" — ou seja, a MESMA moldura do card real (_desenharCardVidro:
// fundo branco + borda ciano grossa + borda preta interna), só sem
// foto/selo/texto dentro.
//
// 2026-09-14: testei remover a moldura (deixar em branco liso) por pedido
// do usuário, mas ele voltou atrás na hora ("volte ao que era") — manter
// SEMPRE com a moldura do card real daqui pra frente, não mexer de novo
// sem confirmação bem explícita.
function _desenharCardVazio(doc, x, y, w, h) {
  _desenharCardVidro(doc, x, y, w, h);
}

// Extraído de gerarPdfCatalogo (2026-08-26, Issue #21) pra ser reusado
// também por gerarPdfCatalogoCompleto — mesma matemática de sempre (foto
// preenche 100% do espaço que sobra depois de descontar o bloco fixo de
// texto), só parametrizada por cols/rows em vez de usar COLS/ROWS_POR_PAGINA
// direto, pra caber tanto a grade 5×6 padrão quanto a 4×5 do modo completo
// sem duplicar a função.
//
// 2026-08-28 (sub-agrupamento por marca de veículo no Catálogo Completo):
// trocado doc.page.width/height por A4_LARGURA/A4_ALTURA — os dois batem
// exatamente igual, já que este doc é sempre criado com { size: "A4" }
// (ver gerarPdfCatalogo/gerarPdfCatalogoCompleto), mas doc.page só existe
// DEPOIS do 1º doc.addPage(). O pré-cálculo de paginação do Catálogo
// Completo agora precisa saber a altura de cada card (pra simular em que
// página cada cabeçalho de marca cai) ANTES de desenhar a página de
// índice, que é a 1ª coisa desenhada no documento — sem essa troca,
// _geometriaGrid não podia ser chamada cedo o bastante pra isso.
// 2026-08-31 (Catálogo Promocional — pedido do usuário: "reduza mais esse
// espaço e suba mais um pouco o rodapé"): `overrides` permite recalcular
// areaTopoY/areaFimY com a altura REAL do cabeçalho/rodapé de outro modo
// (aqui, o Promocional — ver PROMO_CABECALHO_*/PROMO_RODAPE_* e a chamada em
// gerarPdfCatalogoPromocional), em vez das constantes AREA_TOPO_Y/
// FOOTER_HEIGHT fixas abaixo, que foram calculadas pro cabeçalho/rodapé do
// Catálogo padrão (bem mais altos) e sobravam um vão enorme quando
// reusadas pro Promocional. Sem overrides, comportamento idêntico a antes —
// gerarPdfCatalogo/gerarPdfCatalogoCompleto não são afetados.
function _geometriaGrid(doc, cols, rows, comAplicacao = false, overrides = null) {
  const larguraUtil = A4_LARGURA - PAGE_MARGIN * 2;
  const cardWidth = (larguraUtil - (cols - 1) * GAP) / cols;
  const photoBoxWidth = cardWidth - PAD_CARD * 2;
  const areaTopoY = overrides?.areaTopoY ?? AREA_TOPO_Y;
  // PEDIDO DO USUÁRIO (2026-09-14): "preciso que padronize sempre meus
  // últimos cards terem 30,349 pt de distancia" — confirmado via
  // AskUserQuestion que é a distância entre a ÚLTIMA LINHA DE CARDS e o
  // rodapé. Antes era "8" (valor arbitrário/estético). Como o rodapé
  // começa em `h - FOOTER_HEIGHT` (ver _desenharRodape) e `h === A4_ALTURA`,
  // esse valor É exatamente essa distância em pontos — trocar aqui já
  // padroniza em todas as páginas, combinado com a linha final parcial de
  // preenchimento (ver preenchimentoFinal em _calcularLayoutConteudo, fix
  // de 2026-09-12) que garante que a última linha SEMPRE encosta em
  // areaFimY, nunca deixando sobra menor que uma linha antes do rodapé.
  const areaFimY = overrides?.areaFimY ?? (A4_ALTURA - FOOTER_HEIGHT - 30.349);
  const alturaDisponivel = areaFimY - areaTopoY;
  const cardHeightMax = (alturaDisponivel - (rows - 1) * GAP) / rows;

  let alturaFixaTexto;
  if (comAplicacao) {
    // 2026-08-27 (3ª rodada de redesenho): cabeçalho é só o selo do
    // fabricante + código original/OEM, EMPILHADOS (a descrição saiu
    // daqui, desceu pra linha de resumo abaixo da foto — ver
    // _desenharCardCatalogoCompleto e comentário no bloco de constantes
    // "RESUMO_*"). alturaCabecalho não precisa mais de Math.max com a
    // altura da descrição, já que não tem mais nada ao lado do selo.
    const alturaCabecalho = _alturaSelo(doc) + GAP_BADGE_OEM + OEM_ALTURA;
    alturaFixaTexto = PAD_CARD + alturaCabecalho + GAP_HEADER_FOTO
      + GAP_FOTO_RESUMO + RESUMO_ALTURA + GAP_RESUMO_APLICACAO + APLICACAO_ALTURA + PAD_CARD;
  } else {
    // Layout antigo (catálogo comum, sem aplicação/OEM) — selo sobreposto na
    // foto (_desenharCaixaCodigo, não ocupa altura fixa própria) + nome
    // abaixo da foto, sem mudança.
    alturaFixaTexto = PAD_CARD + GAP_FOTO_DIVISORIA + GAP_DIVISORIA_TEXTO + NOME_ALTURA + PAD_CARD;
  }
  const photoBoxHeight = cardHeightMax - alturaFixaTexto;
  const cardHeight = cardHeightMax;
  return { cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, areaTopoY, areaFimY };
}

// Pedido do usuário (2026-08-27, 3ª rodada de redesenho), esboço em texto:
//   codigo do fabricante
//   codigo original
//
//         *foto*
//
//   codigo da loja + Descrição resumida
//   aplicação até duas linhas
// Cabeçalho volta a ser só o selo + código original/OEM, EMPILHADOS (a
// descrição saiu daqui, ver bloco de baixo). Foto ocupa o meio do card.
// Embaixo da foto: descrição resumida numa linha só, depois a aplicação
// em até 2 linhas. O código OEM/equivalente mostrado é o 1º item de
// `produto.equivalentes` — já é a lista de referências cruzadas de outros
// fabricantes indexada por catalogo-x2.service.js (mesmo dado usado em
// "Ver referências" no painel de atendimento), sem precisar buscar nada
// novo.
//
// 2026-08-27 (ajuste seguinte, mesmo dia): "na descrição, remova o
// codigo, no lugar do codigo de fabricante troque pelo codigo da propria
// loja" — o selo do topo, que mostrava o código do FABRICANTE
// (_rotuloProduto, ex: "I321"), passou a mostrar o código da LOJA
// (produto.codigo, ex: "117437"); a linha de resumo embaixo da foto, que
// antes repetia esse código na frente da descrição, agora é só a
// descrição (o código não precisa mais aparecer duas vezes no card).
// 2026-08-28: pedido do usuário "existem várias fotos com tamanhos
// diferentes, existe uma possibilidade de ajustar para todas ficarem
// visualmente do mesmo tamanho?" — causa raiz medida pixel a pixel: fotos
// de produto de verdade já ocupam quase o arquivo inteiro (ex:
// 330×151px, conteúdo real ~326×150 — margem interna insignificante),
// mas um bom número de produtos só tem o ÍCONE GENÉRICO de "sem foto
// cadastrada" do X2 — arquivo minúsculo (82×72px) onde o desenho em si
// ocupa só ~26×13px, o resto é fundo branco que já é parte do arquivo.
// Como o desenho antigo usava doc.image({fit:...}) medindo o TAMANHO
// TOTAL do arquivo, essas fotos genéricas ficavam visualmente minúsculas
// dentro do quadro (a margem branca embutida no arquivo virava margem
// branca visível no card, além da margem normal do fit).
//
// Fix: decodifica o JPEG (jpeg-js, puro JS, sem dependência nativa — só
// usado pra MEDIR pixels, o desenho final continua sendo o buffer
// original via doc.image, sem perda de qualidade) e mede o bounding box
// real do conteúdo (varre os pixels, ignora os quase-brancos). O "fit"
// passa a ser calculado em cima desse CONTEÚDO em vez do arquivo inteiro
// — fotos reais e ícones genéricos passam a preencher o quadro do mesmo
// jeito visualmente. Só funciona pra JPEG (a esmagadora maioria dos
// arquivos do zip de fotos, ver catalogo-fotos.service) — qualquer falha
// de decode (formato não suportado, arquivo corrompido) cai de volta pro
// fit antigo (imagem inteira), sem quebrar a geração do PDF.
const LIMIAR_BRANCO_BBOX_FOTO = 245;

// BUG REAL corrigido 2026-09-02 (usuário reportou de novo "catálogo completo
// não gera" mesmo depois do fix de event-loop-yield do dia anterior): medido
// ao vivo que o gargalo de verdade não é o desenho do PDF (doc.image/doc.text
// somam <2% do tempo), é ESTA função — decodifica o JPEG inteiro em pixels
// (jpeg-js, puro JS, sem aceleração nativa) só pra medir a margem branca.
// Perfilado com --cpu-prof: pra fotos WEGA reais de 1440×1440px (maioria do
// fabricante), cada decode+varredura de pixel leva ~230ms — e ISSO SE REPETE
// DO ZERO em toda geração de PDF (preview automático ao trocar fabricante +
// clique em "Gerar catálogo completo" geram o MESMO PDF duas vezes seguidas,
// sem contar buscas/exportações repetidas de dias diferentes). Pra 682
// produtos da WEGA, só essa parte já passa de 2 minutos.
// Fix: cache do resultado (não do buffer decodificado inteiro — só o bbox,
// um objeto pequeno) por código de produto, em memória, persistente entre
// chamadas de geração de PDF (não por-request). Photo bytes não mudam
// durante a vida do processo (mesma garantia que catalogo-fotos.service já
// assume pro índice de fotos) — invalidado explicitamente por
// limparCacheBboxFotos(), chamado no mesmo endpoint de recarregar
// catálogo/fotos (ver recarregarCatalogoHandler em catalogo.controller.js).
const _bboxCache = new Map();

function limparCacheBboxFotos() {
  _bboxCache.clear();
  limparCacheAhash(); // mesma motivação: foto trocada, impressão digital velha não vale mais
}

function _bboxConteudoFoto(buffer, mimetype, cacheKey = null) {
  if (mimetype !== "image/jpeg") return null;
  if (cacheKey !== null && _bboxCache.has(cacheKey)) return _bboxCache.get(cacheKey);

  let resultado;
  let decodificada;
  try {
    decodificada = jpeg.decode(buffer, { useTArray: true });
  } catch {
    decodificada = null;
  }
  if (!decodificada) {
    resultado = null;
  } else {
    const { width, height, data } = decodificada;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y++) {
      const linhaBase = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = linhaBase + x * 4;
        if (data[i] > LIMIAR_BRANCO_BBOX_FOTO && data[i + 1] > LIMIAR_BRANCO_BBOX_FOTO && data[i + 2] > LIMIAR_BRANCO_BBOX_FOTO) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) {
      resultado = null; // imagem inteiramente branca
    } else {
      const conteudoLargura = maxX - minX + 1;
      const conteudoAltura = maxY - minY + 1;
      // Se o conteúdo já cobre quase o arquivo inteiro (foto normal, sem
      // margem embutida relevante), não vale mexer — evita ampliar por causa
      // de 1-2px de ruído de compressão JPEG na borda.
      if (conteudoLargura >= width * 0.97 && conteudoAltura >= height * 0.97) {
        resultado = null;
      } else {
        resultado = { x: minX, y: minY, width: conteudoLargura, height: conteudoAltura, imgWidth: width, imgHeight: height };
      }
    }
  }

  if (cacheKey !== null) _bboxCache.set(cacheKey, resultado);
  return resultado;
}

// Desenha a foto ajustada ao quadro (x,y,boxWidth,boxHeight) usando o
// bounding box do conteúdo real (ver _bboxConteudoFoto) em vez do tamanho
// total do arquivo — mesmo efeito de "object-fit: contain" do CSS, mas
// medido no conteúdo, não na tela toda. Sem bbox (não-JPEG, decode
// falhou, ou já preenche o arquivo quase inteiro), cai no fit antigo
// (imagem inteira). Precisa de clip porque a imagem inteira (com a
// margem branca embutida) fica MAIOR que o quadro depois do zoom no
// conteúdo — sem isso vazaria por cima dos cards vizinhos.
// BUG REAL corrigido 2026-09-04 (usuário reportou "catálogo completo 12M
// com cards em branco", investigado com bisecção binária desenhando cada
// pedaço do card isoladamente até isolar o ponto exato da quebra — ver
// PR/Issue): fotos com EXIF malformado (comum em parte do acervo real de
// fotos da loja) fazem `doc.image()` do pdfkit lançar
// `RangeError [ERR_OUT_OF_RANGE]` de dentro do parser de EXIF que ele usa
// internamente (jpeg-exif) — não é um erro nosso, é uma foto real com
// metadado quebrado. O código JÁ tinha um try/catch no chamador
// (_desenharCardCatalogoCompleto) pra cair em "sem foto" quando isso
// acontece, então a EXCEÇÃO em si sempre foi tratada — o bug real é que
// essa exceção acontecia DEPOIS de doc.save()+clip() e ANTES de
// doc.restore() (ambos abaixo), então o `restore()` nunca rodava: o clip
// (um retângulo pequeno, só a caixa da foto) ficava PRESO ativo pro resto
// da página inteira — todo card/cabeçalho de marca/preenchimento desenhado
// DEPOIS daquele produto específico caía fora da área do clip e sumia
// (página em branco, mesmo com dado computado certinho — confirmado
// comparando o layout pré-calculado com o desenho real). Fix: try/finally
// garante que doc.restore() sempre roda, throw ou não — o catch de fora
// continua cuidando do fallback "sem foto" pra ESSE produto, mas o
// vazamento de clip que quebrava TODOS os produtos seguintes na página
// para de acontecer.
//
// PEDIDO DO USUÁRIO (2026-09-22, "preciso que ajuste imagens" ->
// "tamanho/proporção da foto na caixa"): o "contain" puro (Math.min)
// nunca corta nada, mas peças compridas e finas (amortecedor fotografado
// na diagonal ou deitado, por exemplo) têm bbox muito mais larga que
// alta (ou o contrário) — encaixar isso inteiro numa caixa quase
// quadrada sobra MUITO espaço em branco no eixo curto. Usuário não teve
// preferência entre "corta um pouco" vs. "aumenta só a caixa" — optei
// por um meio-termo controlado: zoom até FOTO_LIMITE_ZOOM_CROP vezes
// maior que o "contain" (nunca mais que o "cover" full, que preencheria
// a caixa inteira mas podia cortar bem mais que isso pras peças mais
// extremas), sempre centralizado — fotos quase quadradas (a maioria)
// não mudam quase nada, só as bem alongadas ganham zoom real, com corte
// pequeno e previsível nas pontas (nunca mais que o necessário pra caber
// no fator de zoom escolhido).
//
// REVERTIDO (pedido do usuário, 2026-09-23: "preciso que não corte
// absolutamente nenhuma imagem"): o meio-termo acima (1.3x) cortava um
// pouco as peças bem alongadas, exatamente o cenário que motivou o pedido
// original — o usuário decidiu agora que nenhum corte é aceitável, nem
// esse "pequeno e previsível". FOTO_LIMITE_ZOOM_CROP = 1 faz
// `escala = Math.min(escalaCover, escalaContain * 1)` sempre resolver
// pra `escalaContain` (contain nunca é maior que cover) — volta a ser
// "contain" puro sobre o bbox do conteúdo real: a foto inteira sempre
// cabe na caixa, sem cortar nenhum pixel do produto fotografado. O clip
// continua ativo só por segurança (evita vazar por cima de cards
// vizinhos em casos extremos de arredondamento), mas na prática não deve
// cortar mais nada — nesse fator ele só corta a margem branca da própria
// imagem original, quando ela ultrapassa ligeiramente a caixa depois do
// contain, nunca o produto em si. Mesma constante usada em TODOS os
// tipos de catálogo em PDF (Completo, Promocional, Diversos) porque
// todos passam por _desenharFotoAjustada via _desenharCard.
const FOTO_LIMITE_ZOOM_CROP = 1;
// `imagemAberta` (2026-10-14): imagem já parseada por doc.openImage() — ver
// _fotosUtilizaveis abaixo. pdfkit aceita no 1º argumento de doc.image()
// tanto o buffer cru quanto um objeto de imagem já aberto (ele só checa
// `src.width && src.height` antes de chamar openImage por conta própria),
// então passar o objeto aqui evita re-parsear o mesmo arquivo e, mais
// importante, garante que o parse (onde o EXIF malformado estoura) já
// aconteceu ANTES de qualquer decisão de layout. O bbox continua sendo
// medido no buffer cru, que é o que o jpeg-js decodifica.
function _desenharFotoAjustada(doc, buffer, mimetype, x, y, boxWidth, boxHeight, cacheKey = null, imagemAberta = null) {
  const origem = imagemAberta || buffer;
  const bbox = _bboxConteudoFoto(buffer, mimetype, cacheKey);
  if (!bbox) {
    doc.image(origem, x, y, { fit: [boxWidth, boxHeight], align: "center", valign: "center" });
    return;
  }
  const escalaContain = Math.min(boxWidth / bbox.width, boxHeight / bbox.height);
  const escalaCover = Math.max(boxWidth / bbox.width, boxHeight / bbox.height);
  const escala = Math.min(escalaCover, escalaContain * FOTO_LIMITE_ZOOM_CROP);
  const larguraDesenho = bbox.imgWidth * escala;
  const alturaDesenho = bbox.imgHeight * escala;
  const xDesenho = x + (boxWidth - bbox.width * escala) / 2 - bbox.x * escala;
  const yDesenho = y + (boxHeight - bbox.height * escala) / 2 - bbox.y * escala;
  doc.save();
  try {
    doc.rect(x, y, boxWidth, boxHeight).clip();
    doc.image(origem, xDesenho, yDesenho, { width: larguraDesenho, height: alturaDesenho });
  } finally {
    doc.restore();
  }
}

// BUG REAL reportado pelo usuário (2026-10-14): "alguns catálogos quando
// gerados, apesar de não ter duas fotos no sistema, ele é arrastado para o
// canto esquerdo e com a marca 'sem foto', como SPEED BRAKE por exemplo".
//
// Causa raiz: os dois desenhos de card (_desenharCardCatalogoCompleto e
// _desenharCard) escolhiam o layout — 1 foto grande vs. 2 lado a lado —
// olhando só o MIMETYPE das fotos, e o mimetype vem da EXTENSÃO do arquivo
// indexado (ver obterFoto em catalogo-fotos.service.js). Ou seja, a
// pergunta respondida era "existe um 2º arquivo .jpg indexado?", não "esse
// arquivo abre?". Quando o 2º arquivo era uma foto que o pdfkit não
// consegue parsear (EXIF malformado -> RangeError de dentro do jpeg-exif,
// comum em parte do acervo real da loja — ver comentário grande acima), a
// sequência era:
//   1) layout decidido como "2 fotos"  -> foto 1 desenhada em MEIA largura;
//   2) foto 2 estoura no doc.image();
//   3) o catch, que era único pro bloco inteiro, escrevia "sem foto" na
//      largura CHEIA — por cima da foto 1, que já estava desenhada.
// Daí o sintoma: a foto encolhida e encostada à esquerda, com o aviso "sem
// foto" em cima dela, num produto que TEM foto. (O try/finally de
// 2026-09-04 consertou o vazamento de clip, que apagava os cards seguintes
// da página, mas não este sintoma — são dois efeitos da mesma exceção.)
//
// Fix: parsear ANTES de decidir o layout. doc.openImage() faz só o parse,
// sem desenhar nada, e é exatamente onde a exceção acontece — então o
// layout passa a ser escolhido a partir das fotos que REALMENTE abrem.
// Efeitos colaterais desejados: "sem foto" só aparece quando NENHUMA foto
// abre; e produto cuja 1ª foto está corrompida mas a 2ª está boa agora
// mostra a 2ª em largura cheia, em vez de "sem foto".
// 2026-10-19 (usuário: "porque tantos produtos estão duplicando a mesma
// foto aparecendo duas vezes no mesmo card"): medido numa amostra de 309
// produtos — 179 têm 2+ fotos e em 97 delas (54%) as duas são A MESMA IMAGEM:
// 48 byte-a-byte idênticas e 49 em que a 2ª é a MINIATURA da 1ª (o X2 manda
// a foto cheia e uma cópia pequena, ex.: 430×430 e 150×150, 1440×1440 e
// 150×150, 550×625 e 132×150). _fotosUtilizaveis pegava só os índices 0 e 1,
// então todo produto assim saía com a mesma peça duas vezes no card (e a
// 2ª, pequena, ainda estragava o encaixe).
// Critério de "mesma foto" (conferido visualmente em 10 pares reais): bytes
// iguais; OU mesma proporção (±4%), uma com no mínimo 1,4× o tamanho da
// outra (é a miniatura) e impressão digital 8×8 parecida (<= 8 bits de 64).
// Só o tamanho NÃO basta e só a impressão digital TAMBÉM não: duas vistas
// diferentes da mesma peça (traseira/frente do alternador) ficam <= 3 bits
// uma da outra, mas têm o mesmo tamanho — o critério de miniatura as separa.
// Quando duas fotos são a mesma, fica a MAIOR (melhor resolução no PDF).
// Olha até 4 fotos por produto pra ainda achar uma 2ª foto diferente quando
// a 2ª é cópia da 1ª.
const FOTOS_CANDIDATAS_MAX = 4;

// O critério de "mesma foto" mora em catalogo-foto-duplicada.js desde
// 2026-10-23: o Consultar do programa da loja precisava exatamente da mesma
// resposta (lá o card mostrava a peça repetida), e duas cópias da regra em
// arquivos diferentes iam divergir no primeiro ajuste. Aqui fica só a
// adaptação do formato usado neste arquivo (imagem já aberta pelo pdfkit).
function _ehMesmaFoto(a, b) {
  return ehMesmaFoto(
    { buffer: a.buffer, mimetype: a.mimetype, largura: a.imagem.width, altura: a.imagem.height, chave: a.cacheKey },
    { buffer: b.buffer, mimetype: b.mimetype, largura: b.imagem.width, altura: b.imagem.height, chave: b.cacheKey },
  );
}

// 2026-10-29 (bug reportado pelo usuário: catálogo 12M com produtos "sem
// foto" mesmo com foto válida indexada): alguns JPEGs trazem um segmento
// APP1/EXIF (metadado de câmera/celular) que o parser de imagem do pdfkit
// não sabe ler — doc.openImage() lança "The value of 'offset' is out of
// range" mesmo o arquivo sendo um JPEG íntegro (medido: 10/10 exemplos do
// 12M eram JPEGs válidos de 260-470KB, só com esse bloco). Como
// temAlgumaFoto() (catalogo-fotos.service.js) só confere se a foto está
// indexada — não se ela abre de verdade —, o produto passa no filtro do
// Catálogo Completo e entra na lista, mas aqui a foto falhava e o produto
// virava "sem foto" no PDF. O EXIF não faz falta nenhuma pro catálogo (só
// desenhamos a imagem), então a correção remove esse segmento específico
// do JPEG e tenta abrir de novo antes de desistir da foto.
function _removerExifJpeg(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const partes = [buffer.subarray(0, 2)];
  let pos = 2;
  let removeu = false;
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) break; // marcador inesperado — desiste, formato fora do padrão
    const marcador = buffer[pos + 1];
    if (marcador === 0xd8 || marcador === 0xd9) break; // SOI/EOI não deveriam aparecer aqui
    if (marcador === 0xda) {
      // Start of Scan: o resto do arquivo é dado de imagem (sem mais
      // marcadores de segmento confiáveis) — copia tudo e para.
      partes.push(buffer.subarray(pos));
      pos = buffer.length;
      break;
    }
    if (pos + 4 > buffer.length) break;
    const tamanhoSegmento = buffer.readUInt16BE(pos + 2);
    const fimSegmento = pos + 2 + tamanhoSegmento;
    if (tamanhoSegmento < 2 || fimSegmento > buffer.length) break;
    if (marcador === 0xe1) {
      removeu = true; // APP1 (EXIF) — descarta este segmento
    } else {
      partes.push(buffer.subarray(pos, fimSegmento));
    }
    pos = fimSegmento;
  }
  if (!removeu || pos < buffer.length - 1) {
    // Não achou EXIF pra remover, ou o laço parou cedo (formato que não
    // soubemos percorrer até o fim) — mais seguro desistir do que devolver
    // um JPEG cortado no meio.
    if (!removeu) return null;
    if (pos < buffer.length) partes.push(buffer.subarray(pos));
  }
  return Buffer.concat(partes);
}

// Parse de cada foto é síncrono e pode ser caro. O catálogo completo faz uma
// pré-seleção das peças antes do índice/paginação; guardar o resultado por
// documento evita abrir as mesmas imagens de novo ao desenhar os cards.
const _fotosUtilizaveisPorDocumento = new WeakMap();

function _fotosUtilizaveis(doc, codigoProduto) {
  let cache = _fotosUtilizaveisPorDocumento.get(doc);
  if (!cache) {
    cache = new Map();
    _fotosUtilizaveisPorDocumento.set(doc, cache);
  }
  const chaveProduto = String(codigoProduto);
  if (cache.has(chaveProduto)) return cache.get(chaveProduto);

  const utilizaveis = [];
  for (const indice of Array.from({ length: FOTOS_CANDIDATAS_MAX }, (_, i) => i)) {
    let foto;
    try {
      foto = obterFoto(codigoProduto, indice);
    } catch {
      continue; // falha ao extrair do zip — mesmo efeito de foto ausente
    }
    if (!foto) continue;
    if (foto.mimetype !== "image/jpeg" && foto.mimetype !== "image/png") continue;
    let imagem;
    try {
      imagem = doc.openImage(foto.buffer);
    } catch {
      // Ver _removerExifJpeg acima — antes de desistir da foto, tenta sem
      // o bloco EXIF (só faz diferença pra JPEG; PNG nunca cai aqui pelo
      // filtro de mimetype acima).
      try {
        const semExif = foto.mimetype === "image/jpeg" ? _removerExifJpeg(foto.buffer) : null;
        imagem = semExif ? doc.openImage(semExif) : null;
        if (imagem) foto = { ...foto, buffer: semExif };
      } catch {
        imagem = null;
      }
      if (!imagem) continue; // mesmo sem EXIF não abre — desiste dessa foto
    }
    if (!imagem || !imagem.width || !imagem.height) continue;
    utilizaveis.push({
      buffer: foto.buffer,
      mimetype: foto.mimetype,
      imagem,
      // Chave de cache do bbox por FOTO (não por produto): o bbox depende
      // só do arquivo, então indexar por "codigo#indice" vale pros dois
      // layouts. Antes, a foto única era cacheada sob a chave "codigo" e a
      // mesma foto no layout de 2 sob "codigo#0" — duas entradas pro mesmo
      // arquivo.
      cacheKey: `${codigoProduto}#${indice}`,
    });
  }
  // Tira as repetidas (mesma foto / miniatura da mesma foto) — ver comentário
  // acima. Mantém a ordem original e, entre duas iguais, fica a maior.
  const escolhidas = [];
  for (const candidata of utilizaveis) {
    const k = escolhidas.findIndex(e => _ehMesmaFoto(e, candidata));
    if (k < 0) {
      escolhidas.push(candidata);
    } else if (candidata.imagem.width * candidata.imagem.height > escolhidas[k].imagem.width * escolhidas[k].imagem.height) {
      escolhidas[k] = candidata;
    }
  }
  const resultado = escolhidas.slice(0, 2);
  cache.set(chaveProduto, resultado);
  return resultado;
}

// Rede de segurança por FOTO: o parse já passou em _fotosUtilizaveis, mas se
// o desenho ainda falhar (bug de pdfkit, buffer truncado), perde-se só
// aquela foto — não o card inteiro, e não se escreve "sem foto" por cima de
// uma foto que já foi desenhada. Devolve se desenhou ou não.
function _desenharFotoProtegida(doc, foto, x, y, boxWidth, boxHeight) {
  try {
    _desenharFotoAjustada(doc, foto.buffer, foto.mimetype, x, y, boxWidth, boxHeight, foto.cacheKey, foto.imagem);
    return true;
  } catch {
    return false;
  }
}

// 2026-08-28: pedido do usuário "na aplicação sempre que couber inteiro
// padronize ponto final no final do texto e as marcas deixe em negrito,
// padronize Mercedes Benz como MB" — e, no mesmo dia, follow-up "volkswagen
// é a mesma coisa que Vw, padronize os em negrito. ainda vejo muitos
// fabricantes sem negrito": a 1ª versão só aplicava negrito quando o texto
// INTEIRO cabia na área (mesma trava do ponto final), por isso a maioria
// dos cards — que têm lista de modelos longa e precisam de corte — ficava
// sem negrito nenhum. Reescrito pra desacoplar as duas regras:
// (1) "MERCEDES-BENZ"/"MERCEDES BENZ"/typo "MERCEDES BENS" -> "MB", e
// "VOLKSWAGEN" (qualquer grafia/caixa) -> "VW" — padronização de
// conteúdo, roda incondicionalmente, não depende de caber ou não.
// (2) ponto final SÓ quando o texto inteiro cabe (mesma lógica da linha
// de resumo) — texto cortado não ganha ponto, o "..." já sinaliza corte.
// (3) negrito nas MARCAS (ex. "FORD", "MB", "VW") — SEMPRE que o formato
// bater "MARCA: modelos; OUTRA: modelos" (ver PROMPT_APLICACAO_SISTEMA em
// ai.service.js), esteja o texto inteiro ou truncado. Como o modo
// "continued" do pdfkit (negrito seletivo) não tem corte automático por
// altura como o `ellipsis`, o truncamento agora é feito manualmente em
// _truncarParaAltura() antes de desenhar, e o desenho fica dentro de um
// clip (doc.rect().clip()) como cinto de segurança — a medição usa a
// fonte regular pro texto inteiro, mas a marca desenha em negrito (um
// pouco mais larga); a diferença é mínima já que a marca é a menor parte
// do texto, mas o clip garante que nenhum estouro vaze pro card vizinho.
// Só cai no desenho antigo (corrido, sem negrito, ellipsis nativo) se o
// texto não bater no formato "MARCA: ..." em nenhum trecho — dado
// legado/malformado, não deveria acontecer com o prompt atual.
function _truncarParaAltura(doc, texto, largura, altura) {
  let lo = 0;
  let hi = texto.length;
  while (lo < hi) {
    const meio = Math.ceil((lo + hi) / 2);
    const candidato = `${texto.slice(0, meio).trimEnd()}...`;
    if (doc.heightOfString(candidato, { width: largura }) <= altura + 0.5) {
      lo = meio;
    } else {
      hi = meio - 1;
    }
  }
  return lo > 0 ? `${texto.slice(0, lo).trimEnd()}...` : "...";
}

// Extraída pra função própria (2026-08-28, pedido do usuário sobre
// agrupar por marca de veículo — ver _agruparPorMarca mais abaixo): a
// mesma padronização "MERCEDES-BENZ"/variantes -> "MB" agora é usada em
// DOIS lugares — aqui, pra desenhar o texto, e em _extrairMarcas, pra
// decidir em qual sub-grupo de marca cada produto entra. Compartilhar a
// mesma função garante que o texto exibido no card e o cabeçalho de marca
// sob o qual ele é agrupado NUNCA divirjam (ex. produto com
// "Mercedes-Benz" no texto cru sempre cai no grupo "MB", e o texto
// desenhado no card também sempre mostra "MB").
function _normalizarMarcasTexto(texto) {
  return String(texto || "")
    .replace(/mercedes[-\s]*ben[zs]/gi, "MB")
    // 2026-09-11 (pedido do usuário: "vw e vw caminhões, fiat e fiat allis
    // ... devem ser um apenas 'VOLKSWAGEN'"): unifica TODAS as variantes
    // de Volkswagen — sigla "VW" (com ou sem sufixo "Caminhões"/"Caminhoes"
    // grudado) e o nome por extenso — num único nome canônico por extenso
    // "VOLKSWAGEN", em vez de abreviar pra "VW" como antes (era o
    // contrário: "Volkswagen" -> "VW"). "VW Caminhões" e "VW" (carro de
    // passeio) eram grupos SEPARADOS no Catálogo Completo antes disso —
    // agora colapsam no mesmo grupo "VOLKSWAGEN", incluindo o sufixo
    // "Caminhões"/"Caminhoes" (com ou sem hífen/espaço) que precisa ser
    // removido ANTES da regra solta de "VW"/"Volkswagen" abaixo, senão
    // sobraria como "VOLKSWAGEN CAMINHÕES" (grupo ainda separado).
    .replace(/\b(vw|volkswagen)\s*-?\s*caminh(?:o|õ)es\b/gi, "VOLKSWAGEN")
    .replace(/\bvolkswagen\b/gi, "VOLKSWAGEN")
    .replace(/\bvw\b/gi, "VOLKSWAGEN")
    // Mesmo pedido, mesma lógica — "FIAT ALLIS" (fabricante histórico de
    // máquinas pesadas, joint-venture Fiat + Allis-Chalmers) unificado no
    // grupo "FIAT".
    .replace(/\bfiat\s*-?\s*allis\b/gi, "FIAT")
    // 2026-09-11 (bug real reportado pelo usuário: catálogo completo 3RHO
    // mostrando "CX220C TIER 3 (08/14 - 12/16)" como se fosse marca própria,
    // isolada, com o resto da linha vazio) — o texto de aplicação gerado
    // pela IA separa blocos de MONTADORA diferentes com uma linha em branco
    // (ex. "CASE: ...; CX220C TIER 3 (08/14 - 12/16)\n\nNEW HOLLAND: ..."),
    // mas o split abaixo (aqui e em _extrairMarcas) só reconhece ";" como
    // separador de segmento. Sem isso, o ÚLTIMO modelo antes da quebra de
    // linha ficava GRUDADO no início do bloco da montadora seguinte num
    // único segmento só ("CX220C TIER 3 (08/14 - 12/16)\n\nNEW HOLLAND"), e
    // como esse segmento tem ":", o regex de marca (/^([^:]+):/) capturava
    // tudo antes dele — inclusive o modelo/ano da montadora anterior — como
    // se fosse o nome da marca, criando um grupo falso com 1 produto só
    // (daí os cards vazios preenchendo o resto da leva). Convertendo toda
    // quebra de linha em "; " ANTES do split, cada bloco de montadora vira
    // segmento próprio de novo, exatamente como seria se estivesse tudo
    // numa linha só separado por ";".
    .replace(/\s*\n+\s*/g, "; ");
}

// `marcaPrioritaria` (2026-08-28, sub-agrupamento por marca de veículo —
// 2ª versão, pedido do usuário "se uma peça pode ser aplicada em Fiat e
// Ford [...] Subcategoria Fiat só colocaremos o que tem específico pra
// ela na peça e não todos os outros assim como ford"): quando o card é
// desenhado DENTRO de um sub-grupo de marca (ver
// _desenharCabecalhoMarca/gerarPdfCatalogoCompleto), um produto que
// atende várias marcas (ex. "FIAT: ...; FORD: ...") é desenhado uma vez
// por marca — sob "FIAT" mostra SÓ o trecho da FIAT, sob "FORD" mostra SÓ
// o trecho da FORD, os outros segmentos são descartados nessa cópia (não
// só reordenados pra trás — removidos mesmo, já que cada seção deve
// listar apenas a aplicação específica dela). Se por algum motivo nenhum
// segmento bater com a marca-alvo (não deveria acontecer, já que
// _agruparPorMarca só duplica o produto pras marcas que ele realmente
// cita), mantém o texto original inteiro como rede de segurança em vez de
// desenhar um card vazio.
function _desenharAplicacao(doc, textoOriginal, x, y, largura, altura, marcaPrioritaria) {
  let texto = _normalizarMarcasTexto(textoOriginal);
  if (marcaPrioritaria && marcaPrioritaria !== MARCA_OUTRAS) {
    const alvo = marcaPrioritaria.toUpperCase();
    const partes = texto.split(/;\s*/).filter(Boolean);
    const apenasAlvo = partes.filter((p) => {
      const marca = p.match(/^([^:]+):/)?.[1]?.trim().toUpperCase() ?? "";
      return marca === alvo;
    });
    if (apenasAlvo.length > 0) {
      texto = apenasAlvo.join("; ");
    }
  }

  doc.font(QUICKSAND_MEDIUM).fontSize(APLICACAO_FONTE);
  const coubeInteira = doc.heightOfString(texto, { width: largura }) <= altura + 0.5;
  const textoFinal = coubeInteira
    ? (/[.!?…]$/.test(texto) ? texto : `${texto}.`)
    : _truncarParaAltura(doc, texto, largura, altura);

  const partes = textoFinal.split(/;\s*/).filter(Boolean);
  const temFormatoMarca = partes.some((p) => /^[^:]+:\s*.+$/s.test(p));

  if (!temFormatoMarca) {
    doc.fillColor(APLICACAO_COR).font(QUICKSAND_MEDIUM).fontSize(APLICACAO_FONTE)
      .text(texto, x, y, { width: largura, height: altura, ellipsis: true, lineGap: 0.5 });
    return;
  }

  doc.save();
  doc.rect(x, y, largura, altura).clip();
  doc.x = x;
  doc.y = y;
  doc.fillColor(APLICACAO_COR);
  partes.forEach((parte, i) => {
    const ultima = i === partes.length - 1;
    const match = parte.match(/^([^:]+):\s*(.*)$/s);
    if (match) {
      const [, marca, resto] = match;
      doc.font(QUICKSAND_BOLD).fontSize(APLICACAO_FONTE)
        .text(marca, { continued: true, width: largura, lineGap: 0.5 });
      doc.font(QUICKSAND_MEDIUM).fontSize(APLICACAO_FONTE)
        .text(`: ${resto}${ultima ? "" : "; "}`, { continued: !ultima, width: largura, lineGap: 0.5 });
    } else {
      // fragmento sem "MARCA:" completo — sobra de um corte bem no meio do
      // nome da marca (raro); desenha como está, sem negrito, em vez de
      // adivinhar onde a marca terminaria.
      doc.font(QUICKSAND_MEDIUM).fontSize(APLICACAO_FONTE)
        .text(`${parte}${ultima ? "" : "; "}`, { continued: !ultima, width: largura, lineGap: 0.5 });
    }
  });
  doc.restore();
}

function _desenharCardCatalogoCompleto(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, marcaAtual = null, preco = null, estilo = "eletrica") {
  const larguraConteudo = photoBoxWidth; // = cardWidth - PAD_CARD*2, já calculado em _geometriaGrid
  const xConteudo = x + PAD_CARD;
  const yTopo = y + PAD_CARD;

  // --- Selo do código do fabricante (topo, sozinho — sem mais nada ao lado) ---
  // 2026-08-27 (revertido de novo, mesmo dia): tinha trocado pra
  // produto.codigo (código da loja) por pedido do usuário, depois ele
  // pediu pra voltar: "embaixo fica o codigo da loja e encima o codigo de
  // fabricante" — selo no topo volta a ser o código do FABRICANTE
  // (_rotuloProduto), código da loja volta pra linha de resumo embaixo da
  // foto (ver mais abaixo). A regra de nunca truncar
  // (_ajustarFonteSeloParaCaber logo abaixo) é uma propriedade do SELO em
  // si, não do código específico que está nele — vale do mesmo jeito.
  const rotulo = _rotuloProduto(produto);

  // larguraSelo também declarada no escopo de fora (não só dentro do else)
  // porque _desenharBadgePreco logo abaixo precisa dela pra posicionar o
  // preço ENCOSTADO no selo, não importa qual estilo desenhou o selo.
  let alturaSelo;
  let larguraSelo;
  if (estilo === "mecanica") {
    // Estilo mecânica (fabricante PERFECT, pedido do usuário 2026-09-03):
    // selo vira uma BARRA que ocupa a largura INTEIRA do card (medido no
    // mockup — não é mais um selo ajustado ao texto, ver estilo elétrica
    // logo abaixo), fundo amarelo/texto navy (MECANICA_BADGE_FUNDO/TEXTO).
    // Mesma regra de nunca truncar o código (_ajustarFonteSeloParaCaber),
    // só que aqui a largura disponível já É a largura do card inteiro, não
    // precisa calcular a largura do texto pra dimensionar a caixa.
    const { tamanho: tamanhoSeloMec } = _ajustarFonteSeloParaCaber(doc, rotulo, larguraConteudo * 0.9);
    doc.font(TITULO_FONTE).fontSize(tamanhoSeloMec);
    const alturaLinhaSeloMec = doc.currentLineHeight();
    alturaSelo = alturaLinhaSeloMec + CAIXA_CODIGO_PAD_V * 2;
    larguraSelo = larguraConteudo; // barra ocupa o card inteiro, ver comentário acima

    doc.rect(xConteudo, yTopo, larguraConteudo, alturaSelo).fillColor(MECANICA_BADGE_FUNDO).fill();
    doc.fillColor(MECANICA_BADGE_TEXTO).font(TITULO_FONTE).fontSize(tamanhoSeloMec)
      .text(rotulo, xConteudo, yTopo + CAIXA_CODIGO_PAD_V, {
        width: larguraConteudo,
        height: alturaLinhaSeloMec,
        lineBreak: false,
        align: "center",
      });
  } else {
    // Estilo elétrica (padrão — todo fabricante que não seja PERFECT, ver
    // _estiloCatalogoCompleto): selo pequeno, largura ajustada ao texto do
    // código, canto superior esquerdo do card. Comportamento de sempre,
    // sem mudança nenhuma.
    // 2026-08-27: "por mais que ele seja grande nunca deixe '...' sempre
    // coloque completo nem que precise reduzir tamanho" — em vez de cortar
    // com ellipsis quando o texto não cabe em larguraMaximaSelo, encolhe o
    // fontSize até caber (_ajustarFonteSeloParaCaber); a caixa então se
    // ajusta exatamente ao texto (já garantido caber), nunca corta. Sem mais
    // descrição disputando espaço na mesma linha, o teto pode ser bem mais
    // generoso (85% em vez de 50%) — só entra em jogo em código raro/enorme.
    const larguraMaximaSelo = larguraConteudo * 0.85;
    const { tamanho: tamanhoSelo, largura: larguraTextoSelo } = _ajustarFonteSeloParaCaber(doc, rotulo, larguraMaximaSelo);
    larguraSelo = larguraTextoSelo + CAIXA_CODIGO_PAD_H * 2 + 1.5;
    doc.font(TITULO_FONTE).fontSize(tamanhoSelo);
    const alturaLinhaSelo = doc.currentLineHeight();
    alturaSelo = alturaLinhaSelo + CAIXA_CODIGO_PAD_V * 2;

    doc.rect(xConteudo, yTopo, larguraSelo, alturaSelo).fillColor(CAIXA_CODIGO_FUNDO).fill();
    doc.fillColor(CAIXA_CODIGO_TEXTO).font(TITULO_FONTE).fontSize(tamanhoSelo)
      .text(rotulo, xConteudo + CAIXA_CODIGO_PAD_H, yTopo + CAIXA_CODIGO_PAD_V, {
        width: larguraSelo - CAIXA_CODIGO_PAD_H * 2,
        height: alturaLinhaSelo,
        lineBreak: false,
        align: "center",
      });
  }

  // --- Preço promocional (canto superior direito, ver _desenharBadgePreco)
  // — só desenha se `preco` foi passado (Catálogo Promocional); nos outros
  // modos (Catálogo Completo comum) preco fica null e a função não desenha
  // nada, canto continua vazio como sempre foi.
  if (preco != null) {
    _desenharBadgePreco(doc, preco, xConteudo, yTopo, larguraConteudo, larguraSelo);
  } else if (estilo !== "mecanica") {
    // 2026-10-19: canto livre (sem preço) -> selo "12V | 90A", ver
    // _extrairEspecEletrica.
    _desenharSeloEletrico(doc, _extrairEspecEletrica(produto), xConteudo, yTopo, larguraConteudo, larguraSelo, alturaSelo);
  }

  // --- Código original/OEM em vermelho, embaixo do selo ---
  const oem = Array.isArray(produto.equivalentes) && produto.equivalentes.length ? produto.equivalentes[0] : null;
  if (oem) {
    doc.fillColor(OEM_COR).font("Helvetica-Bold").fontSize(OEM_FONTE)
      .text(_limparCodigoOemParaExibicao(oem), xConteudo, yTopo + alturaSelo + GAP_BADGE_OEM, {
        width: larguraConteudo,
        height: OEM_ALTURA,
        ellipsis: true,
        lineBreak: false,
      });
  }

  // --- Foto (abaixo do cabeçalho selo+OEM) ---
  const alturaCabecalho = alturaSelo + GAP_BADGE_OEM + OEM_ALTURA;
  const yFoto = yTopo + alturaCabecalho + GAP_HEADER_FOTO;

  // Pedido do usuário (2026-09-05): "padronizar duas fotos por card" — mas
  // só 33% dos produtos do Catálogo Completo têm 2+ fotos cadastradas
  // (64% têm só 1). Decisão do usuário depois de ver esse número: NÃO
  // encolher a foto única dos 64% pra abrir espaço pra uma 2ª caixa vazia
  // — o card só vira "2 fotos lado a lado" quando o produto realmente tem
  // uma 2ª foto; produto com 1 foto só continua exatamente como sempre foi
  // (foto grande, ocupando a largura toda). Isso deixa o tamanho da foto
  // inconsistente entre cards da mesma página — trade-off aceito, a
  // alternativa (2ª caixa sempre reservada, vazia quando não existe) foi
  // rejeitada.
  // 2026-10-14: layout decidido pelas fotos que ABREM, não pelas que estão
  // indexadas — ver _fotosUtilizaveis para o bug que isso corrige.
  let fotosDesenhadas = 0;
  const fotosOk = _fotosUtilizaveis(doc, produto.codigo);
  if (fotosOk.length >= 2) {
    const larguraMetade = (larguraConteudo - GAP_DUAS_FOTOS) / 2;
    if (_desenharFotoProtegida(doc, fotosOk[0], xConteudo, yFoto, larguraMetade, photoBoxHeight)) fotosDesenhadas += 1;
    if (_desenharFotoProtegida(doc, fotosOk[1], xConteudo + larguraMetade + GAP_DUAS_FOTOS, yFoto, larguraMetade, photoBoxHeight)) fotosDesenhadas += 1;
  } else if (fotosOk.length === 1) {
    if (_desenharFotoProtegida(doc, fotosOk[0], xConteudo, yFoto, larguraConteudo, photoBoxHeight)) fotosDesenhadas += 1;
  }
  if (!fotosDesenhadas) {
    doc.font("Helvetica").fontSize(7).fillColor("#9ca3af")
      .text("sem foto", xConteudo, yFoto + photoBoxHeight / 2 - 5, { width: larguraConteudo, align: "center" });
  }
  doc.fillColor("#111827").font("Helvetica");

  // --- Código da loja + descrição resumida, numa linha só, embaixo da foto ---
  // 2026-08-27 (revertido de novo — ver comentário no selo acima): código
  // da loja volta pra esta linha, na frente da descrição. produto.codigo
  // é o código INTERNO da loja (ex: "117437"), diferente do código do
  // fabricante que volta a ir no selo azul lá em cima. Mesma fonte do
  // selo/OEM (Futura MD BT, ver pedido "a fonte do meu codigo e descrição
  // deixe futura mb bt"). "Resumida" = 1 linha só, corta com "..." se não
  // couber (ao contrário do selo do fabricante, aqui NÃO foi pedido pra
  // nunca truncar).
  const yResumo = yFoto + photoBoxHeight + GAP_FOTO_RESUMO;
  let resumo = `${produto.codigo} - ${_nomeExibicao(produto, true).toUpperCase()}`;

  if (produto.aplicacaoOrganizada) {
    // 2026-09-01 (pedido do usuário: "retire pontos no final das
    // descrições") — reverte o "padronize ponto final" de 2026-08-28: não
    // acrescenta mais "." mesmo quando o texto cabe inteiro na linha.
    doc.font(TITULO_FONTE).fontSize(RESUMO_FONTE);
    doc.fillColor("#111827").font(TITULO_FONTE).fontSize(RESUMO_FONTE)
      .text(resumo, xConteudo, yResumo, {
        width: larguraConteudo,
        height: RESUMO_ALTURA,
        ellipsis: true,
        lineBreak: false,
      });

    // --- Aplicação (até 2 linhas, embaixo da linha de resumo) ---
    const yAplicacao = yResumo + RESUMO_ALTURA + GAP_RESUMO_APLICACAO;
    _desenharAplicacao(doc, produto.aplicacaoOrganizada, xConteudo, yAplicacao, larguraConteudo, APLICACAO_ALTURA, marcaAtual);
  } else {
    // 2026-08-28: pedido do usuário "os que não tiverem aplicação deixe a
    // descrição completa com uma quebra de linha" — produto sem
    // aplicacaoOrganizada (grupo MARCA_OUTRAS) não tem o bloco de
    // aplicação embaixo pra desenhar, então em vez de desperdiçar aquele
    // espaço com o resumo cortado em 1 linha só, usa o espaço INTEIRO
    // (resumo + respiro + aplicação somados) pra mostrar a descrição
    // completa, podendo quebrar em várias linhas — só corta com "..." se
    // realmente não couber nem assim (mesma lógica "cabe inteiro" de
    // _desenharAplicacao, aqui via heightOfString em vez de widthOfString
    // porque agora é um bloco multi-linha, não mais 1 linha só).
    // 2026-09-01 (pedido do usuário: "retire pontos no final das
    // descrições") — mesma reversão do bloco acima, aplicada aqui pro
    // produto sem aplicacaoOrganizada (descrição completa multi-linha).
    const alturaDescricaoCompleta = RESUMO_ALTURA + GAP_RESUMO_APLICACAO + APLICACAO_ALTURA;
    doc.font(TITULO_FONTE).fontSize(RESUMO_FONTE);
    doc.fillColor("#111827").font(TITULO_FONTE).fontSize(RESUMO_FONTE)
      .text(resumo, xConteudo, yResumo, {
        width: larguraConteudo,
        height: alturaDescricaoCompleta,
        ellipsis: true,
        lineGap: 0.5,
      });
  }

  doc.font("Helvetica");
}

// Extraído de gerarPdfCatalogo (2026-08-26, Issue #21) — desenha um card de
// produto completo em x/y dados, sem saber nada sobre grade/paginação.
// 2026-09-19: gerarPdfCatalogo passou a delegar 100% pra
// gerarPdfCatalogoCompleto (ver comentário lá), que só chama esta função
// com comAplicacao=true (grade 4×5, cabeçalho novo — selo+descrição lado a
// lado + OEM em vermelho + foto maior + aplicação em preto, ver
// _desenharCardCatalogoCompleto). O ramo comAplicacao=false abaixo (desenho
// original: selo sobre a foto + nome abaixo, sem aplicação) ficou sem
// nenhum call site — mantido de propósito (não deletado) como referência
// caso algum modo futuro precise do card mais simples de volta; Knip pode
// acusar como não usado, é esperado.
function _desenharCard(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, comAplicacao = false, marcaAtual = null, preco = null, estilo = "eletrica") {
  _desenharCardVidro(doc, x, y, cardWidth, cardHeight);

  if (comAplicacao) {
    _desenharCardCatalogoCompleto(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, marcaAtual, preco, estilo);
    return;
  }

  const xFoto = x + PAD_CARD;
  const yFoto = y + PAD_CARD;

  // 2026-09-08: mesma regra "2 fotos por card" do Catálogo Completo
  // (_desenharCardCatalogoCompleto, pedido do usuário 2026-09-05), estendida
  // pra cá — usuário notou que a exportação de Critérios de Pesquisa não
  // tinha ganhado o mesmo comportamento na época. Produto com 2 fotos
  // cadastradas mostra as 2 lado a lado; com 1 foto só, continua exatamente
  // como sempre foi (foto grande, ocupando a caixa toda).
  // 2026-10-14: mesma correção do Catálogo Completo — ver _fotosUtilizaveis.
  let fotosDesenhadas = 0;
  const fotosOk = _fotosUtilizaveis(doc, produto.codigo);
  if (fotosOk.length >= 2) {
    const larguraMetade = (photoBoxWidth - GAP_DUAS_FOTOS) / 2;
    if (_desenharFotoProtegida(doc, fotosOk[0], xFoto, yFoto, larguraMetade, photoBoxHeight)) fotosDesenhadas += 1;
    if (_desenharFotoProtegida(doc, fotosOk[1], xFoto + larguraMetade + GAP_DUAS_FOTOS, yFoto, larguraMetade, photoBoxHeight)) fotosDesenhadas += 1;
  } else if (fotosOk.length === 1) {
    if (_desenharFotoProtegida(doc, fotosOk[0], xFoto, yFoto, photoBoxWidth, photoBoxHeight)) fotosDesenhadas += 1;
  }
  if (!fotosDesenhadas) {
    doc.font("Helvetica").fontSize(7).fillColor("#9ca3af")
      .text("sem foto", xFoto, yFoto + photoBoxHeight / 2 - 5, { width: photoBoxWidth, align: "center" });
  }
  doc.fillColor("#111827").font("Helvetica");

  // Código de volta como SELO sobreposto no canto superior esquerdo da foto
  // — reusa _desenharCaixaCodigo, que já existia no arquivo desde 2026-07-29
  // mas tinha ficado sem uso desde 2026-07-30 (quando o código voltou a ser
  // uma linha de texto solta abaixo da foto). Desenhado por cima da foto
  // (ou do "sem foto"), independe da imagem ter carregado ou não.
  _desenharCaixaCodigo(doc, produto, xFoto, yFoto, photoBoxWidth);

  const yDivisoria = yFoto + photoBoxHeight + GAP_FOTO_DIVISORIA;
  doc.moveTo(x + PAD_CARD, yDivisoria).lineTo(x + cardWidth - PAD_CARD, yDivisoria)
    .lineWidth(0.6).strokeColor(LINHA_DIVISORIA, 0.8).stroke();

  // Sem o código como linha de texto própria, o nome sobe pra logo depois
  // da divisória (era yCodigo + CODIGO_ALTURA + GAP_CODIGO_NOME).
  const yNome = yDivisoria + GAP_DIVISORIA_TEXTO;
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(NOME_FONTE)
    .text(_nomeExibicao(produto, false).toUpperCase(), x + PAD_CARD, yNome, {
      width: cardWidth - PAD_CARD * 2,
      height: NOME_ALTURA,
      ellipsis: true,
      lineGap: 0.5,
    });

  doc.font("Helvetica");
}

function _desenharCabecalho(doc, tituloBusca, estilo = "eletrica", fabricante = "") {
  const w = doc.page.width;
  // EXPERIMENTO (EXP_PROMO=1): cabeçalho do Promocional no Completo elétrica — só para gerar mockup.
  if (process.env.EXP_PROMO === "1" && estilo !== "mecanica") {
    // Teste: arte do Promocional sem o texto "Catálogo promocional"; o nome da Linha vai na faixa amarela
    // e o título grande do bloco azul é removido (pedido do usuário, 2026-10-19).
    const hP = w / PROMO_CABECALHO_LINHA_RATIO;
    doc.image(path.join(__dirname, "../assets/catalogo-completo-cabecalho-teste.png"), 0, 0, { width: w, height: hP });
    const txt = String(tituloBusca || "").toUpperCase();
    const xT = w * 0.014, larg = w * 0.31, yFaixa = hP * (112 / 151), altFaixa = hP * (36 / 151);
    let fonteP = 16;
    doc.font(PROMO_TITULO_FONTE);
    while (fonteP > 7 && doc.fontSize(fonteP).widthOfString(txt) > larg) fonteP -= 0.5;
    doc.fillColor("#12408f").font(PROMO_TITULO_FONTE).fontSize(fonteP)
      .text(txt, xT, yFaixa + (altFaixa - fonteP) / 2, { width: larg, height: fonteP * 1.3, align: "left", lineBreak: false });
    doc.fillColor("#111827").font("Helvetica");
    return;
  }

  // Pedido do usuário (2026-09-04, "Mecânica.pdf"): cabeçalho Mecânica v2
  // usa a logo do FABRICANTE (ou fallback em texto) sobre o fundo em
  // degradê já pintado por _desenharFundoGradienteMecanica, em vez da arte
  // genérica Rildon — ver _desenharLogoCabecalhoMecanica. Sai ANTES de
  // qualquer outra coisa porque troca o desenho do "topo" inteiro; a barra
  // de título navy (mais abaixo, também condicionada a estilo==="mecanica")
  // continua igual.
  if (estilo === "mecanica") {
    _desenharLogoCabecalhoMecanica(doc, fabricante);
  } else {
    // Pedido do usuário (2026-07-29): "coloque exatamente isso sem alterações
    // como cabeçalho" — arte cinza/azul cobrindo a largura inteira da página,
    // sem esticar/espremer (altura REAL calculada na proporção exata do
    // arquivo — ver CABECALHO_IMG_ALTURA_REAL). É uma imagem opaca (sem
    // transparência), então substitui de vez o retângulo cinza chapado que
    // existia antes.
    //
    // Pedido do usuário (2026-07-30, 3ª rodada de "suba mais o cabeçalho"):
    // desenhada em y NEGATIVO (sangria) — a imagem inteira, sem cortar/
    // distorcer um pixel, só desenhada um pouco pra cima da borda da página;
    // a fatia que passa de y=0 fica fora da página (invisível), então o
    // cabeçalho aparece mais baixo sem alterar o arquivo de verdade.
    //
    // 2026-08-28: X e largura de desenho agora usam o zoom de bleed
    // horizontal (ver CABECALHO_ESCALA_BLEED/CABECALHO_IMG_X_DESENHO acima) —
    // a imagem começa um pouco antes de x=0 e termina um pouco depois de
    // x=w, de propósito, pra empurrar a margem branca real do arquivo pra
    // fora da página nos dois lados.
    doc.image(CABECALHO_IMG, CABECALHO_IMG_X_DESENHO, -CABECALHO_SANGRIA_TOPO, { width: CABECALHO_IMG_LARGURA_DESENHO, height: CABECALHO_IMG_ALTURA_REAL });
  }

  // Pedido do usuário (2026-07-30): removido "RILDON PEÇAS" / "Catálogo
  // Expresso" do cabeçalho — a arte de fundo já carrega a identidade visual,
  // texto extra não é mais necessário.

  // Pedido do usuário (2026-07-28): título da seção em "Futura Md BT" 17pt.
  // Fonte registrada no doc via doc.registerFont em gerarPdfCatalogo (uma
  // vez por documento, antes da 1ª página) — ver TITULO_FONTE_ARQUIVO/
  // TITULO_FONTE no topo do arquivo.
  const tituloTexto = String(tituloBusca || "").toUpperCase();
  const tituloX = PAGE_MARGIN;
  // Pedido do usuário (2026-07-30, 2ª rodada): título começa SÓ DEPOIS que a
  // arte do cabeçalho termina (HEADER_HEIGHT + TITULO_GAP_TOPO) — nunca mais
  // sobreposto à imagem, então não tem como "encostar" no cinza da arte.
  // 2026-09-22: estilo mecânica usa MECANICA_HEADER_HEIGHT (mais enxuta,
  // ver comentário na constante) em vez de HEADER_HEIGHT (arte da elétrica).
  // 2026-10-19: "a linha, desça um pouquinho" — só o título desce (não mexe na área dos cards).
  const tituloY = (estilo === "mecanica" ? MECANICA_HEADER_HEIGHT : HEADER_HEIGHT) + TITULO_GAP_TOPO + (estilo === "mecanica" ? 0 : 6);
  const tituloLargura = w - PAGE_MARGIN * 2;

  // Estilo "Mecânica" (pedido do usuário, 2026-09-03, fabricante PERFECT —
  // ver _estiloCatalogoCompleto/MECANICA_* no topo do arquivo): barra sólida
  // azul-marinho ocupando a MESMA largura da grade de cards (tituloX/
  // tituloLargura, já alinhados ao PAGE_MARGIN igual o grid — pedido
  // literal do usuário foi "alinhar os cards de acordo com as grades
  // tracejadas", não redesenhar a arte do cabeçalho), texto branco em
  // Montserrat ExtraBold, sem sombra (a sombra do estilo elétrica existe
  // pra destacar texto colorido sobre o cabeçalho cinza; aqui o texto já
  // tem contraste total contra o navy). LIMITAÇÃO conhecida: a arte do
  // cabeçalho/rodapé (CABECALHO_IMG) continua sendo a genérica Rildon —
  // usuário confirmou "já temos o design das páginas", fora de escopo
  // deste round.
  if (estilo === "mecanica") {
    const barraAltura = TITULO_TAMANHO + 10;
    const barraY = tituloY - 3;
    doc.rect(tituloX, barraY, tituloLargura, barraAltura).fill(MECANICA_TITULO_FUNDO);
    doc.fillColor(MECANICA_TITULO_TEXTO).font(MECANICA_TITULO_FONTE).fontSize(TITULO_TAMANHO)
      .text(tituloTexto, tituloX + 10, barraY + (barraAltura - TITULO_TAMANHO) / 2 - 1, {
        width: tituloLargura - 20,
      });
    doc.fillColor("#111827").font("Helvetica");
    return;
  }

  // 2026-09-11: eco atrás do título (ver _textoComEco) + sombra simples
  // (pedido do usuário 2026-07-30) entre o eco e o texto principal —
  // técnica igual à referência que o usuário mandou antes (título com
  // sombra duplicada), agora com a camada extra de eco medida no catálogo
  // original 3-RHO.
  _textoComEco(doc, tituloTexto, tituloX, tituloY, VERMELHO_CATEGORIA, { width: tituloLargura }, TITULO_TAMANHO);

  doc.fillColor("#111827").font("Helvetica");
}

function _desenharRodape(doc, numeroPagina, estilo = "eletrica") {
  const w = doc.page.width;
  const h = doc.page.height;

  // Pedido do usuário (2026-09-04, "Mecânica.pdf"): rodapé Mecânica v2 —
  // linha fina navy + logo "Grupo Rildon" (esquerda) + "OMRE+ Distribuidora
  // de Peças Automotivas" (direita) sobre o fundo em degradê, em vez do
  // RODAPE_IMG genérico (que só continua nos catálogos Elétrica). Sem o
  // triângulo branco da arte antiga — número de página vira texto simples
  // no canto inferior direito.
  if (estilo === "mecanica") {
    const rodapeTop = h - MECANICA_RODAPE_ALTURA;
    doc.moveTo(PAGE_MARGIN, rodapeTop).lineTo(w - PAGE_MARGIN, rodapeTop)
      .lineWidth(MECANICA_LINHA_FINA_ESPESSURA).strokeColor(MECANICA_LINHA_FINA_COR).stroke();

    const logoAreaY = rodapeTop + 10;
    const logoAltura = MECANICA_RODAPE_ALTURA - 20;
    const larguraRildon = logoAltura * MECANICA_RODAPE_LOGO_RILDON_RATIO;
    doc.image(MECANICA_RODAPE_LOGO_RILDON_IMG, PAGE_MARGIN, logoAreaY, { width: larguraRildon, height: logoAltura });
    const larguraOmre = logoAltura * MECANICA_RODAPE_LOGO_OMRE_RATIO;
    doc.image(MECANICA_RODAPE_LOGO_OMRE_IMG, w - PAGE_MARGIN - larguraOmre, logoAreaY, { width: larguraOmre, height: logoAltura });

    doc.fillColor(MECANICA_LINHA_FINA_COR).font(RODAPE_NUMERO_FONTE).fontSize(12)
      .text(String(numeroPagina), w - PAGE_MARGIN - 40, h - 22, { width: 40, align: "right", lineBreak: false });
    doc.fillColor("#111827").font("Helvetica");
    return;
  }

  // Imagem real da logo Rildon cobrindo a largura inteira da página, sem
  // distorcer (altura já calculada na proporção exata do arquivo — ver
  // RODAPE_IMG_RATIO).
  doc.image(process.env.EXP_PROMO === "1" ? path.join(__dirname, "../assets/catalogo-rodape-azul-teste.png") : RODAPE_IMG, 0, h - FOOTER_HEIGHT, { width: w, height: FOOTER_HEIGHT });

  // Nº de página em preto, maior, centralizado dentro do triângulo branco da
  // arte (pedido do usuário, 2026-07-28) — coordenadas medidas na imagem
  // real (ver RODAPE_NUM_X_FRACAO/RODAPE_NUM_Y_FRACAO).
  //
  // ARMADILHA (já aconteceu aqui): se `y` + altura do texto passar de
  // doc.page.height, o pdfkit entende que o texto não cabe e insere uma
  // PÁGINA NOVA automaticamente pra desenhar o número — o número "some" da
  // página certa e aparece sozinho, deslocando todo o resto do PDF uma
  // página pra frente. `yMaximo` abaixo trava isso: nunca deixa o texto
  // passar do fundo da página, não importa o que RODAPE_NUM_Y_FRACAO diga.
  const footerTop = h - FOOTER_HEIGHT;
  const centroX = w * RODAPE_NUM_X_FRACAO;
  const centroY = footerTop + FOOTER_HEIGHT * RODAPE_NUM_Y_FRACAO;
  const fonteNumero = 20;
  const larguraCaixa = 90;
  const alturaLinhaAprox = fonteNumero * 1.3;
  const yMaximo = h - alturaLinhaAprox - 2;
  const yTexto = Math.min(centroY - fonteNumero / 2, yMaximo);

  doc.fillColor("#111827").font(RODAPE_NUMERO_FONTE).fontSize(fonteNumero)
    .text(String(numeroPagina), centroX - larguraCaixa / 2, yTexto, { width: larguraCaixa, align: "center", lineBreak: false });

  doc.fillColor("#111827").font("Helvetica");
}

// 2026-08-31 (Catálogo Promocional — ver comentário em
// PROMO_CABECALHO_LINHA_IMG acima): cabeçalho/rodapé dedicados, escolhidos
// por `modo` ("linha" | "fabricante"). Mesmo padrão de _desenharCabecalho/
// _desenharRodape (imagem cobrindo a largura inteira, altura derivada da
// proporção real do arquivo — nunca distorce), só que sem o zoom de bleed
// (os 4 arquivos já vêm sem margem branca, ver comentário acima) e com
// título/"Página N" desenhados dentro da área seguro medida em
// PROMO_TITULO_AREA/PROMO_PAGINA_AREA.
function _desenharCabecalhoPromo(doc, titulo, modo, logo = null) {
  const w = doc.page.width;
  const ehFabricante = modo === "fabricante";
  const img = ehFabricante ? PROMO_CABECALHO_FABRICANTE_IMG : PROMO_CABECALHO_LINHA_IMG;
  const ratio = ehFabricante ? PROMO_CABECALHO_FABRICANTE_RATIO : PROMO_CABECALHO_LINHA_RATIO;
  const h = w / ratio;
  doc.image(img, 0, 0, { width: w, height: h });

  const area = ehFabricante ? PROMO_TITULO_AREA.fabricante : PROMO_TITULO_AREA.linha;
  const x = w * area.xFrac0;
  const larguraTexto = w * (area.xFrac1 - area.xFrac0);
  const yTopo = h * area.yFrac0;
  const alturaArea = h * (area.yFrac1 - area.yFrac0);

  const tituloTexto = String(titulo || "").toUpperCase();
  // 2026-08-31 (pedido do usuário: "padronize fonte montserrat 40px" +
  // "centralize o nome da categoria") pro modo LINHA: tamanho fixo em
  // PROMO_TITULO_TAMANHO (40) e centralizado dentro da área segura — só
  // encolhe abaixo de 40 se o nome não couber, nunca aumenta acima de 40
  // mesmo pra nomes curtos.
  //
  // 2026-08-31, mesmo dia — modo FABRICANTE tratado diferente: comparando
  // o cabeçalho renderizado ("SEM FABRICANTE IDENTIFICADO") lado a lado
  // com o mockup ("Catálogo de marca"), o usuário achou "distorcido" — o
  // fundo batia pixel a pixel (conferido), mas nomes de fabricante mais
  // longos que o texto curto do mockup forçavam o loop de auto-encolher a
  // reduzir bastante a fonte de 40, ficando desproporcional. Usuário
  // escolheu fonte máxima menor e fixa (PROMO_TITULO_TAMANHO_FABRICANTE,
  // 24) + alinhado à esquerda (não centralizado) — mais parecido com o
  // peso visual do mockup mesmo em nomes de fabricante longos.
  const tamanhoMaximo = ehFabricante ? PROMO_TITULO_TAMANHO_FABRICANTE : PROMO_TITULO_TAMANHO;
  const alinhamento = ehFabricante ? "left" : "center";
  let fonte = Math.min(tamanhoMaximo, alturaArea * 0.9);
  doc.font(PROMO_TITULO_FONTE);
  while (fonte > 10 && doc.fontSize(fonte).widthOfString(tituloTexto) > larguraTexto) {
    fonte -= 1;
  }
  const yTexto = yTopo + (alturaArea - fonte) / 2;
  doc.fillColor(area.cor).font(PROMO_TITULO_FONTE).fontSize(fonte)
    .text(tituloTexto, x, yTexto, { width: larguraTexto, height: fonte * 1.3, align: alinhamento, ellipsis: true, lineBreak: false });

  if (logo && ehFabricante) {
    const bx = w * PROMO_LOGO_AREA.xFrac0;
    const by = h * PROMO_LOGO_AREA.yFrac0;
    const bw = w * (PROMO_LOGO_AREA.xFrac1 - PROMO_LOGO_AREA.xFrac0);
    const bh = h * (PROMO_LOGO_AREA.yFrac1 - PROMO_LOGO_AREA.yFrac0);
    doc.image(logo, bx, by, { fit: [bw, bh], align: "center", valign: "center" });
  }

  doc.fillColor("#111827").font("Helvetica");
}

function _desenharRodapePromo(doc, numeroPagina, modo) {
  const w = doc.page.width;
  const hPagina = doc.page.height;
  const ehFabricante = modo === "fabricante";
  const img = ehFabricante ? PROMO_RODAPE_FABRICANTE_IMG : PROMO_RODAPE_LINHA_IMG;
  const ratio = ehFabricante ? PROMO_RODAPE_FABRICANTE_RATIO : PROMO_RODAPE_LINHA_RATIO;
  const h = w / ratio;
  const topo = hPagina - h;
  doc.image(img, 0, topo, { width: w, height: h });

  const area = ehFabricante ? PROMO_PAGINA_AREA.fabricante : PROMO_PAGINA_AREA.linha;
  const fonteNumero = 11;
  const larguraCaixa = 90;
  const centroX = w * area.xFrac;
  const centroY = topo + h * area.yFrac;
  doc.fillColor(area.cor).font(RODAPE_NUMERO_FONTE).fontSize(fonteNumero)
    .text(`Página ${numeroPagina}`, centroX - larguraCaixa / 2, centroY - fonteNumero / 2, { width: larguraCaixa, align: "center", lineBreak: false });

  doc.fillColor("#111827").font("Helvetica");
}

// Agrupa produtos por Linha (Issue #21) — usa p.linha, caindo pra p.secao e
// depois "Outros" se nenhum dos dois vier preenchido. Já são campos
// indexados em catalogo-x2.service.js, nenhum dado novo precisou ser
// buscado. Ordenado alfabeticamente (pt-BR) pelo nome da Linha — mesma
// ordem em que vai aparecer no índice e no corpo do PDF.
function _agruparPorLinha(produtos) {
  const grupos = new Map();
  produtos.forEach((produto) => {
    const chave = String(produto.linha || produto.secao || "Outros").trim() || "Outros";
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(produto);
  });
  return Array.from(grupos.entries())
    .map(([linha, itens]) => ({ linha, itens }))
    .sort((a, b) => a.linha.localeCompare(b.linha, "pt-BR"));
}

// 2026-08-31 (Catálogo Promocional, modo "fabricante" — pedido do usuário:
// "poderá ser por linha ou por fabricante ... por fabricante todos os
// produtos serão de fabricante especifico por exemplo Gauss, Perfect etc"):
// mesmo princípio de _agruparPorLinha, mas a chave é `produto.fabricante`
// (campo já extraído do nome do produto em catalogo-x2.service.js,
// _extrairFabricante/_normalizarFabricante — não é um dado novo). Devolve
// o mesmo formato `{linha, itens}` que _construirSequenciaConteudoPromocional
// já espera (aqui `linha` carrega o NOME DO FABRICANTE, não da Linha) — não
// duplica a função de sequência/paginação, só troca o critério de
// agrupamento antes dela.
function _agruparPorFabricante(produtos) {
  const grupos = new Map();
  produtos.forEach((produto) => {
    const chave = String(produto.fabricante || "Sem fabricante identificado").trim() || "Sem fabricante identificado";
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(produto);
  });
  return Array.from(grupos.entries())
    .map(([linha, itens]) => ({ linha, itens }))
    .sort((a, b) => a.linha.localeCompare(b.linha, "pt-BR"));
}

// 2026-08-28 (sub-agrupamento por marca de veículo, ver comentário em
// MARCA_HEADER_FONTE): extrai as marcas de veículo citadas no texto de
// aplicação de UM produto — mesmo parser usado em _desenharAplicacao pra
// achar os segmentos "MARCA: modelos" (texto.split(/;\s*/) + regex
// /^([^:]+):/ por segmento), mas aqui só a lista de marcas interessa, não
// o texto completo. Usa _normalizarMarcasTexto ANTES de parsear — mesma
// padronização "MERCEDES-BENZ"->"MB"/"VOLKSWAGEN"->"VW" do desenho, pra
// grupo e texto exibido nunca divergirem. Marca sempre em MAIÚSCULAS na
// chave de agrupamento: a mesma peça pode ter "FORD" num produto e "Ford"
// noutro (dado vem de texto livre gerado por IA, casing inconsistente
// entre textos diferentes — ver exemplos reais em aplicacao-ia-cache.json)
// e os dois precisam cair no MESMO sub-grupo, não em dois quase-iguais.
// Segmento sem ":" (dado malformado raro, ex. "EATON; FORD: Cargo...")
// não vira marca — esse pedaço específico só não entra em grupo nenhum,
// sem derrubar as marcas boas do mesmo produto.


// 2026-09-03 (pedido do usuário: "muitos produtos estão sendo direcionados
// a outras aplicações mesmo tendo marcas nas suas aplicações [...] preciso
// também da marca Universal"): investigando o cache real
// (aplicacao-ia-cache.json), a IA (PROMPT_APLICACAO_SISTEMA em
// ai.service.js) nem sempre devolve o formato "MARCA: modelo" — quando não
// há modelo/especificação pra listar, ela devolve só o nome cru da marca,
// às vezes várias separadas por ";" sem NENHUM ":" na frase inteira. Casos
// reais encontrados no cache: "UNIVERSAL", "MBB", "AGRALE",
// "UNIVERSAL; GM; FIAT; FORD; PEUGEOT; VW", "KOMATSU; MERCEDES BENZ" — o
// regex antigo (só `^([^:]+):`) não reconhecia nenhum desses como marca,
// então o produto inteiro caía em MARCA_OUTRAS mesmo citando marca(s) reais
// (inclusive "Universal", que é tratado como um termo genérico válido pela
// própria regra 3 do prompt, não uma ausência de marca).
// Fix: um segmento sem ":" agora também vira marca — o segmento inteiro,
// tal como veio — DESDE QUE pareça um nome de marca/termo curto, não uma
// frase descritiva de verdade (ex. "Aplicado no reservatório de água do
// radiador", "Cabos BCFLEX Auto recomendados para..."). Heurística: até 50
// caracteres e sem terminar em pontuação de frase (. ! ?) — suficiente pra
// cobrir os casos reais do cache sem capturar prosa solta como marca falsa.
const MARCA_SEGMENTO_SEM_DOISPONTOS_MAX_CHARS = 50;
// Pedido do usuário (2026-09-03, follow-up do fix acima): "acho melhor
// deixar Universal / Diversos" — em vez de "UNIVERSAL" e "DIVERSOS"
// virarem dois sub-grupos separados (ou variações como "DIVERSOS
// MOTORES", "UNIVERSAL, USO GERAL"), unifica tudo num só cabeçalho
// canônico. Casada em cima do valor já extraído (funciona pros dois
// ramos da função — com ":" ou sem), então cobre tanto "Universal:
// todos os modelos" quanto o "UNIVERSAL" cru do cache.
const MARCA_ALIAS_UNIVERSAL_REGEX = /^(universal|diversos?)\b/i;
const MARCA_UNIVERSAL_CANONICA = "UNIVERSAL / DIVERSOS";
// MARCA_OUTRAS (catch-all de produto sem marca nenhuma, declarada lá em
// cima por causa da ordem de uso no arquivo) usa esse MESMO texto
// literal, de propósito — ver comentário dela.

// Pedido do usuário (2026-09-05): "quando algum produto estiver sem marca
// na descrição ou na aplicação coloca como outras aplicações" — exemplo
// real reportado: aplicação "Tratores" (sem ":") virava um cabeçalho de
// marca "TRATORES" no Catálogo Completo, quando "Tratores" não é marca
// nenhuma (é o tipo de MÁQUINA, não o fabricante) e deveria cair em
// MARCA_OUTRAS como qualquer outro produto sem marca de verdade
// identificável. BUG REAL: o ramo "sem dois-pontos" de _extrairMarcas (ver
// comentário 2026-09-03 logo acima, sobre "UNIVERSAL"/"MBB"/"AGRALE" soltos
// sem ":") aceitava QUALQUER segmento curto sem pontuação de frase como
// marca — bom pras marcas reais soltas que motivaram o fix original, mas
// também aceitava termo genérico de categoria ("Tratores", "Máquina",
// "Empilhadeiras" etc.) como se fosse marca. Fix: reaproveita
// MARCAS_VEICULO_CONHECIDAS (já validada contra dado real do catálogo em
// catalogo-x2.service.js, mesma lista usada no filtro "Montadora" da busca
// — ver listarMarcasVeiculoConhecidas) pra só aceitar o segmento sem ":"
// quando ele É (ou contém) uma marca de verdade da lista, ou é o alias
// Universal/Diversos.
// 2026-09-11 (pedido do usuário, exemplo real: catálogo completo 3RHO
// mostrando "CAIXAS" como se fosse marca própria, com só 1 produto — o
// texto de aplicação era "Caixas: G 100-2, G 131-9, ..." — "Caixas" é o
// TIPO de peça/categoria, não o fabricante, que nesses casos não foi
// identificável): o ramo COM ":" ("MARCA: modelo") ATÉ 2026-09-11 confiava
// no formato explícito sem validar contra a lista — deliberado, pra não
// rejeitar marca real ainda não catalogada (ver histórico deste comentário
// antes desta data). O usuário pediu explicitamente o oposto: "esses que
// você não identificar marca pode colocar em outras aplicações" — ou seja,
// prefere um produto caindo em MARCA_OUTRAS (Outras Aplicações, sem grupo
// próprio) a um grupo-fantasma feito de um rótulo de categoria. Por isso o
// ramo COM ":" agora passa pela MESMA validação _pareceMarcaConhecida do
// ramo sem ":" — um texto antes do ":" que não seja (nem contenha) uma
// marca da lista MARCAS_VEICULO_CONHECIDAS cai em MARCA_OUTRAS em vez de
// virar grupo próprio. Contrapartida aceita pelo usuário: uma marca real
// ainda não catalogada na lista fixa (ex. um fabricante novo de máquina)
// também cairia em Outras até alguém adicionar essa marca na lista em
// catalogo-x2.service.js — ver MARCAS_VEICULO_CONHECIDAS.
const MARCAS_VEICULO_CONHECIDAS_SET = new Set(listarMarcasVeiculoConhecidas());
function _pareceMarcaConhecida(candidato) {
  if (MARCA_ALIAS_UNIVERSAL_REGEX.test(candidato)) return true;
  if (MARCAS_VEICULO_CONHECIDAS_SET.has(candidato)) return true;
  return candidato.split(/\s+/).some((palavra) => MARCAS_VEICULO_CONHECIDAS_SET.has(palavra));
}

function _extrairMarcas(textoOriginal) {
  if (!textoOriginal) return [];
  const texto = _normalizarMarcasTexto(textoOriginal);
  const marcas = [];
  texto.split(/;\s*/).filter(Boolean).forEach((parte) => {
    const trimmed = parte.trim();
    const match = trimmed.match(/^([^:]+):/);
    let marca;
    if (match) {
      const candidato = match[1].trim().toUpperCase();
      // 2026-09-11: só aceita como marca própria se for (ou conter) uma
      // marca conhecida, ou o alias Universal/Diversos — "Caixas:",
      // "Compressores:" etc. não são marca, são categoria/tipo de peça, e
      // caem em MARCA_OUTRAS (ver comentário acima da
      // MARCAS_VEICULO_CONHECIDAS_SET; _pareceMarcaConhecida já cobre o
      // alias Universal/Diversos internamente).
      if (_pareceMarcaConhecida(candidato)) {
        marca = candidato;
      } else {
        return;
      }
    } else if (
      trimmed.length > 0 &&
      trimmed.length <= MARCA_SEGMENTO_SEM_DOISPONTOS_MAX_CHARS &&
      !/[.!?]$/.test(trimmed) &&
      _pareceMarcaConhecida(trimmed.toUpperCase())
    ) {
      marca = trimmed.toUpperCase();
    } else {
      return;
    }
    if (MARCA_ALIAS_UNIVERSAL_REGEX.test(marca)) marca = MARCA_UNIVERSAL_CANONICA;
    if (marca && !marcas.includes(marca)) marcas.push(marca);
  });
  return marcas;
}

// Sub-agrupa os itens de UMA Linha por marca de veículo. Pedido explícito
// do usuário (2026-08-28): "se caso uma peça aparecer para ford e também
// kia, deixe os duplicados" — produto com N marcas entra em CADA um dos N
// sub-grupos (o MESMO objeto `produto`, sem clonar — cada card desenhado
// a partir dele fica idêntico, só a posição/sub-grupo mudam). Produto sem
// nenhuma marca identificável cai em MARCA_OUTRAS, sempre por último
// (catch-all, não teria sentido ordenado no meio alfabético das marcas
// de verdade).
function _agruparPorMarca(itens) {
  const grupos = new Map();
  itens.forEach((produto) => {
    const marcas = _extrairMarcas(produto.aplicacaoOrganizada);
    const chaves = marcas.length > 0 ? marcas : [MARCA_OUTRAS];
    chaves.forEach((marca) => {
      if (!grupos.has(marca)) grupos.set(marca, []);
      grupos.get(marca).push(produto);
    });
  });

  const semOutras = Array.from(grupos.entries()).filter(([marca]) => marca !== MARCA_OUTRAS);
  semOutras.sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
  const resultado = semOutras.map(([marca, produtos]) => ({ marca, produtos }));
  if (grupos.has(MARCA_OUTRAS)) {
    resultado.push({ marca: MARCA_OUTRAS, produtos: grupos.get(MARCA_OUTRAS) });
  }
  return resultado;
}

// Achata grupos (Linha) -> sub-grupos (Marca) -> produtos numa única
// sequência de "blocos" na ordem exata em que vão ser desenhados: um
// bloco "cabecalhoMarca" antes de cada sub-grupo, seguido dos blocos
// "card" dos produtos daquele sub-grupo (já duplicados por marca, ver
// _agruparPorMarca). `primeiroIndicePorGrupo[i]` guarda o índice em
// `sequencia` onde a Linha `grupos[i]` COMEÇA (sempre um bloco
// "cabecalhoMarca", o do 1º sub-grupo de marca daquela Linha) — usado
// depois pra descobrir em que página cada Linha começa (ver
// _calcularLayoutConteudo), sem precisar re-varrer a sequência inteira.
// 2026-09-05 (bug real reportado pelo usuário: print da seção "MANÔMETRO DO
// ÓLEO" mostrando DOIS blocos "OUTRAS APLICAÇÕES" seguidos, o 2º sem
// nenhuma indicação de que era na verdade outra Linha — "SINALIZEIRA...
// EMPILHADEIRAS", não manômetro nenhum): o título grande da página
// (_desenharCabecalho) só é redesenhado em quebra de página de verdade — se
// uma Linha nova começa NO MEIO de uma página (grade contínua, ver
// _construirSequenciaConteudo/comentário de 2026-08-27), o único sinal
// visual da troca é o cabeçalho de marca (_desenharCabecalhoMarca), que usa
// a MESMA cor/fonte do título da Linha (ver comentário ali). Se essa nova
// Linha também cai em MARCA_OUTRAS, o cliente vê só mais um "OUTRAS
// APLICAÇÕES" idêntico ao anterior, sem saber que trocou de categoria de
// produto inteira. `inicioDeLinha: true` marca o 1º bloco "cabecalhoMarca"
// de cada Linha (sempre existe um, mesmo Linhas com só 1 produto) — usado
// no loop de desenho (gerarPdfCatalogoCompleto) pra prefixar o nome da
// Linha no cabeçalho de marca quando essa troca acontece sem passar por
// _desenharCabecalho.
// `semSubAgrupamentoMarca` (pedido do usuário, 2026-09-05, catálogo
// "Diversos" — ver PSEUDO_FABRICANTE_DIVERSOS/gerarPdfCatalogoCompleto):
// quando true, `grupos` já veio agrupado por MARCA de veículo (em vez de
// Linha — ver _agruparPorMarca remapeado no chamador), então NÃO
// sub-agrupa de novo por marca aqui dentro (senão um produto com 2 marcas
// citadas na aplicação, ex. "MBB, VALMAT", já classificado no grupo-topo
// "MBB", ganharia um sub-cabeçalho redundante "VALMAT" aninhado dentro da
// página "MBB"). `marca` de cada bloco vira igual a `linha` (mesmo nome),
// só pra manter o mesmo formato de bloco que o resto do desenho
// (_desenharCabecalhoMarca/gerarPdfCatalogoCompleto) já espera — o texto
// de transição de página (trocouDeLinhaSemTitulo) detecta esse caso
// (linha===marca) e evita duplicar o nome (ver render loop).
function _construirSequenciaConteudo(grupos, semSubAgrupamentoMarca = false) {
  const sequencia = [];
  const primeiroIndicePorGrupo = [];
  grupos.forEach(({ linha, itens }) => {
    primeiroIndicePorGrupo.push(sequencia.length);
    let primeiroSubgrupoDaLinha = true;
    const subgrupos = semSubAgrupamentoMarca ? [{ marca: linha, produtos: itens }] : _agruparPorMarca(itens);
    subgrupos.forEach(({ marca, produtos }) => {
      // PEDIDO DO USUÁRIO (2026-09-14): espaço maior entre sub-grupos de
      // marca só quando exatamente 2 marcas caem juntas na MESMA PÁGINA
      // (ex. MASSEY FERGUSON/MAZDA) — não é uma propriedade da Linha (uma
      // Linha como FUSÍVEL tem dezenas de marcas espalhadas por várias
      // páginas), por isso NÃO dá pra decidir isso aqui, só depois de rodar
      // a paginação de verdade — ver o esquema de 2 passadas em
      // _calcularLayoutConteudo/MARCA_HEADER_GAP_ANTES_DUAS_MARCAS.
      sequencia.push({ tipo: "cabecalhoMarca", linha, marca, inicioDeLinha: primeiroSubgrupoDaLinha });
      primeiroSubgrupoDaLinha = false;
      // 2026-08-28: pedido do usuário "complete os cards por mais que só
      // tenham poucos produtos" — 1ª tentativa esticou a largura dos cards
      // pra preencher a linha (largura variável por leva). Usuário corrigiu
      // no mesmo dia: "fez errado, preciso que fiquem como antes não
      // estiquem, apenas coloque cards vazios para preencher espaço" — os
      // cards de produto voltam a ter a largura FIXA de sempre
      // (COLS_COMPLETO colunas, geometriaCompleto.cardWidth); a leva final
      // de cada sub-grupo, se tiver menos que COLS_COMPLETO produtos, é
      // completada com blocos "cardVazio" (sem produto — placeholder em
      // branco) nas colunas que sobrariam vazias, em vez de esticar ou
      // deixar a linha incompleta.
      for (let inicio = 0; inicio < produtos.length; inicio += COLS_COMPLETO) {
        const leva = produtos.slice(inicio, inicio + COLS_COMPLETO);
        leva.forEach((produto, colIndex) => {
          sequencia.push({ tipo: "card", linha, marca, produto, colIndex, colsLinha: COLS_COMPLETO });
        });
        for (let colIndex = leva.length; colIndex < COLS_COMPLETO; colIndex += 1) {
          sequencia.push({ tipo: "cardVazio", linha, marca, colIndex, colsLinha: COLS_COMPLETO });
        }
      }
      // PEDIDO DO USUÁRIO (2026-09-14, prints CABO DE TRANSFERÊNCIA/CORDOALHA
      // — "vamos especificar mais quando isso deve acontecer... todos esses
      // itens cabem em uma pagina só, nesse caso não deverá acontecer"):
      // cheguei a testar colar 1 linha vazia INCONDICIONAL aqui, direto na
      // sequência, depois de cada sub-grupo (commit anterior no mesmo dia) —
      // o usuário voltou atrás porque isso empurrava conteúdo que cabia
      // numa página só pra 2 páginas, só pra abrir espaço pras linhas vazias
      // (ex: CABO DE TRANSFERÊNCIA com só 4 marcas pequenas, cada uma com 1
      // linha de produto, virou 2 páginas cheias de vazio). A decisão de
      // colar essa linha de fechamento NÃO pode ser incondicional aqui — só
      // dá pra saber se ela "cabe de graça" (sem empurrar conteúdo real pra
      // página seguinte) depois de rodar a paginação de verdade. Por isso
      // essa linha de fechamento NÃO é mais gerada aqui — ver o bloco
      // "separador de marca" dentro de _rodarPasse, em
      // _calcularLayoutConteudo, que decide isso de forma oportunista:
      // insere a linha vazia só quando sobra espaço pra ela SEM forçar
      // quebra de página (senão, pula a linha vazia e deixa o cabeçalho da
      // próxima marca entrar direto, exatamente como decidia o gap normal
      // antes desse recurso existir).
    });
  });
  return { sequencia, primeiroIndicePorGrupo };
}

// 2026-08-29 (Issue nova função "Catálogo Promocional", pedido do usuário:
// "farei lista selecionada de produtos, não precisa subcategorizar, deixa
// como antes"): mesma ideia de _construirSequenciaConteudo (Linha -> cards
// numa sequência única, com cardVazio preenchendo a leva final), mas SEM o
// sub-agrupamento por marca (_agruparPorMarca) — nenhum bloco
// "cabecalhoMarca" é gerado, os cards de cada Linha entram direto na
// sequência. Consequência direta: _desenharAplicacao nunca recebe
// `marcaPrioritaria` pra esses cards (ver chamada em gerarPdfCatalogoPromocional
// mais abaixo), então o texto de aplicação sai completo/sem filtro por
// marca — exatamente o "deixa como antes" pedido (mesmo texto que
// aplicacaoOrganizada já traz, sem o corte por segmento que só faz sentido
// dentro de um sub-grupo de marca). `primeiroIndicePorGrupo` continua com o
// mesmo papel de sempre: índice em `sequencia` onde cada Linha começa, pro
// cálculo de página do índice/sumário.
// 2026-08-31 (modo "fabricante" — ver comentário em gerarPdfCatalogoPromocional):
// o 1º bloco "card" de cada grupo recebe `inicioDeGrupo: true`. Sozinho não
// muda nada (o modo "linha" ignora essa marcação — continua empacotando
// Linhas diferentes na mesma página, comportamento de sempre); só
// `_calcularLayoutConteudo` com `forcarQuebraEntreGrupos=true` (passado só
// quando modo==="fabricante", ver gerarPdfCatalogoPromocional) usa essa
// marcação pra forçar quebra de página — sem isso, 2 fabricantes pequenos
// (ex.: 4-5 produtos cada) cairiam na MESMA página, com o cabeçalho
// mostrando só o nome do 1º fabricante enquanto cards do 2º apareciam
// embaixo sem header próprio — inaceitável no modo "fabricante" (pedido do
// usuário: "por fabricante todos os produtos serão de fabricante
// especifico", ao contrário do modo "linha" onde isso é só organizacional).
// `iniciarGrupoEmLinhaNova` (default true, comportamento original): cada
// grupo sempre começa numa linha nova da grade, preenchendo a leva final
// com cardVazio até fechar COLS_COMPLETO colunas. Necessário no modo
// "fabricante", que também força página nova por grupo
// (forcarQuebraEntreGrupos em _calcularLayoutConteudo) — sem a leva
// preenchida, `bloco.colIndex === 0` podia não disparar no 1º card de um
// grupo pequeno, e o cabeçalho da página só pode citar 1 fabricante.
//
// 2026-09-01 (pedido do usuário, "de novo alguns bugs de pular cards" —
// reportado depois de ver cards sozinhos com espaço em branco do lado
// sempre que uma Linha não fechava múltiplo de 4 itens, ex: "AKX1140"
// isolado com 3 cards vazios): no modo "linha" (iniciarGrupoEmLinhaNova
// = false) o próximo grupo agora continua preenchendo a MESMA linha da
// grade em vez de sempre pular pra uma nova — colIndex vira uma contagem
// corrida (0..COLS_COMPLETO-1) atravessando todos os grupos, sem
// cardVazio nenhum entre eles. Isso já era a intenção declarada pro modo
// "linha" ao nível de PÁGINA ("paginação contínua... sem quebra forçada
// entre Linhas", ver gerarPdfCatalogoPromocional) — esta mudança só
// estende a mesma continuidade pro nível de LINHA da grade.
function _construirSequenciaConteudoPromocional(grupos, iniciarGrupoEmLinhaNova = true) {
  const sequencia = [];
  const primeiroIndicePorGrupo = [];

  if (!iniciarGrupoEmLinhaNova) {
    let colIndexGlobal = 0;
    grupos.forEach(({ linha, itens }) => {
      primeiroIndicePorGrupo.push(sequencia.length);
      itens.forEach((produto, idx) => {
        sequencia.push({
          tipo: "card", linha, produto, colIndex: colIndexGlobal, colsLinha: COLS_COMPLETO,
          inicioDeGrupo: idx === 0,
        });
        colIndexGlobal = (colIndexGlobal + 1) % COLS_COMPLETO;
      });
    });
    return { sequencia, primeiroIndicePorGrupo };
  }

  grupos.forEach(({ linha, itens }) => {
    primeiroIndicePorGrupo.push(sequencia.length);
    let primeiroCardDoGrupo = true;
    for (let inicio = 0; inicio < itens.length; inicio += COLS_COMPLETO) {
      const leva = itens.slice(inicio, inicio + COLS_COMPLETO);
      leva.forEach((produto, colIndex) => {
        sequencia.push({
          tipo: "card", linha, produto, colIndex, colsLinha: COLS_COMPLETO,
          inicioDeGrupo: primeiroCardDoGrupo && colIndex === 0,
        });
        primeiroCardDoGrupo = false;
      });
      for (let colIndex = leva.length; colIndex < COLS_COMPLETO; colIndex += 1) {
        sequencia.push({ tipo: "cardVazio", linha, colIndex, colsLinha: COLS_COMPLETO });
      }
    }
  });
  return { sequencia, primeiroIndicePorGrupo };
}

// Simula o layout da sequência de blocos (cabeçalhos de marca + cards) na
// grade COLS_COMPLETO×ROWS_POR_PAGINA_COMPLETO, calculando em que página/
// posição (x,y) cada bloco cai — SEM desenhar nada (não recebe `doc` além
// da geometria já calculada). Precisa ser pura/determinística porque roda
// DUAS vezes com o mesmo resultado: uma vez ANTES de desenhar qualquer
// página (só pra descobrir os números de página de cada Linha pro
// índice), e de novo — mesma sequência, mesma geometria — na hora de
// desenhar de verdade (ver gerarPdfCatalogoCompleto). Reaproveita a MESMA
// lógica Y-based que gerarPdfCatalogo já usava pra decidir quebra de
// página (linhaY + altura > areaFimY), só que agora dois tipos de "linha"
// diferentes (cabeçalho de marca, mais baixo, e linha de cards, cardHeight)
// disputam o mesmo espaço, em vez de só um tipo uniforme.
//
// Regras de quebra:
// - Cabeçalho de marca sempre começa numa linha nova da grade — desde a
//   mudança 2026-08-28 (ver _construirSequenciaConteudo), a leva final de
//   cada sub-grupo é completada com blocos "cardVazio" até fechar
//   COLS_COMPLETO colunas, então quando um cabeçalho de marca é
//   desenhado, a linha anterior (de cards reais + vazios) já terminou
//   "cheia" sozinha — não sobra coluna vazia nem precisa de flush de
//   linha incompleta.
// - Controle de "órfão": um cabeçalho de marca só entra numa página se
//   pelo menos 1 linha de cards do sub-grupo couber JUNTO nela — senão os
//   dois (cabeçalho + 1ª linha de cards) vão pra página seguinte, pra não
//   deixar um cabeçalho sozinho colado no rodapé sem nenhum produto
//   embaixo até a próxima página.
function _calcularLayoutConteudo(
  sequencia, geometria, alturaHeaderMarca, forcarQuebraEntreGrupos = false, alturaRodapeReal = FOOTER_HEIGHT
) {
  const { cardWidth, cardHeight, areaTopoY, areaFimY } = geometria;
  // PEDIDO DO USUÁRIO (2026-09-14): "preciso que apenas pegue os produtos
  // da pagina seguinte e coloque na linha da primeira pagina, não toque em
  // tamanhos" — quando uma marca tem cabeçalho (come ~20pt do espaço), só
  // cabem 4 linhas de card dentro de areaFimY (30,349pt padrão do rodapé),
  // e a 5ª linha de produtos REAIS acabava empurrada pra página seguinte
  // em vez de preencher a página atual. `areaFimYLimite` é o teto de
  // segurança de verdade (2pt antes do rodapé de verdade, não o padrão
  // "estético" de 30,349pt) — usado SÓ na decisão de "essa próxima linha
  // ainda cabe aqui?" (abaixo), nunca para calcular cardHeight (que
  // continua vindo 100% de areaFimY/30,349pt — cards não mudam de
  // tamanho). Resultado: a última linha de uma página com cabeçalho pode
  // avançar um pouco além dos 30,349pt (só o suficiente pro que o
  // cabeçalho consumiu), preenchendo com produto de verdade em vez de
  // ficar em branco ou pular pra página de baixo à toa.
  //
  // BUG REAL achado 2026-09-14 (usuário: prints Catálogo Promocional
  // "TERMINAL AXIAL" — "verifique por que arrancou dois cards dali"): esta
  // função é COMPARTILHADA com o Catálogo Promocional
  // (gerarPdfCatalogoPromocional), que usa um rodapé PRÓPRIO, bem mais
  // baixo que `FOOTER_HEIGHT` (o rodapé do Catálogo Completo — cerca do
  // dobro da altura do rodapé do Promocional). Antes, `areaFimYLimite`
  // vinha hardcoded com `FOOTER_HEIGHT` (do Completo) não importa qual
  // catálogo estivesse chamando — pro Promocional isso fazia o "teto de
  // segurança" ficar MENOR que o próprio `areaFimY` (que já vinha correto,
  // calculado a partir do rodapé real e mais baixo do Promocional),
  // invertendo a lógica: em vez de "relaxar" o limite pra caber mais uma
  // linha, ele ficava mais RESTRITIVO — cortava a última linha de cada
  // página (produtos reais) uma linha inteira ANTES do que devia, empurrando
  // 4 produtos reais pra página seguinte, e o espaço vazio que sobrava
  // virava uma linha de `cardVazio` (preenchimentoFinal, que usa a conta
  // certa de `areaFimY`) — os cards "sumiam" da página em que deveriam
  // estar. Fix: `alturaRodapeReal` agora é parâmetro (default
  // `FOOTER_HEIGHT`, mantém o Catálogo Completo idêntico a antes — ele
  // nunca passa esse argumento); `gerarPdfCatalogoPromocional` passa
  // `alturaRodapePromo` (o rodapé de verdade do modo atual), fazendo
  // `areaFimYLimite` refletir o rodapé certo em cada catálogo.
  const areaFimYLimite = A4_ALTURA - alturaRodapeReal - 2;

  // Roda a simulação de paginação inteira UMA vez, recebendo uma função
  // `gapAntesResolver(indiceNaSequencia)` que decide o espaçoAntes de cada
  // bloco "cabecalhoMarca" — extraído numa função interna pra poder rodar
  // 2 passadas (ver comentário logo abaixo de onde isso é chamado).
  // 2026-09-15: o 2º parâmetro (`separadorPermitidoResolver`, decidia se a
  // linha de cardVazio "fechamento de marca" entrava) parou de ser usado
  // aqui dentro — ver comentário grande no branco "cabecalhoMarca" abaixo
  // (pedido do usuário: remover essa linha, ela tomava espaço que dava
  // pra caber mais conteúdo real). Os dois call sites (`passe1`/`passe2`
  // logo abaixo) continuam passando esse argumento — inofensivo, JS
  // ignora argumento extra que a função declarada não usa — não mexi
  // neles pra manter o diff pequeno e não arriscar quebrar a lógica de
  // `indicesComGapDuasMarcas` (que ainda controla o TAMANHO do respiro,
  // só não decide mais sobre linha de cardVazio nenhuma).
  function _rodarPasse(gapAntesResolver) {
    const posicoesPasse = [];
    let paginaPasse = -1;
    let linhaYPasse = areaTopoY;
    // true quando a última linha de cards desenhada ainda não "fechou" (não
    // chegou até colsLinha-1) — ver comentário no fix de 2026-09-01 logo
    // abaixo.
    let linhaEmAbertoPasse = false;
    // 2026-08-28 (pedido "preencha com cards vazios embaixo"): guarda o Y
    // final de CADA página assim que ela é abandonada — usado depois pra
    // calcular quantas linhas de card vazio cabem no espaço que sobrou
    // embaixo de cada página (ver preenchimentoFinal mais abaixo).
    const alturaFinalPorPaginaPasse = [];
    // PEDIDO DO USUÁRIO (2026-09-14, ver comentário completo em
    // _construirSequenciaConteudo sobre por que essa linha saiu de lá):
    // linhas de "fechamento de marca" (1 linha inteira de cardVazio,
    // inserida OPORTUNISTICAMENTE entre um sub-grupo e o próximo, quando os
    // dois caem na MESMA página) — mesma forma de item de preenchimentoFinal
    // (pagina/x/y/cardWidth/cardHeight), só que decidida aqui dentro, linha
    // por linha, porque só dá pra saber se ela cabe depois de simular a
    // página de verdade.
    const separadoresPasse = [];

    function novaPaginaPasse() {
      if (paginaPasse >= 0) alturaFinalPorPaginaPasse[paginaPasse] = linhaYPasse;
      paginaPasse += 1;
      linhaYPasse = areaTopoY;
    }

    sequencia.forEach((bloco, indice) => {
      if (bloco.tipo === "cabecalhoMarca") {
        if (paginaPasse === -1) {
          novaPaginaPasse();
        }
        // 2026-08-28: espaço extra ANTES de um cabeçalho de marca que não é
        // o 1º bloco da página (separa visualmente do sub-grupo anterior) —
        // ver comentário em MARCA_HEADER_GAP_ANTES. Não entra quando o
        // cabeçalho já é o topo da página (logo abaixo do título da Linha),
        // pra não duplicar o respiro que TITULO_GAP_CARDS já garante ali.
        const temConteudoAcima = linhaYPasse > areaTopoY + 0.5;
        // PEDIDO DO USUÁRIO (2026-09-14, prints CABO DE TRANSFERÊNCIA/
        // CORDOALHA + GARRA DE BATERIA/PORTA FUSÍVEL): quando já existe
        // sub-grupo (ou Linha) acima na MESMA página, tenta abrir este
        // cabeçalho com 1 linha INTEIRA de cardVazio antes dele — sinal
        // visual "a marca anterior terminou aqui", mais forte que só o
        // respiro de sempre. Só entra se sobrar espaço pra ela (+ o próprio
        // cabeçalho + 1ª linha de cards da marca nova) SEM empurrar nada
        // pra página seguinte — testado com a MESMA folga de segurança
        // (areaFimYLimite) usada no resto da função. Se não couber, pula a
        // linha vazia (nunca força quebra de página só pra caber o
        // separador) e cai de volta no gapAntesResolver de sempre.
        //
        // PEDIDO DO USUÁRIO (2026-09-14, mesmo dia, ajuste seguinte): "quando
        // couber 3 marcas ou mais não precisa adicionar linha de cards
        // vazias" — com 3+ marcas pequenas numa página (ex.: FORD/GURGEL/+1
        // linha, várias marcas do tipo "1 linha só"), a linha de fechamento
        // em CADA transição comia espaço rápido demais, sem o mesmo ganho
        // visual que tem quando é só uma transição isolada. Escopo igual ao
        // já usado pra MARCA_HEADER_GAP_ANTES_DUAS_MARCAS (`indicesComGapDuasMarcas`,
        // calculado a partir da 1ª passada, "quantas marcas caem NESTA
        // PÁGINA de verdade"): `separadorPermitidoResolver(indice)` só
        // retorna true pra cabeçalhos de página com EXATAMENTE 2 marcas. Com
        // 3+ marcas compartilhando a página, essa função sempre nega e o
        // fluxo cai direto no gapAntesResolver (respiro normal de 18pt,
        // nenhuma linha vazia extra) — mesmo comportamento de antes desse
        // recurso existir.
        //
        // PEDIDO DO USUÁRIO (2026-09-15, print circulado FUSÍVEL/GARRA DE
        // BATERIA — "a ideia é caber na mesma pagina sempre que tiver duas
        // marcas com apenas duas linhas de produtos... os dois poderia
        // caber em uma pagina se remover essa linha de card vazio"):
        // reconsiderou a linha de fechamento pedida em 2026-09-14 (acima).
        // Ela só entrava quando "sobrava espaço de graça" pra ela SEM
        // empurrar a marca nova pra página seguinte — mas esse mesmo
        // espaço, se não virasse linha de cardVazio, ficaria disponível
        // pra MAIS conteúdo real (mais uma linha da marca nova, ou até uma
        // 3ª marca/Linha inteira, como no print: sobrava exatamente 1
        // linha de altura que a linha de fechamento consumia à toa).
        // Desligado: a separação visual entre marcas continua existindo
        // (gapAntesResolver abaixo ainda dá um respiro maior, via
        // MARCA_HEADER_GAP_ANTES_DUAS_MARCAS/indicesComGapDuasMarcas,
        // quando só 2 marcas compartilham a página) — só a linha INTEIRA
        // de cards vazios (que ocupava uma leva de espaço de verdade) foi
        // removida. `separadoresPasse`/`separadorPermitidoResolver`
        // ficaram sem uso (sempre vazio agora) — não removidos do código
        // pra não mexer no formato de retorno de `_rodarPasse`/
        // preenchimentoFinal que outras partes da função esperam.
        let espacoAntes = 0;
        if (temConteudoAcima) {
          espacoAntes = gapAntesResolver(indice);
        }
        if (linhaYPasse + espacoAntes + alturaHeaderMarca + MARCA_HEADER_GAP_DEPOIS + cardHeight > areaFimYLimite + 0.5) {
          novaPaginaPasse();
        } else {
          linhaYPasse += espacoAntes;
        }
        posicoesPasse.push({ pagina: paginaPasse, x: PAGE_MARGIN, y: linhaYPasse });
        linhaYPasse += alturaHeaderMarca + MARCA_HEADER_GAP_DEPOIS;
      } else {
        // "card" (produto real) e "cardVazio" (placeholder de preenchimento,
        // ver _construirSequenciaConteudo) usam a MESMA largura fixa da
        // geometria — só a largura da COLUNA muda entre eles (nenhuma, o
        // grid inteiro é sempre COLS_COMPLETO colunas iguais).
        //
        // 2026-08-28 (pedido "repita a subcategoria para evitar se
        // perder"): uma quebra de página no meio de um sub-grupo só pode
        // acontecer aqui (colIndex===0 de uma linha que não coube) — a 1ª
        // linha de cada sub-grupo já é protegida junto com seu cabeçalho
        // pela regra de órfão acima, então se ESTA quebra específica
        // acontecer, é sempre uma CONTINUAÇÃO do sub-grupo (nunca a 1ª
        // linha dele). Nesse caso, reserva espaço pra repetir o cabeçalho
        // da marca no topo da nova página antes da linha de cards — sem
        // isso o cliente vira a página e perde a referência de qual marca
        // está olhando.
        let headerRepetidoY = null;
        if (bloco.colIndex === 0) {
          if (paginaPasse === -1) {
            novaPaginaPasse();
          } else if (linhaYPasse + cardHeight > areaFimYLimite + 0.5) {
            novaPaginaPasse();
            // BUG REAL achado 2026-09-01 (Catálogo Promocional, modo
            // "fabricante" — usuário reportou "sobra parte branca no fim da
            // página, sempre preencha"): esta função é COMPARTILHADA com o
            // Catálogo Completo, que TEM sub-agrupamento por marca de
            // veículo (alturaHeaderMarca > 0, repete o cabeçalho da marca no
            // topo da página nova). O Catálogo Promocional NÃO tem esse
            // sub-agrupamento (chama com alturaHeaderMarca=0 — ver
            // gerarPdfCatalogoPromocional), mas o código reservava o espaço
            // MARCA_HEADER_GAP_DEPOIS (6pt) de qualquer jeito, mesmo sem
            // cabeçalho nenhum pra desenhar ali — 6pt perdidos no topo de
            // TODA página de continuação. Como cardHeight é calculado pra
            // caber ROWS_POR_PAGINA_COMPLETO linhas EXATAS sem folga nenhuma
            // (ver _geometriaGrid), esses 6pt bastavam pra empurrar a
            // verificação "cabe mais 1 linha?" (aqui e em preenchimentoFinal
            // logo abaixo) pro lado errado — a grade sempre "perdia" a
            // última linha da página, tanto de produto real quanto de
            // preenchimento, ficando em branco. Fix: só reserva o espaço (e
            // marca headerRepetidoY) quando existe de fato um cabeçalho de
            // marca pra repetir.
            if (alturaHeaderMarca > 0) {
              headerRepetidoY = linhaYPasse;
              linhaYPasse += alturaHeaderMarca + MARCA_HEADER_GAP_DEPOIS;
            }
          } else if (forcarQuebraEntreGrupos && bloco.inicioDeGrupo && linhaYPasse > areaTopoY + 0.5) {
            // Modo "fabricante" (ver comentário em _construirSequenciaConteudoPromocional):
            // mesmo cabendo na página atual, um novo grupo (fabricante) força
            // página nova se já tem conteúdo de OUTRO grupo acima — o
            // cabeçalho da página precisa sempre corresponder a TODOS os
            // cards que aparecem nela.
            novaPaginaPasse();
          }
        }
        const x = PAGE_MARGIN + bloco.colIndex * (cardWidth + GAP);
        posicoesPasse.push({
          pagina: paginaPasse, x, y: linhaYPasse,
          headerRepetidoY,
          headerRepetidoMarca: headerRepetidoY !== null ? bloco.marca : null,
        });
        if (bloco.colIndex === bloco.colsLinha - 1) {
          linhaYPasse += cardHeight + GAP;
          linhaEmAbertoPasse = false;
        } else {
          linhaEmAbertoPasse = true;
        }
      }
    });

    // A última página não passa por novaPaginaPasse() de novo (não tem
    // próximo bloco pra disparar a troca) — grava o Y final dela aqui, fora
    // do loop.
    //
    // BUG REAL corrigido 2026-09-01 (Catálogo Promocional modo "linha",
    // depois da mudança "fluxo contínuo entre grupos" — ver
    // _construirSequenciaConteudoPromocional): `linhaY` só avança quando o
    // ÚLTIMO bloco de uma linha da grade é desenhado (colIndex===colsLinha-1,
    // acima). Antes da mudança de fluxo contínuo, a sequência sempre incluía
    // blocos "cardVazio" explícitos preenchendo o resto de CADA linha, então
    // a última linha do documento sempre acabava fechada. Com o fluxo
    // contínuo, a última linha pode terminar com um item real "solto" numa
    // coluna que não é a última (ex: 1 produto sozinho na coluna 0) — nesse
    // caso `linhaY` nunca avançava, e o preenchimentoFinal (calculado a
    // seguir a partir de `alturaFinalPorPagina`) desenhava uma linha inteira
    // de cardVazio EXATAMENTE por cima dessa última linha real, escondendo o
    // produto (reportado pelo usuário como "card sumiu"/"pulou card"). Fix:
    // se a última linha ficou "em aberto" (teve conteúdo mas não fechou),
    // avança linhaY mais uma vez antes de gravar a altura final da página.
    if (linhaEmAbertoPasse) linhaYPasse += cardHeight + GAP;
    if (paginaPasse >= 0) alturaFinalPorPaginaPasse[paginaPasse] = linhaYPasse;

    return { posicoesPasse, alturaFinalPorPaginaPasse, separadoresPasse };
  }

  // 1ª passada: espaçamento padrão em TODO cabeçalho — só pra descobrir em
  // que página cada bloco cai de verdade. A decisão "este cabeçalho é 1 de
  // EXATAMENTE 2 marcas que compartilham a mesma página" só pode ser
  // respondida DEPOIS de saber a paginação (e a paginação, por sua vez,
  // depende do espaçoAntes usado — por isso 2 passadas em vez de 1).
  // separadorPermitidoResolver=() => false: a 1ª passada nunca tenta a linha
  // de fechamento — ela existe só pra descobrir, com o layout "de sempre"
  // (sem separador nenhum), quantas marcas caem naturalmente em cada
  // página. Se ela já tentasse inserir separador aqui, a contagem de
  // "quantas marcas cabem nesta página" ficaria distorcida pelo próprio
  // separador (galinha e ovo) — ver `indicesComGapDuasMarcas` abaixo.
  const passe1 = _rodarPasse(() => MARCA_HEADER_GAP_ANTES, () => false);
  const cabecalhosPorPaginaPasse1 = {};
  sequencia.forEach((bloco, indice) => {
    if (bloco.tipo === "cabecalhoMarca") {
      const p = passe1.posicoesPasse[indice].pagina;
      if (!cabecalhosPorPaginaPasse1[p]) cabecalhosPorPaginaPasse1[p] = [];
      cabecalhosPorPaginaPasse1[p].push(indice);
    }
  });
  const indicesComGapDuasMarcas = new Set();
  Object.values(cabecalhosPorPaginaPasse1).forEach((indices) => {
    if (indices.length === 2) indices.forEach((i) => indicesComGapDuasMarcas.add(i));
  });

  // 2ª passada (a que vale de verdade): mesmo cálculo, agora usando o gap
  // maior só nos cabeçalhos identificados acima.
  //
  // BUG REAL achado 2026-09-14 (usuário: "aumentei pra 100 e não vi
  // diferença"): a 1ª versão media "quantidade de marcas na LINHA inteira"
  // (`totalMarcasNaLinha`, calculado em _construirSequenciaConteudo) — mas
  // uma Linha como "FUSÍVEL" tem DEZENAS de marcas espalhadas por várias
  // páginas (FORD, GM, TOYOTA, FIAT, MASSEY FERGUSON, MAZDA, UNIVERSAL/
  // DIVERSOS...), então totalMarcasNaLinha quase nunca dava EXATAMENTE 2 —
  // o gap maior nunca era de fato usado, não importa o valor da constante.
  // O que interessa é "quantas marcas caem NESTA PÁGINA especificamente"
  // (coincidência de quanto espaço sobra, não uma propriedade da Linha),
  // só descoberto depois de rodar a paginação — daí o esquema de 2
  // passadas acima em vez do campo `totalMarcasNaLinha` no bloco.
  // PEDIDO DO USUÁRIO (2026-09-14): "quando couber 3 marcas ou mais não
  // precisa adicionar linha de cards vazias" — reaproveita EXATAMENTE o
  // mesmo `indicesComGapDuasMarcas` de cima (página com EXATAMENTE 2
  // marcas) pra também decidir se a linha de fechamento entra ou não, não
  // só o tamanho do gap.
  const passe2 = _rodarPasse(
    (indice) => (indicesComGapDuasMarcas.has(indice) ? MARCA_HEADER_GAP_ANTES_DUAS_MARCAS : MARCA_HEADER_GAP_ANTES),
    (indice) => indicesComGapDuasMarcas.has(indice)
  );
  const posicoes = passe2.posicoesPasse;
  const alturaFinalPorPagina = passe2.alturaFinalPorPaginaPasse;

  // PEDIDO DO USUÁRIO (2026-09-15): "investigue por que está cortando
  // cards, preciso que isso não aconteça" — reproduzido ao vivo com um
  // catálogo real (grupo "KIT DO AMORTECEDOR", 32 produtos): nenhum produto
  // estava de fato sendo perdido (os 32 sempre entram no PDF, confirmado
  // batendo cada código contra o X2), mas no fluxo CONTÍNUO do Catálogo
  // Promocional modo "linha" (só ocorre quando alturaHeaderMarca===0 E
  // forcarQuebraEntreGrupos===false — a única combinação usada por
  // gerarPdfCatalogoPromocional(modo="linha"); Catálogo Completo sempre tem
  // cabeçalho de marca, modo "fabricante" sempre força quebra — nenhum dos
  // dois entra aqui), quando o total de cards reais não fecha múltiplo
  // exato de COLS_COMPLETO×ROWS_POR_PAGINA_COMPLETO (20), a ÚLTIMA página
  // do documento podia sobrar com só 1-3 cards reais "órfãos" (ex.: 32
  // itens = 20 numa página + 1 sozinho na página seguinte, quase toda em
  // branco) enquanto a penúltima ia até o fim. Card nenhum overrode:
  // linhaEmAbertoPasse (acima) já garante que a linha órfã nunca fica
  // escondida atrás de cardVazio — o card real sempre desenha. O problema
  // era só visual (página quase vazia parecendo card "cortado"). Fix:
  // rebalanceia as DUAS ÚLTIMAS páginas do fluxo pra dividir os cards reais
  // dessas duas de forma mais uniforme (32 → 20+12 vira 16+16, por
  // exemplo) — só quando a última página não fecha nem 1 linha inteira
  // (< COLS_COMPLETO cards reais), senão deixa como está (várias linhas
  // parciais já parecem uma página normal, não precisa mexer).
  if (alturaHeaderMarca === 0 && !forcarQuebraEntreGrupos) {
    const totalPaginasAtual = alturaFinalPorPagina.length;
    if (totalPaginasAtual >= 2) {
      const capacidadePagina = COLS_COMPLETO * ROWS_POR_PAGINA_COMPLETO;
      const ultimaPagina = totalPaginasAtual - 1;
      const indicesPenultima = [];
      const indicesUltima = [];
      sequencia.forEach((_, i) => {
        if (posicoes[i].pagina === ultimaPagina - 1) indicesPenultima.push(i);
        else if (posicoes[i].pagina === ultimaPagina) indicesUltima.push(i);
      });
      if (
        indicesUltima.length > 0 &&
        indicesUltima.length < COLS_COMPLETO &&
        indicesPenultima.length === capacidadePagina
      ) {
        const penultimaPagina = ultimaPagina - 1;
        const totalCauda = indicesPenultima.length + indicesUltima.length;
        const novoTamanhoPenultima = Math.ceil(totalCauda / 2);
        [...indicesPenultima, ...indicesUltima].forEach((idxSeq, posNaCauda) => {
          const naPenultima = posNaCauda < novoTamanhoPenultima;
          const posicaoNaPagina = naPenultima ? posNaCauda : posNaCauda - novoTamanhoPenultima;
          const row = Math.floor(posicaoNaPagina / COLS_COMPLETO);
          const col = posicaoNaPagina % COLS_COMPLETO;
          posicoes[idxSeq] = {
            pagina: naPenultima ? penultimaPagina : ultimaPagina,
            x: PAGE_MARGIN + col * (cardWidth + GAP),
            y: areaTopoY + row * (cardHeight + GAP),
            headerRepetidoY: null,
            headerRepetidoMarca: null,
          };
        });
        alturaFinalPorPagina[penultimaPagina] =
          areaTopoY + Math.ceil(novoTamanhoPenultima / COLS_COMPLETO) * (cardHeight + GAP);
        alturaFinalPorPagina[ultimaPagina] =
          areaTopoY + Math.ceil((totalCauda - novoTamanhoPenultima) / COLS_COMPLETO) * (cardHeight + GAP);
      }
    }
  }

  // PEDIDO DO USUÁRIO (2026-09-14): linhas de "fechamento de marca"
  // decididas dentro de _rodarPasse (ver separadoresPasse ali) — mesma
  // forma de item que preenchimentoFinal (pagina/x/y/cardWidth/cardHeight),
  // por isso entram na MESMA lista final, desenhadas pela mesma
  // _desenharPreenchimentoDaPagina sem precisar de nenhum código novo nos
  // pontos de chamada (gerarPdfCatalogoCompleto/Promocional).
  const separadoresMarca = passe2.separadoresPasse;

  // 2026-08-28 (pedido "preencha com cards vazios embaixo"): pra cada
  // página, se sobrou espaço suficiente pra pelo menos mais 1 linha
  // inteira de cards depois do último conteúdo real (isso só acontece em
  // duas situações — a ÚLTIMA página do documento, que simplesmente
  // acaba o conteúdo antes de encher a grade, ou uma página no MEIO que
  // perdeu a última linha pra regra de órfão do cabeçalho de marca),
  // preenche com linhas inteiras de "cardVazio" até não caber mais
  // nenhuma linha completa — mesmo placeholder já usado pra completar
  // leva parcial (ver _desenharCardVazio), só que aqui cobrindo a página
  // toda em vez de só uma leva.
  // BUG REAL achado 2026-09-14 (usuário: prints "PARAFUSO TIRANTE"/"PLACA
  // RETIFICADORA" e "GARRA DE BATERIA"/"PORTA FUSÍVEL" — 2 linhas vazias
  // empilhadas em vez de 1): quando um sub-grupo pequeno já fecha sua
  // própria leva com cardVazio (ex: 2 produtos reais + 2 vazios pra
  // completar a linha), a linha de fechamento abaixo (o bloco while +
  // guarda de segurança logo adiante) via de qualquer jeito, mesmo o
  // "resto" já tendo sido gerado por dentro do grupo — resultado: uma
  // linha vazia DENTRO do grupo + outra linha vazia INTEIRA logo depois,
  // parecendo duplicado/bugado. Fix: descobre se o ÚLTIMO bloco de cada
  // página já é "cardVazio" (ou seja, a última linha real já fechou
  // incompleta) — se sim, essa linha incompleta JÁ é o fechamento do
  // grupo, não faz sentido colar mais uma linha cheia de vazios embaixo.
  //
  // 2026-09-15: `ultimoTipoPorPagina` (o mapa que esse guard usava) foi
  // REMOVIDO — ver comentário completo no loop `alturaFinalPorPagina.forEach`
  // mais abaixo, onde o guard correspondente também saiu. Motivo: o guard
  // impedia exatamente as páginas com fechamento incompleto de receber a
  // padronização de distância até o rodapé pedida pelo usuário depois
  // (2026-09-14/15). Deixei este comentário histórico porque explica POR
  // QUE esse padrão existia antes (evitar 2 linhas vazias empilhadas
  // parecendo bugadas) — só não vale mais como comportamento atual.

  const preenchimentoFinal = [...separadoresMarca];

  // PEDIDO DO USUÁRIO (2026-09-15, print com círculo vermelho): mesmo
  // depois do rebalanceamento das 2 últimas páginas (fix logo acima), a
  // ÚLTIMA LINHA de conteúdo real de uma página, quando fecha incompleta
  // (nem todas as COLS_COMPLETO colunas têm produto — ex.: linha com só
  // MB4194/MB4178 nas colunas 0-1, faltando 2-3), ficava com as colunas
  // restantes em branco SEM BORDA nenhuma — só as linhas de preenchimento
  // SEGUINTES (a próxima linha pra baixo em diante, via o loop
  // `alturaFinalPorPagina.forEach` logo abaixo) ganhavam o cardVazio com
  // borda. O rebalanceamento tornou isso bem mais visível: a página final
  // agora quase sempre termina com uma linha real incompleta ANTES das
  // linhas 100% vazias, então o buraco sem borda ficava bem no meio da
  // página, do lado de cards de verdade — parecia produto sumido (não
  // era: os cards vazios de baixo, com borda, já mostravam que o resto é
  // preenchimento proposital; só faltava a MESMA borda nessa linha
  // específica). 2026-09-15 (mesmo dia, print circulado da seção
  // FUSÍVEL/HYUNDAI-KIA no Catálogo COMPLETO — "essa pagina hyundai está
  // com todos os produtos... porem não completou com os cards em baixo
  // como solicitei"): o MESMO sintoma acontece no Catálogo Completo
  // também (sub-grupo KIA com 7 produtos — 4+3, confirmado batendo
  // contra o catálogo real, nenhum produto faltando — a leva final de 3
  // deveria fechar com 1 cardVazio na 4ª coluna, igual qualquer outra
  // leva incompleta, mas quando essa leva é o ÚLTIMO conteúdo da página
  // o cardVazio correspondente não aparece com borda). Não achei uma
  // causa raiz determinística lendo o código sozinho (sem conseguir
  // rodar/depurar de verdade — bash indisponível a sessão toda); em vez
  // de deixar só o modo Promocional "linha" coberto, generalizei este
  // fix pra QUALQUER página de QUALQUER modo (removido o guard
  // `alturaHeaderMarca===0 && !forcarQuebraEntreGrupos` que tinha antes):
  // descobre, por página, a linha (mesmo Y, tolerância de arredondamento)
  // que contém o ÚLTIMO bloco tipo "card" (produto real — nunca
  // "cabecalhoMarca", que não ocupa coluna da grade), calcula as colunas
  // ocupadas a partir da posição X final de cada card e completa com
  // cardVazio as colunas que sobraram nessa MESMA linha. Seguro mesmo
  // quando a leva já tinha um cardVazio próprio ali (caso normal, fora
  // desse bug): a coluna já apareceria "ocupada" seja pela leitura do
  // texto (cards reais) seja simplesmente por não sobrar overlap real —
  // na pior hipótese redesenha um cardVazio idêntico por cima de outro
  // já correto, sem efeito visual (mesma borda, mesma posição).
  {
    const itensPorPagina = {};
    sequencia.forEach((bloco, i) => {
      if (bloco.tipo !== "card") return;
      const p = posicoes[i].pagina;
      const col = Math.round((posicoes[i].x - PAGE_MARGIN) / (cardWidth + GAP));
      (itensPorPagina[p] = itensPorPagina[p] || []).push({ y: posicoes[i].y, col });
    });
    Object.entries(itensPorPagina).forEach(([pStr, itens]) => {
      const p = Number(pStr);
      const yUltimaLinha = Math.max(...itens.map((it) => it.y));
      const colsUsadas = new Set(
        itens.filter((it) => Math.abs(it.y - yUltimaLinha) < 0.5).map((it) => it.col)
      );
      for (let col = 0; col < COLS_COMPLETO; col += 1) {
        if (!colsUsadas.has(col)) {
          preenchimentoFinal.push({
            pagina: p, x: PAGE_MARGIN + col * (cardWidth + GAP), y: yUltimaLinha, cardWidth, cardHeight,
          });
        }
      }
    });
  }

  // 2026-09-14: cheguei a testar uma linha extra de preenchimento com
  // altura parcial (menor que cardHeight) pra fechar o resto que sobra
  // antes do rodapé quando header+linhas não fecham múltiplo exato de
  // cardHeight — usuário pediu pra remover de forma genérica ("lembra
  // desses cards minúsculos... preciso que remova-os"), mas depois pediu
  // de volta pra "quando apenas couber uma marca na página" (ex: FIAT/
  // FUSÍVEL com só 1 marca, 4 linhas fechadas + resto grande em branco
  // antes do rodapé), e por fim pediu que a MESMA distância padronizada
  // valesse pra QUALQUER página (2026-09-14, print MASSEY FERGUSON/MAZDA:
  // "fique como a distancia dos ultimos cards até o rodape como em
  // paginas de uma marca só"). Escopo original AQUI (ver ultimoTipoPorPagina
  // acima): só entrava quando a última linha real da página fechou CHEIA
  // (sem cardVazio) — se já tinha fechado incompleta, a linha incompleta era
  // tratada como "o fechamento do grupo", sem mais nenhuma linha vazia
  // embaixo dela.
  //
  // BUG REAL achado 2026-09-15 (usuário, print FUSÍVEL/FORD+GM página 8 +
  // confirmação "ainda não acontece com todas as paginas em todos os
  // fluxos" DEPOIS de reiniciar o container): esse guard fazia exatamente
  // as páginas que MAIS precisavam de padronização (aquelas cuja última
  // linha real fechou incompleta — ex.: sub-grupo pequeno de 2-3 produtos)
  // ficarem de FORA da padronização. `alturaFinalPorPagina[p]` já é o Y
  // seguinte à última linha desenhada (real OU cardVazio de fechamento —
  // ver `linhaYPasse` em `_rodarPasse`, sempre avança depois de qualquer
  // linha fechar, nunca fica "por cima" do conteúdo já posicionado), então
  // não há risco de sobrepor cards reais ao continuar preenchendo a partir
  // daqui. O guard removido evitava um efeito colateral cosmético
  // específico (2026-09-14, "PARAFUSO TIRANTE"/"GARRA DE BATERIA": duas
  // linhas vazias empilhadas pareciam duplicadas) — mas isso só acontecia
  // quando sobrava pouquíssimo espaço (praticamente 1 linha extra). Entre
  // esse efeito cosmético raro e a página inteira não bater com a
  // distância padronizada pedida (pedido mais recente e reafirmado depois
  // do restart), prevalece a padronização: toda página agora preenche até
  // areaFimY independente de como a última linha real fechou.
  alturaFinalPorPagina.forEach((yFinal, p) => {
    let y = yFinal;
    while (y + cardHeight <= areaFimY + 0.5) {
      for (let col = 0; col < COLS_COMPLETO; col += 1) {
        preenchimentoFinal.push({ pagina: p, x: PAGE_MARGIN + col * (cardWidth + GAP), y, cardWidth, cardHeight });
      }
      y += cardHeight + GAP;
    }
    // PEDIDO DO USUÁRIO (2026-09-14): "não diminua os cards deixe mesmo
    // tamanho" — a linha final aqui usa a MESMA cardHeight de todo o
    // resto do grid (não mais a altura reduzida "sobra"). Isso empurra o
    // fim dessa linha um pouco além de areaFimY (exatamente o quanto o
    // cabeçalho de marca comeu do espaço, tipicamente ~20pt — sempre bem
    // menos que os 30,349pt padrão), reduzindo o espaço até o rodapé
    // nessas páginas específicas em vez de encolher qualquer card. Guarda
    // de segurança: só desenha se ainda sobrar pelo menos 2pt antes do
    // rodapé de verdade (A4_ALTURA - alturaRodapeReal) — nunca desenha por
    // cima do rodapé.
    // 2026-09-22 BUG REAL achado ao ajustar o espaçamento do estilo
    // mecânica (Issue #377): esta guarda usava FOOTER_HEIGHT (fixo, o
    // rodapé bem mais alto da elétrica) direto, ignorando o parâmetro
    // `alturaRodapeReal` que o resto da função já recebe — pro estilo
    // mecânica (rodapé mais baixo, MECANICA_RODAPE_ALTURA) isso fazia a
    // ÚLTIMA linha de cards vazios de preenchimento (a que fecha a página
    // até areaFimY) ser descartada por engano, sumindo com a borda/moldura
    // da última linha inteira (regressão visual introduzida pelo próprio
    // ajuste de espaçamento — pego ao comparar a amostra antes/depois).
    if (y + cardHeight <= A4_ALTURA - alturaRodapeReal - 2) {
      for (let col = 0; col < COLS_COMPLETO; col += 1) {
        preenchimentoFinal.push({ pagina: p, x: PAGE_MARGIN + col * (cardWidth + GAP), y, cardWidth, cardHeight });
      }
    }
  });

  // BUG REAL achado 2026-09-14 (usuário: "erro ao gerar pdf do catalogo"):
  // depois do refactor pra 2 passadas (ver _rodarPasse acima), a variável
  // `pagina` do código antigo deixou de existir aqui fora (virou local
  // `paginaPasse`, escopada dentro de _rodarPasse) — este `return` ainda
  // referenciava ela direto, quebrando com "pagina is not defined" toda
  // vez que a função rodava. Fix: `alturaFinalPorPagina.length` já é
  // exatamente a contagem de páginas (um índice preenchido por página,
  // 0 a N-1 — mesmo valor que "pagina + 1" dava antes).
  return { posicoes, totalPaginas: alturaFinalPorPagina.length, preenchimentoFinal };
}

// Nome da marca de veículo centralizado, cor/fonte do título de Linha —
// ver comentário em MARCA_HEADER_FONTE sobre a troca da faixa azul sólida
// por este estilo (a divisória/hr que existia abaixo foi removida depois,
// ver _desenharCabecalhoMarca). `_alturaCabecalhoMarca` calcula a altura
// fixa (só a linha de texto, no fontSize do cabeçalho) UMA vez,
// reaproveitada tanto no cálculo de layout quanto no desenho de verdade —
// mesmo padrão de _alturaSelo logo acima.
function _alturaCabecalhoMarca(doc) {
  doc.font(TITULO_FONTE).fontSize(MARCA_HEADER_FONTE);
  return doc.currentLineHeight();
}

// `alinhamento` (pedido do usuário, 2026-09-05): "center" de sempre pro
// cabeçalho de marca normal; "left" só quando esse bloco também está
// anunciando o INÍCIO de uma Linha nova no meio da página (sem quebra de
// página — ver trocouDeLinhaSemTitulo/gerarPdfCatalogoCompleto) — alinhado
// à esquerda, no canto superior, pra ficar mais parecido com o título
// grande de página (que é sempre alinhado à esquerda), sem aumentar o
// fontSize (MARCA_HEADER_FONTE já cabe exatamente na altura reservada,
// ver _alturaCabecalhoMarca — usar o tamanho do título grande aqui
// arriscaria sobrepor a foto dos cards logo abaixo, calculados assumindo
// essa altura menor).
function _desenharCabecalhoMarca(doc, marca, x, y, largura, altura, alinhamento = "center") {
  doc.font(TITULO_FONTE).fontSize(MARCA_HEADER_FONTE);
  _textoComSombra(doc, String(marca || "").toUpperCase(), x, y, VERMELHO_CATEGORIA, {
    width: largura,
    align: alinhamento,
    lineBreak: false,
  });

  // 2026-08-28: pedido do usuário "retire esse hr abaixo da subcategoria"
  // — a divisória fina que separava o cabeçalho de marca da 1ª linha de
  // cards foi removida; `altura` continua reservando o mesmo respiro
  // vertical (ver _alturaCabecalhoMarca), só não desenha mais o traço.
  doc.fillColor("#111827").font("Helvetica");
}

// Efeito de sombra (pedido do usuário, 2026-08-26: "aplique esse efeito de
// sombra em todos os textos") — cópia do texto em preto translúcido,
// deslocada +1.5pt/+1.5pt, desenhada por baixo do texto principal. Era só
// do título "ÍNDICE"; virou helper reaproveitado por TODOS os textos da
// página de índice (título, nome da Linha, "PG" e número) pra não repetir
// esse par de chamadas 4x. Assume que doc.font()/fontSize() já foram
// setados pelo chamador — a sombra usa a mesma fonte/tamanho do principal.
function _textoComSombra(doc, texto, x, y, cor, opcoes) {
  doc.fillColor("#000000", 0.35).text(texto, x + 1.5, y + 1.5, opcoes);
  doc.fillOpacity(1);
  doc.fillColor(cor).text(texto, x, y, opcoes);
}

// 2026-09-11 (pedido do usuário, comparação direta com o catálogo original
// 3RHOcompactado.pdf enviado por ele): no original, o título de cada seção
// e cada nome de Linha no ÍNDICE têm uma cópia "fantasma" do MESMO texto —
// bem mais clara, não itálica, ligeiramente maior — desenhada ATRÁS,
// deslocada pra CIMA E PRA ESQUERDA do texto colorido principal (efeito de
// "eco"/marca d'água). É um efeito BEM mais forte que o _textoComSombra
// normal (sombra escura sutil, deslocada pra baixo/direita) — os dois
// convivem: o eco fica atrás de tudo, a sombra normal continua entre o eco
// e o texto principal.
// 2026-09-11 (correção, usuário mandou 2 prints com guias de medição
// mostrando que a 1ª tentativa "tava muito diferente"): a 1ª versão media
// só o PDF original comprimido (200dpi) e concluiu, por causa da largura
// quase idêntica entre eco e texto principal, que a fonte do eco seria
// reta/não itálica (por isso usava Helvetica-Bold) — ficou errado. Os 2
// prints com guias mostraram, medidos com precisão: largura do eco e do
// texto principal são PRATICAMENTE IDÊNTICAS (542px vs 541px numa amostra,
// diferença de 1px) e o deslocamento vertical topo-a-topo é bem maior
// proporcionalmente (~85% da altura do texto principal, não os ~53% que a
// 1ª versão usava) — ou seja, o eco é a MESMA fonte/tamanho do texto
// principal (Futura Md BT Bold Italic, TITULO_FONTE), só cinza-claro e
// deslocado bem mais pra cima (quase uma 2ª linha separada, tocando de
// leve no topo da linha vermelha) — não uma fonte reta diferente e maior.
// Confirmado renderizando com a fonte real do projeto e comparando lado a
// lado com os prints de referência antes de gravar esta versão.
// Usado SÓ nos 3 lugares em que o catálogo original realmente tem esse
// efeito — título de seção (_desenharCabecalho, estilo "elétrica"), título
// "ÍNDICE" e nome de Linha em cada linha do índice (_desenharLinhaIndice).
// NÃO usado no cabeçalho de marca (_desenharCabecalhoMarca — sub-
// agrupamento por marca é invenção nossa, não existe no catálogo original)
// nem no bloco "PG nn" do índice (o original não tem eco ali).
const ECO_TITULO_COR = "#dcdcdc";
const ECO_TITULO_OFFSET_X = -6;
const ECO_TITULO_OFFSET_Y = -10;
function _textoComEco(doc, texto, x, y, cor, opcoes, tamanhoFonte) {
  doc.font(TITULO_FONTE).fontSize(tamanhoFonte);
  doc.fillColor(ECO_TITULO_COR).text(texto, x + ECO_TITULO_OFFSET_X, y + ECO_TITULO_OFFSET_Y, opcoes);
  doc.fillOpacity(1);
  doc.font(TITULO_FONTE).fontSize(tamanhoFonte);
  _textoComSombra(doc, texto, x, y, cor, opcoes);
}

// Cabeçalho da(s) página(s) de índice — mesma arte de _desenharCabecalho,
// só com o título fixo "ÍNDICE" em INDICE_TITULO_TAMANHO (36pt, pedido do
// usuário) em vez do nome da busca em TITULO_TAMANHO (17pt).
function _desenharCabecalhoIndice(doc, estilo = "eletrica", fabricante = "") {
  const w = doc.page.width;

  // Pedido do usuário (2026-09-04, "Mecânica.pdf"): página de índice
  // Mecânica também usa a logo do fabricante + linha fina navy (mesma
  // _desenharLogoCabecalhoMecanica das páginas de conteúdo), sobre o
  // fundo em degradê — sem a barra de título navy (não tem "Linha" numa
  // página de índice, ver Sumário Mecânica.png de referência: só logo +
  // linha fina antes do "ÍNDICE").
  if (estilo === "mecanica") {
    _desenharLogoCabecalhoMecanica(doc, fabricante);
  } else {
    // 2026-08-28 (revertido — pedido do usuário "padronize o cabeçalho da
    // primeira pagina com o restante"): era desenhada AMPLIADA (zoom 1.08x +
    // corte simétrico nas laterais), ficando ligeiramente diferente do
    // cabeçalho das páginas de conteúdo. Agora usa exatamente a mesma
    // largura/altura/posição de _desenharCabecalho — mesma arte, mesmo zoom
    // de bleed horizontal (ver CABECALHO_ESCALA_BLEED), sem corte — só o
    // texto abaixo dela muda ("ÍNDICE" em vez do nome da busca, ver mais
    // abaixo).
    doc.image(CABECALHO_IMG, CABECALHO_IMG_X_DESENHO, -CABECALHO_SANGRIA_TOPO, { width: CABECALHO_IMG_LARGURA_DESENHO, height: CABECALHO_IMG_ALTURA_REAL });
  }

  const tituloTexto = "ÍNDICE";
  const tituloX = PAGE_MARGIN;
  // Pedido do usuário (2026-08-26): respiro maior entre o cabeçalho e o
  // título "ÍNDICE" — INDICE_TITULO_GAP_TOPO em vez do TITULO_GAP_TOPO
  // compartilhado (8pt) usado no resto do PDF.
  // 2026-09-22: estilo mecânica usa MECANICA_HEADER_HEIGHT em vez de
  // INDICE_HEADER_HEIGHT (= HEADER_HEIGHT, arte da elétrica) — mesmo motivo
  // do tituloY em _desenharCabecalho.
  const tituloY = (estilo === "mecanica" ? MECANICA_HEADER_HEIGHT : INDICE_HEADER_HEIGHT) + INDICE_TITULO_GAP_TOPO;
  const tituloLargura = w - PAGE_MARGIN * 2;

  // Pedido do usuário (2026-08-26): título "ÍNDICE" centralizado na página
  // (só ele — o resto do cabeçalho/linhas do índice continua como estava).
  // 2026-09-11: eco atrás do título (ver _textoComEco), igual ao catálogo
  // original.
  _textoComEco(doc, tituloTexto, tituloX, tituloY, VERMELHO_CATEGORIA, { width: tituloLargura, align: "center" }, INDICE_TITULO_TAMANHO);

  doc.fillColor("#111827").font("Helvetica");
}

// Desenha uma linha do índice: nome da Linha (vermelho, Futura itálico,
// 17pt) à esquerda, líder pontilhado, e bloco "PG nn" (azul) à direita —
// estrutura confirmada pelos dois prints com guias de medição que o usuário
// mandou. `larguraTotal` é a largura útil da página (sem as margens).
function _desenharLinhaIndice(doc, textoLinha, numeroPagina, y, larguraTotal) {
  const xEsquerda = PAGE_MARGIN;
  const larguraBlocoPg = 70; // reserva fixa pro bloco "PG nn" à direita
  const xBlocoPg = xEsquerda + larguraTotal - larguraBlocoPg;
  const larguraNomeMax = xBlocoPg - xEsquerda - 16;

  const nomeUpper = String(textoLinha || "").toUpperCase();

  const opcoesNome = {
    width: larguraNomeMax,
    height: INDICE_LINHA_TAMANHO + 4,
    ellipsis: true,
    lineBreak: false,
  };
  // 2026-09-11: eco atrás do nome da Linha (ver _textoComEco), igual ao
  // catálogo original — substitui a chamada direta a _textoComSombra.
  _textoComEco(doc, nomeUpper, xEsquerda, y, VERMELHO_CATEGORIA, opcoesNome, INDICE_LINHA_TAMANHO);

  doc.font(TITULO_FONTE).fontSize(INDICE_LINHA_TAMANHO);
  const larguraNomeReal = Math.min(doc.widthOfString(nomeUpper), larguraNomeMax);

  // Pedido do usuário (2026-08-26): trocar o líder pontilhado por um "hr"
  // cinza sólido — mesma cor/opacidade já usadas como divisória entre foto
  // e texto em cada card (LINHA_DIVISORIA), padronizando o cinza do índice
  // com o resto do catálogo em vez de um estilo novo.
  // Ajuste fino (2026-08-26): descido um pouco (0.7 → 0.78 do tamanho da
  // linha) pra ficar entre o pé do texto da Linha e o pé do bloco "PG nn",
  // em vez de cortar no meio da altura do texto; espessura um pouco maior
  // (0.6 → 0.9) e gap lateral reduzido (8 → 6) pra ficar um pouco mais
  // comprido, como pedido ("aumente o pouco o tamanho do hr").
  const yLider = y + INDICE_LINHA_TAMANHO * 0.78;
  const xLiderInicio = xEsquerda + larguraNomeReal + 6;
  const xLiderFim = xBlocoPg - 6;
  if (xLiderFim > xLiderInicio) {
    doc.moveTo(xLiderInicio, yLider).lineTo(xLiderFim, yLider)
      .lineWidth(0.9).strokeColor(LINHA_DIVISORIA, 0.8).stroke();
  }

  // Pedido do usuário (2026-08-26): "centralize PG e números" — antes "PG"
  // ficava colado na ponta esquerda do bloco reservado e o número na ponta
  // direita (bem separados); agora os dois são medidos e desenhados como
  // um GRUPO único, centralizado dentro de larguraBlocoPg, com a linha de
  // base do "PG" (fonte menor) alinhada à base do número (fonte maior).
  // Ajuste fino (2026-08-26): pequeno espaço fixo entre "PG" e o número
  // (antes os dois praticamente se tocavam) e número padronizado na mesma
  // fonte do "PG" (TITULO_FONTE = Futura MD BT), em vez de Helvetica-Bold
  // — evita a mistura de duas famílias tipográficas lado a lado e, por
  // usarem a mesma fonte, o alinhamento vertical por proporção de tamanho
  // fica consistente entre os dois.
  const gapPgNumero = 4;
  doc.font(TITULO_FONTE).fontSize(INDICE_PG_LABEL_TAMANHO);
  const larguraPg = doc.widthOfString("PG");
  doc.font(TITULO_FONTE).fontSize(INDICE_PG_NUMERO_TAMANHO);
  const larguraNumero = doc.widthOfString(String(numeroPagina));
  const larguraGrupo = larguraPg + gapPgNumero + larguraNumero;
  const xGrupo = xBlocoPg + (larguraBlocoPg - larguraGrupo) / 2;
  const yNumero = y + (INDICE_LINHA_TAMANHO - INDICE_PG_NUMERO_TAMANHO) / 2;
  const yPg = yNumero + (INDICE_PG_NUMERO_TAMANHO - INDICE_PG_LABEL_TAMANHO);

  doc.font(TITULO_FONTE).fontSize(INDICE_PG_LABEL_TAMANHO);
  _textoComSombra(doc, "PG", xGrupo, yPg, AZUL, { lineBreak: false });
  // Pedido do usuário (2026-08-26): "retire sombra de números" — só o
  // número da página, sem sombra (o "PG" ao lado continua com sombra,
  // igual ao resto do texto do índice).
  doc.font(TITULO_FONTE).fontSize(INDICE_PG_NUMERO_TAMANHO);
  doc.fillColor(AZUL).text(String(numeroPagina), xGrupo + larguraPg + gapPgNumero, yNumero, { lineBreak: false });

  doc.fillColor("#111827").font("Helvetica");
}

/**
 * Gera o PDF e faz stream direto pro destino (a `res` do Express — quem
 * chama já seta os headers de Content-Type/Content-Disposition antes).
 * Não retorna Promise: o próprio doc.end() encerra a escrita/resposta.
 */
// Pedido do usuário (2026-09-19, melhoria "unificar layout Critérios de
// Pesquisa/Catálogo Completo"): até aqui esta função desenhava sua PRÓPRIA
// grade simples (5 colunas × 6 linhas, sem índice, sem agrupar por Linha/
// Marca, card mais raso sem texto de aplicação — ver histórico do arquivo
// se precisar recuperar essa versão antiga). O usuário comparou o PDF de
// Critérios de Pesquisa lado a lado com o Catálogo Completo e pediu:
// "organize linhas e colunas igual, ajuste a foto também da mesma maneira,
// assim como todo o resto de design, a única diferença mesmo é que posso
// fazer catálogo com apenas aqueles selecionados" — ou seja, o layout
// (índice, agrupamento por Linha/Marca, grade 4×5, foto real + aplicação
// no card, cabeçalho/rodapé) deve ficar IDÊNTICO ao Catálogo Completo; a
// única diferença legítima entre os dois modos é QUAIS produtos entram
// (resultado de busca/seleção manual aqui, "todo o catálogo de 1
// fabricante" lá) — não como eles são desenhados.
//
// Por isso esta função agora delega inteiramente pra
// gerarPdfCatalogoCompleto: fabricante="" (não há um fabricante isolado
// numa busca por veículo/código/nome/seleção manual — cai sempre no
// estilo "eletrica" padrão, ver _estiloCatalogoCompleto) e
// agruparPorMarca=false (agrupa por Linha normalmente, com o mesmo sub-
// agrupamento por marca de veículo dentro de cada Linha que o Catálogo
// Completo já faz). `tituloBusca` deixou de ser desenhado como texto de
// cabeçalho — o Catálogo Completo mostra o nome da Linha em cada página,
// não a busca em si, e é exatamente esse comportamento que passa a valer
// aqui também (mesmo pro modo "fabricante isolado + outro filtro", que já
// caía nesta função antes — ver modoCompleto em catalogo.controller.js).
// Parâmetro mantido no signature (compatibilidade dos call sites
// existentes) mesmo sem uso direto no corpo.
async function gerarPdfCatalogo(produtos, tituloBusca, destino) {
  return gerarPdfCatalogoCompleto(produtos, "", destino, null, false);
}

/**
 * Gera o PDF do modo "Catálogo Completo" (Issue #21, pedido do usuário
 * 2026-08-26): TODO o catálogo de um fabricante, dividido por Linha, com
 * página(s) de ÍNDICE/sumário no início — réplica do modelo de referência
 * (3-RHO.pdf) que o usuário mandou, confirmada por dois prints com guias de
 * medição do CorelDRAW: grade 4 colunas × 5 linhas = 20 produtos/página,
 * título do índice 36pt, linha do índice 17pt na mesma Futura Md BT Bold
 * Italic dos títulos de seção, "PG" 12pt.
 *
 * Função separada de gerarPdfCatalogo (mantida intacta pros outros modos de
 * exportação — busca por veículo/código/nome/seleção manual, grade 5×6) —
 * só o dispatch do controller (catalogo.controller.js) decide qual das duas
 * chamar, com base no modo detectado (fabricante isolado, sem marca/modelo/
 * categoria).
 *
 * A paginação do índice é pré-calculada matematicamente ANTES de desenhar
 * qualquer página — pdfkit renderiza sequencialmente, sem "olhar adiante",
 * então não dá pra descobrir em que página cada Linha começa desenhando
 * primeiro e só depois escrevendo o número. Ver A4_LARGURA/A4_ALTURA no
 * topo do arquivo.
 */
// `agruparPorMarca` (pedido do usuário, 2026-09-05 — catálogo pseudo-
// fabricante "DIVERSOS", ver PSEUDO_FABRICANTE_DIVERSOS em
// catalogo-x2.service.js): quando true, os produtos já vêm de VÁRIOS
// fabricantes reais compartilhando a mesma Linha catch-all
// (linha="DIVERSOS") — agrupar por Linha aqui seria inútil (uma seção só,
// tudo dentro dela). Em vez disso, agrupa por MARCA DE VEÍCULO (reaproveita
// _agruparPorMarca, a mesma função usada pro sub-agrupamento normal, só
// que aqui promovida a agrupamento de TOPO) e desliga o sub-agrupamento de
// marca de dentro de cada grupo (semSubAgrupamentoMarca em
// _construirSequenciaConteudo) — senão um produto com 2 marcas citadas
// ganharia um sub-cabeçalho redundante dentro do próprio grupo-marca.
async function gerarPdfCatalogoCompleto(produtos, fabricante, destino, tipoCompleto = null, agruparPorMarca = false) {
  // Estilo "Mecânica" (pedido do usuário, 2026-09-03) — fixo por fabricante,
  // ver _estiloCatalogoCompleto/MECANICA_* no topo do arquivo. Todo o resto
  // desta função continua igual pro estilo "eletrica" (padrão, ~3600
  // fabricantes restantes). tipoCompleto ("mecanica"/"eletrica"/null) vem do
  // dropdown separado do Catálogo Completo quando o fabricante tem peça nos
  // dois grupos — ver catalogo.controller.js/catalogo-x2.service.js.
  const estilo = _estiloCatalogoCompleto(fabricante, tipoCompleto);

  if (estilo === "arielo") {
    // eslint-disable-next-line global-require
    return require("./catalogo-pdf-arielo.service").gerarPdfCatalogoArielo(produtos, fabricante, destino, _interno());
  }

  // EXPERIMENTO (EXP_CONTINUO=1, pedido do usuário 2026-10-20): Catálogo Completo no modelo do Canva, 2 por linha,
  // em rolagem contínua. Desligado por padrão — só para gerar o print/PDF de teste.
  if (process.env.EXP_CONTINUO === "1" && estilo !== "mecanica") {
    // eslint-disable-next-line global-require
    return require("./catalogo-pdf-continuo.service").gerarPdfCatalogoContinuo(produtos, fabricante, destino, _interno(), { agruparPorMarca });
  }

  // 2026-10-09 (auditoria de performance): `bufferPages: true` REMOVIDO.
  // Com ela, o pdfkit não finaliza nenhuma página no addPage: guarda todas em
  // _pageBuffer e, só no doc.end(), roda um zlib.deflateSync POR PÁGINA de uma
  // vez só — um bloqueio síncrono de vários segundos no fim da geração, depois
  // do último await, justamente quando o usuário acha que acabou. A flag não
  // servia pra nada aqui: ela só é necessária pra doc.switchToPage(), que este
  // gerador evita de propósito (ver comentário mais abaixo). Sem ela, cada
  // página é finalizada no addPage seguinte — dentro do laço, entre as
  // chamadas de _cederEventLoop — distribuindo o custo. O PDF sai idêntico.
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  doc.pipe(destino);
  doc.registerFont(TITULO_FONTE, TITULO_FONTE_ARQUIVO);
  doc.registerFont(PROMO_TITULO_FONTE, PROMO_TITULO_FONTE_ARQUIVO);
  // Quicksand só é usada no card do Catálogo Completo (_desenharCardCatalogoCompleto)
  // — ver comentário em QUICKSAND_BOLD acima. gerarPdfCatalogo (modo regular/
  // busca expressa) não registra essas fontes de propósito, não é afetado.
  doc.registerFont(QUICKSAND_BOLD, QUICKSAND_BOLD_ARQUIVO);
  doc.registerFont(QUICKSAND_MEDIUM, QUICKSAND_MEDIUM_ARQUIVO);
  // Só precisa existir no documento quando o estilo mecânica realmente
  // desenhar algo com ela (_desenharCabecalho/_desenharCardCatalogoCompleto),
  // mas registrar sempre é barato e evita esquecer em algum branch futuro.
  doc.registerFont(MECANICA_TITULO_FONTE, MECANICA_TITULO_FONTE_ARQUIVO);
  // Fonte do número de página no rodapé (pedido do usuário, 2026-09-08) —
  // ver comentário em RODAPE_NUMERO_FONTE acima.
  doc.registerFont(RODAPE_NUMERO_FONTE, RODAPE_NUMERO_FONTE_ARQUIVO);

  // Issue #57: produto só pode entrar no catálogo se pelo menos uma foto
  // realmente abrir no PDFKit. `temAlgumaFoto` no controller só verifica o
  // índice e deixava passar arquivos corrompidos ou em formato inválido; o
  // cartão acabava sendo impresso com o rótulo "sem foto". Filtrar aqui,
  // antes de agrupar e calcular índice/páginas, mantém esses totais corretos.
  const produtosComFoto = [];
  for (let i = 0; i < produtos.length; i++) {
    const produto = produtos[i];
    if (_fotosUtilizaveis(doc, produto.codigo).length > 0) produtosComFoto.push(produto);
    if (i > 0 && i % CEDER_A_CADA_N_BLOCOS === 0) await _cederEventLoop();
  }
  produtos = produtosComFoto;

  const grupos = agruparPorMarca
    ? _agruparPorMarca(produtos).map(({ marca, produtos: itens }) => ({ linha: marca, itens }))
    : _agruparPorLinha(produtos);

  // 2026-09-22 (pedido do usuário: "muito espaço do cabeçalho até a linha e
  // embaixo tem muito espaço também"): estilo mecânica usa cabeçalho
  // (MECANICA_HEADER_HEIGHT) e rodapé (MECANICA_RODAPE_ALTURA) próprios, bem
  // mais enxutos que a arte/imagem da elétrica (HEADER_HEIGHT/FOOTER_HEIGHT)
  // — daqui pra baixo, toda conta de área disponível (índice E grade de
  // cards) usa estas duas variáveis "efetivas" em vez das constantes fixas,
  // senão o cabeçalho/rodapé encolhem mas a área de conteúdo continua
  // reservando o vão antigo, maior, só empurrando o espaço sobrando pra
  // outro lugar da página.
  const headerHeightIndiceEfetivo = estilo === "mecanica" ? MECANICA_HEADER_HEIGHT : INDICE_HEADER_HEIGHT;
  const areaTopoYIndiceEfetivo = headerHeightIndiceEfetivo + INDICE_TITULO_GAP_TOPO + INDICE_TITULO_TAMANHO + INDICE_TITULO_GAP_LINHAS;
  const alturaRodapeReal = estilo === "mecanica" ? MECANICA_RODAPE_ALTURA : FOOTER_HEIGHT;

  // --- Pré-cálculo da paginação do índice (ver comentário acima) ---
  const larguraUtilIndice = A4_LARGURA - PAGE_MARGIN * 2;
  const areaFimYIndice = A4_ALTURA - alturaRodapeReal - 8;
  const alturaDisponivelIndice = areaFimYIndice - areaTopoYIndiceEfetivo;
  const linhasPorPaginaIndice = Math.max(1, Math.floor(alturaDisponivelIndice / INDICE_LINHA_ALTURA));
  const paginasIndice = Math.max(1, Math.ceil(grupos.length / linhasPorPaginaIndice));

  // 2026-08-28 (sub-agrupamento por marca de veículo — ver comentário em
  // MARCA_HEADER_FONTE e em _calcularLayoutConteudo): a paginação por
  // Linha não é mais uma divisão simples (itens / itensPorPagina), porque
  // os cabeçalhos de marca inseridos dentro de cada Linha "comem" espaço
  // que antes era só de cards, e um cabeçalho força início de linha nova
  // na grade (perde alguns slots vazios na transição de marca). Por isso
  // agora simula a grade de verdade (_calcularLayoutConteudo) ANTES de
  // desenhar a página de índice, pra saber com precisão em que página
  // cada Linha cai — mesma função usada depois pra desenhar de verdade
  // (chamada de novo com a mesma sequência/geometria = mesmo resultado,
  // ver comentário em _calcularLayoutConteudo sobre por que ela precisa
  // ser pura/determinística).
  const alturaHeaderMarca = _alturaCabecalhoMarca(doc);
  const { sequencia, primeiroIndicePorGrupo } = _construirSequenciaConteudo(grupos, agruparPorMarca);
  // 2026-09-03: linhas por página variam por estilo (medido no mockup —
  // Mecânica só cabe 4, não 5, ver ROWS_POR_PAGINA_COMPLETO_MECANICA). Único
  // ponto que precisa saber disso — _calcularLayoutConteudo é puramente
  // geométrica (ver comentário na função), então index/paginação real se
  // ajustam sozinhos a partir daqui.
  const rowsCompleto = estilo === "mecanica" ? ROWS_POR_PAGINA_COMPLETO_MECANICA : ROWS_POR_PAGINA_COMPLETO_ELETRICA;
  // 2026-09-22: mesma lógica de overrides já usada pelo Catálogo Promocional
  // (ver comentário em _geometriaGrid) — pro estilo mecânica, recalcula
  // areaTopoY/areaFimY com MECANICA_HEADER_HEIGHT/MECANICA_RODAPE_ALTURA em
  // vez das constantes AREA_TOPO_Y/FOOTER_HEIGHT (calibradas pro cabeçalho/
  // rodapé bem mais altos da elétrica). Estilo elétrica passa a mesma conta
  // que os defaults internos de _geometriaGrid já faziam — comportamento
  // idêntico a antes, sem mudança.
  const geometriaOverrides = estilo === "mecanica"
    ? {
        areaTopoY: MECANICA_HEADER_HEIGHT + TITULO_GAP_TOPO + TITULO_TAMANHO + TITULO_GAP_CARDS,
        areaFimY: A4_ALTURA - alturaRodapeReal - 30.349,
      }
    : { areaTopoY: process.env.EXP_PROMO === "1" ? A4_LARGURA / PROMO_CABECALHO_LINHA_RATIO + GAP + 14 : AREA_TOPO_Y, areaFimY: A4_ALTURA - alturaRodapeReal - 30.349 };
  const geometriaCompleto = _geometriaGrid(doc, COLS_COMPLETO, process.env.EXP_PROMO === "1" && estilo !== "mecanica" ? 5 : rowsCompleto, true, geometriaOverrides);
  const { posicoes, preenchimentoFinal } = _calcularLayoutConteudo(sequencia, geometriaCompleto, alturaHeaderMarca, false, alturaRodapeReal);
  const paginaInicialPorGrupo = primeiroIndicePorGrupo.map(
    (idx) => paginasIndice + 1 + posicoes[idx].pagina
  );

  // 2026-10-19: pedido do usuário "centralize os fabricantes entre o espaço de
  // linha (título) e rodapé, dando impressão de centralizados, reduzindo o
  // espaço branco acima do rodapé" — por página, mede onde termina o último
  // bloco desenhado (card, cabeçalho de marca ou card de preenchimento) e
  // desce TUDO daquela página metade da sobra até areaFimY. Só desloca y
  // (nunca muda a paginação, então o índice continua batendo).
  {
    const fimPorPagina = new Map();
    const marcaFim = (pg, y) => fimPorPagina.set(pg, Math.max(fimPorPagina.get(pg) ?? 0, y));
    sequencia.forEach((bl, k) => {
      const ps = posicoes[k];
      marcaFim(ps.pagina, ps.y + (bl.tipo === "cabecalhoMarca" ? alturaHeaderMarca : geometriaCompleto.cardHeight));
    });
    preenchimentoFinal.forEach((pf) => marcaFim(pf.pagina, pf.y + pf.cardHeight));
    const dyPorPagina = new Map();
    // 2026-10-19: "suba mais para perto da primeira linha" — sem centralizar (dy=0): conteúdo colado no título.
    fimPorPagina.forEach((fim, pg) => dyPorPagina.set(pg, 0));
    posicoes.forEach((ps) => {
      const dy = dyPorPagina.get(ps.pagina) || 0;
      ps.y += dy;
      if (ps.headerRepetidoY != null) ps.headerRepetidoY += dy;
    });
    preenchimentoFinal.forEach((pf) => { pf.y += dyPorPagina.get(pf.pagina) || 0; });

    // EXPERIMENTO (EXP_PROMO=1), pedido 2026-10-19: em páginas com mais de um fabricante, desce SÓ o último
    // fabricante (cabeçalho + cards + cards de preenchimento dele) um pouco, limitado à sobra até o rodapé.
    if (process.env.EXP_PROMO === "1") {
      const DESCER_ULTIMO = 60;
      const paginas = new Set(posicoes.map((ps) => ps.pagina));
      paginas.forEach((pg) => {
        const idxs = sequencia.map((bl, k) => k).filter((k) => posicoes[k].pagina === pg);
        // cabeçalhos de marca que NÃO abrem a página (o 1º grupo pode ter o cabeçalho "repetido" no topo, sem bloco próprio)
        const cabs = idxs.filter((k) => sequencia[k].tipo === "cabecalhoMarca" && k !== idxs[0]);
        if (cabs.length < 1 || (idxs.length && sequencia[idxs[0]].tipo === "cabecalhoMarca" && cabs.length < 1)) return;
        const yUltimo = posicoes[cabs[cabs.length - 1]].y;
        let fim = 0;
        idxs.forEach((k) => { fim = Math.max(fim, posicoes[k].y + (sequencia[k].tipo === "cabecalhoMarca" ? alturaHeaderMarca : geometriaCompleto.cardHeight)); });
        preenchimentoFinal.filter((pf) => pf.pagina === pg).forEach((pf) => { fim = Math.max(fim, pf.y + pf.cardHeight); });
        const dy = Math.max(0, Math.min(DESCER_ULTIMO, geometriaCompleto.areaFimY - fim));
        console.log('DBG pg',pg,'yUltimo',yUltimo.toFixed(1),'fim',fim.toFixed(1),'areaFimY',geometriaCompleto.areaFimY.toFixed(1),'dy',dy.toFixed(1));
        idxs.forEach((k) => { if (posicoes[k].y >= yUltimo - 0.01) { posicoes[k].y += dy; if (posicoes[k].headerRepetidoY != null) posicoes[k].headerRepetidoY += dy; } });
        preenchimentoFinal.filter((pf) => pf.pagina === pg && pf.y >= yUltimo - 0.01).forEach((pf) => { pf.y += dy; });
      });
    }
  }

  let pagina = 0;

  // --- Páginas de índice ---
  for (let p = 0; p < paginasIndice; p += 1) {
    doc.addPage();
    pagina += 1;
    if (estilo === "mecanica") _desenharFundoGradienteMecanica(doc);
    _desenharCabecalhoIndice(doc, estilo, fabricante);
    _desenharRodape(doc, pagina, estilo);

    const offset = p * linhasPorPaginaIndice;
    const linhasDestaPagina = grupos.slice(offset, offset + linhasPorPaginaIndice);
    let y = areaTopoYIndiceEfetivo;
    linhasDestaPagina.forEach((grupo, i) => {
      _desenharLinhaIndice(doc, grupo.linha, paginaInicialPorGrupo[offset + i], y, larguraUtilIndice);
      y += INDICE_LINHA_ALTURA;
    });
  }

  // --- Páginas de conteúdo: sequência única e contínua entre Linhas ---
  // 2026-08-27 (paginação contínua original): os itens de TODAS as Linhas
  // (já na ordem alfabética de _agruparPorLinha) formam uma única
  // sequência — a grade é preenchida sem parar entre grupos, só quebra
  // página quando a grade da página atual está de fato cheia.
  //
  // 2026-08-28 (sub-agrupamento por marca): a sequência agora intercala
  // blocos "cabecalhoMarca" (faixa azul com o nome da marca) entre os
  // blocos "card" — já construída em `sequencia`/`posicoes` acima, no
  // mesmo pré-cálculo que gerou os números de página do índice. Este loop
  // só REPRODUZ essas posições já calculadas (desenhando, não recalculando
  // layout), então índice e conteúdo nunca podem divergir.
  //
  // Título do cabeçalho de cada página = a Linha do bloco que ABRIU essa
  // página (o 1º bloco desenhado nela, cabeçalho de marca ou card) — se
  // uma página tiver o fim de uma Linha e o começo da seguinte, o título
  // mostra a Linha de quem abriu; os produtos da Linha seguinte, mesmo
  // sem título de página próprio, continuam identificáveis pelo cabeçalho
  // de marca (inline) e pelo selo/código no próprio card.
  const larguraUtilCompleto = A4_LARGURA - PAGE_MARGIN * 2;
  let paginaLocalAtual = -1;
  // 2026-09-05: ver comentário de `inicioDeLinha` em
  // _construirSequenciaConteudo — guarda a Linha mostrada no título grande
  // da página atual, pra saber se um "cabecalhoMarca" que abre uma Linha
  // nova precisa repetir o nome dela (troca aconteceu no MEIO da página,
  // sem passar por _desenharCabecalho).
  let linhaTituloPagina = null;

  // 2026-08-28 (pedido "preencha com cards vazios embaixo"): desenha as
  // linhas de preenchimento de UMA página (calculadas em
  // _calcularLayoutConteudo) — chamada logo ANTES de sair dela de vez
  // (seja trocando pra próxima página, seja no fim do documento), porque
  // é o último momento em que ela ainda é a página ativa no pdfkit (sem
  // isso precisaria de doc.switchToPage, mais complicado sem necessidade).
  function _desenharPreenchimentoDaPagina(numeroPagina) {
    preenchimentoFinal
      .filter((p) => p.pagina === numeroPagina)
      .forEach((p) => _desenharCardVazio(doc, p.x, p.y, p.cardWidth, p.cardHeight));
  }

  for (let i = 0; i < sequencia.length; i += 1) {
    const bloco = sequencia[i];
    const pos = posicoes[i];
    if (pos.pagina !== paginaLocalAtual) {
      if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);
      paginaLocalAtual = pos.pagina;
      doc.addPage();
      pagina += 1;
      if (estilo === "mecanica") _desenharFundoGradienteMecanica(doc);
      _desenharCabecalho(doc, bloco.linha, estilo, fabricante);
      _desenharRodape(doc, pagina, estilo);
      linhaTituloPagina = bloco.linha;
    }

    if (bloco.tipo === "cabecalhoMarca") {
      // 2026-09-05: Linha nova começando no meio da página (não passou por
      // _desenharCabecalho acima) — prefixa o nome da Linha no cabeçalho de
      // marca pra não parecer continuação da Linha anterior (ver comentário
      // de `inicioDeLinha` em _construirSequenciaConteudo).
      const trocouDeLinhaSemTitulo = bloco.inicioDeLinha && bloco.linha !== linhaTituloPagina;
      // bloco.marca === bloco.linha só acontece no modo "sem sub-agrupamento
      // de marca" (catálogo Diversos — ver semSubAgrupamentoMarca em
      // _construirSequenciaConteudo): aqui "marca" JÁ É o próprio nome do
      // grupo-topo. Quando NÃO houve troca no meio da página
      // (!trocouDeLinhaSemTitulo), o título grande (_desenharCabecalho) já
      // acabou de anunciar esse mesmo nome — desenhar de novo aqui embaixo
      // seria puramente redundante (ex: "MBB" grande, "MBB" pequeno logo
      // abaixo, sem informação nova nenhuma), então pula o desenho. A altura
      // continua reservada no layout (pré-calculada por
      // _calcularLayoutConteudo, que não sabe/precisa saber disso) — só
      // fica em branco, sem texto.
      if (bloco.marca === bloco.linha && !trocouDeLinhaSemTitulo) {
        // não desenha nada — ver comentário acima.
      } else {
        const textoCabecalhoMarca = trocouDeLinhaSemTitulo
          ? (bloco.marca && bloco.marca !== bloco.linha ? `${bloco.linha} — ${bloco.marca}` : bloco.linha)
          : bloco.marca;
        _desenharCabecalhoMarca(doc, textoCabecalhoMarca, pos.x, pos.y, larguraUtilCompleto, alturaHeaderMarca, trocouDeLinhaSemTitulo ? "left" : "center");
      }
    } else {
      // 2026-08-28: quando uma quebra de página acontece NO MEIO de um
      // sub-grupo (não na 1ª linha dele, ver comentário em
      // _calcularLayoutConteudo), `pos.headerRepetidoMarca` vem
      // preenchido — repete o cabeçalho da marca no topo da página nova
      // antes de desenhar este card, pra o cliente não perder a
      // referência de qual marca está olhando.
      if (pos.headerRepetidoMarca) {
        _desenharCabecalhoMarca(doc, pos.headerRepetidoMarca, PAGE_MARGIN, pos.headerRepetidoY, larguraUtilCompleto, alturaHeaderMarca);
      }
      if (bloco.tipo === "cardVazio") {
        _desenharCardVazio(doc, pos.x, pos.y, geometriaCompleto.cardWidth, geometriaCompleto.cardHeight);
      } else {
        _desenharCard(
          doc, bloco.produto, pos.x, pos.y,
          geometriaCompleto.cardWidth, geometriaCompleto.cardHeight,
          geometriaCompleto.photoBoxWidth, geometriaCompleto.photoBoxHeight, true, bloco.marca,
          null, estilo
        );
      }
    }

    // Ver comentário de CEDER_A_CADA_N_BLOCOS no topo do arquivo.
    if (i > 0 && i % CEDER_A_CADA_N_BLOCOS === 0) await _cederEventLoop();
  }

  // Preenchimento da ÚLTIMA página — não passa pela troca de página do
  // loop acima (não tem próximo bloco depois dela), desenha aqui.
  if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);

  doc.end();
}

/**
 * Gera o PDF do modo "Catálogo Promocional" (nova função, pedido do usuário
 * 2026-08-29: "farei uma nova aba dentro de catalogos de produto, crie
 * Catalogo Promocional onde terá a mesma funcionalidade de catalogo
 * completo, porém farei lista selecionada de produtos, não precisa
 * subcategorizar, deixa como antes e na parte superior direita iremos
 * deixar um espaço para preços").
 *
 * Réplica quase idêntica de gerarPdfCatalogoCompleto acima (mesmo
 * cabeçalho/rodapé/índice por Linha/grade 4×5/foto real), com 3 diferenças
 * pontuais, todas confirmadas com o usuário via perguntas de escopo:
 *   1. `produtos` é uma LISTA SELECIONADA manualmente pelo atendente (não
 *      "todo o catálogo de um fabricante") — controller resolve os
 *      códigos escolhidos antes de chamar esta função, pode misturar
 *      fabricantes diferentes na mesma lista.
 *   2. SEM sub-agrupamento por marca de veículo dentro de cada Linha
 *      ("não precisa subcategorizar, deixa como antes") — usa
 *      _construirSequenciaConteudoPromocional em vez de
 *      _construirSequenciaConteudo, sem blocos "cabecalhoMarca". Como
 *      consequência, _desenharCard nunca recebe `marcaAtual` aqui (sempre
 *      null) — o texto de aplicação de cada card sai completo, sem o corte
 *      por marca que só faz sentido dentro de um sub-grupo.
 *   3. Badge de preço por card, canto superior direito (ver
 *      _desenharBadgePreco) — `precosPorCodigo` é um Map<string codigo,
 *      number preco> montado pelo controller a partir do CSV que o
 *      usuário sobe ("eu enviarei arquivos csv com codigos e preços
 *      promocionais"); código sem entrada no map simplesmente não desenha
 *      badge nenhum (preço é OPCIONAL por produto, não obrigatório pra
 *      todo item da lista).
 *
 * Agrupamento por Linha (p.linha/p.secao, via _agruparPorLinha) continua
 * exatamente como no Catálogo Completo — só o sub-agrupamento por Marca foi
 * removido, por pedido explícito do usuário ("Mantém cabeçalho de Linha,
 * remove só Marca"). **2026-08-31 (pedido do usuário "remova sumario"):**
 * ao contrário do Catálogo Completo, esta função NÃO gera páginas de
 * índice/sumário — vai direto pro conteúdo.
 *
 * 2026-08-31 (pedido do usuário: "o catalogo promocional poderá ser por
 * linha ou por fabricante"): novo parâmetro `modo` ("linha" | "fabricante",
 * default "linha" — mantém o comportamento de sempre se quem chamar não
 * passar nada, ver controller). Troca DUAS coisas em conjunto, nunca uma
 * sem a outra:
 *   1. Critério de agrupamento — _agruparPorLinha (por Linha/Seção, pode
 *      misturar fabricantes) vs. _agruparPorFabricante (por
 *      `produto.fabricante`, todos os cards do grupo são do mesmo
 *      fabricante) — ver comentário em _agruparPorFabricante.
 *   2. Arte de cabeçalho/rodapé — _desenharCabecalhoPromo/_desenharRodapePromo
 *      escolhem a arte certa (PROMO_CABECALHO_LINHA_IMG vs.
 *      PROMO_CABECALHO_FABRICANTE_IMG, ver comentário lá) a partir do MESMO
 *      `modo`, então o título de cada página (nome da Linha ou do
 *      Fabricante, dependendo do modo) sempre bate com a arte usada.
 * O índice/sumário continua listando o mesmo `grupo.linha` de sempre — só
 * que agora ele carrega o nome do Fabricante quando `modo==="fabricante"`
 * (mesmo campo, significado diferente por modo — ver _agruparPorFabricante).
 */
async function gerarPdfCatalogoPromocional(produtos, precosPorCodigo, destino, modo = "linha", opcoes = {}) {
  // 2026-10-09 (auditoria de performance): `bufferPages: true` REMOVIDO.
  // Com ela, o pdfkit não finaliza nenhuma página no addPage: guarda todas em
  // _pageBuffer e, só no doc.end(), roda um zlib.deflateSync POR PÁGINA de uma
  // vez só — um bloqueio síncrono de vários segundos no fim da geração, depois
  // do último await, justamente quando o usuário acha que acabou. A flag não
  // servia pra nada aqui: ela só é necessária pra doc.switchToPage(), que este
  // gerador evita de propósito (ver comentário mais abaixo). Sem ela, cada
  // página é finalizada no addPage seguinte — dentro do laço, entre as
  // chamadas de _cederEventLoop — distribuindo o custo. O PDF sai idêntico.
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  doc.pipe(destino);
  doc.registerFont(TITULO_FONTE, TITULO_FONTE_ARQUIVO);
  doc.registerFont(PROMO_TITULO_FONTE, PROMO_TITULO_FONTE_ARQUIVO);
  doc.registerFont(QUICKSAND_BOLD, QUICKSAND_BOLD_ARQUIVO);
  doc.registerFont(QUICKSAND_MEDIUM, QUICKSAND_MEDIUM_ARQUIVO);
  // Fonte do número de página no rodapé (pedido do usuário, 2026-09-08) —
  // ver comentário em RODAPE_NUMERO_FONTE acima.
  doc.registerFont(RODAPE_NUMERO_FONTE, RODAPE_NUMERO_FONTE_ARQUIVO);

  // PEDIDO DO USUÁRIO (2026-09-15): "preciso que fiquem organizados por
  // codigo também" — dentro de cada grupo (Linha ou Fabricante),
  // _agruparPorLinha/_agruparPorFabricante só preservam a ordem em que os
  // produtos chegaram no array `produtos` (ordem de busca/importação do
  // arquivo de preços, arbitrária) — não ordenavam por código nenhum. Essas
  // duas funções são COMPARTILHADAS com o Catálogo Completo (ver
  // gerarPdfCatalogoCompleto, ~linha 3246), então a ordenação entra aqui,
  // ordenando uma CÓPIA de `produtos` antes de agrupar — só afeta o
  // Catálogo Promocional, o Completo continua na ordem que já usava.
  // localeCompare com numeric:true trata "MB2" < "MB10" corretamente (não
  // ordena como texto puro, onde "MB10" viria antes de "MB2").
  const produtosOrdenados = [...produtos].sort((a, b) =>
    String(a.codigo ?? "").localeCompare(String(b.codigo ?? ""), "pt-BR", { numeric: true })
  );
  // Issue #74: `opcoes.titulo` troca o agrupamento por UM grupo só com esse
  // título (ex.: "Promocional") — sem páginas separadas por fabricante/linha
  // e sem nomes de grupo ("CHEVROLET", "SEM FABRICANTE IDENTIFICADO") que não
  // são o assunto do catálogo. `opcoes.logo` (Buffer PNG) vai na faixa azul
  // do canto direito do cabeçalho (só no modo "fabricante").
  const tituloFixo = String(opcoes?.titulo || "").trim();
  const logoCabecalho = opcoes?.logo || null;
  const grupos = tituloFixo
    ? [{ linha: tituloFixo, itens: produtosOrdenados }]
    : (modo === "fabricante" ? _agruparPorFabricante(produtosOrdenados) : _agruparPorLinha(produtosOrdenados));

  // 2026-08-31 (pedido do usuário: "remova sumario"): Catálogo Promocional
  // não tem mais páginas de índice/sumário — vai direto pro conteúdo. Isso
  // reverte a decisão anterior ("Mantém cabeçalho de Linha" via índice, ver
  // comentário acima no JSDoc) só pra esta função; `gerarPdfCatalogoCompleto`
  // continua com índice normalmente, não é afetado.
  // BUG REAL achado em auditoria (2026-09-23): modo "linha" passava `false`
  // aqui — grupos (Linhas) diferentes podiam compartilhar a MESMA linha da
  // grade, coluna a coluna, sem quebra nenhuma entre eles. Como o cabeçalho
  // grande da página (_desenharCabecalhoPromo, logo abaixo) só é redesenhado
  // em troca de PÁGINA, nunca em troca de Linha no meio dela, uma seleção
  // promocional misturando categorias (comum — é o uso normal do recurso)
  // podia mostrar um título ("AMORTECEDOR DE CAPO", por exemplo) cobrindo
  // produtos de Linhas completamente diferentes embaixo (chicote, estator,
  // induzido — nenhuma relação com o título). Mesma classe de bug já
  // corrigida no Catálogo Completo em 2026-09-05 (Linha nova no meio da
  // página sem indicação nenhuma) — lá a correção foi repetir o nome da
  // Linha; aqui, sem o mecanismo de cabeçalho de marca do Completo, a
  // correção equivalente mais simples e já testada é sempre iniciar cada
  // grupo numa linha de grade nova (`true`, como o modo "fabricante" já
  // fazia) — ver forcarQuebraEntreGrupos logo abaixo, que passa a valer
  // pros dois modos.
  const { sequencia } = _construirSequenciaConteudoPromocional(grupos, true);
  // 2026-08-31 (pedido do usuário: "reduza mais esse espaço e suba mais um
  // pouco o rodapé"): a grade do Promocional reusava AREA_TOPO_Y/
  // FOOTER_HEIGHT do Catálogo padrão (cabeçalho/rodapé bem mais altos),
  // sobrando ~75pt de vão acima dos cards e ~44pt acima do rodapé, mesmo
  // com o cabeçalho/rodapé PRÓPRIOS do Promocional (bem mais baixos — a
  // arte já traz o título dentro dela, ver _desenharCabecalhoPromo) sendo
  // bem menores. Aqui a altura real do cabeçalho/rodapé do modo atual é
  // calculada (mesma conta de _desenharCabecalhoPromo/_desenharRodapePromo:
  // largura da página / ratio do arquivo) e usada como base, com só um
  // respiro pequeno (mesmo GAP das colunas) antes do 1º card e antes do
  // rodapé.
  const ehFabricantePromo = modo === "fabricante";
  const alturaCabecalhoPromo = A4_LARGURA / (ehFabricantePromo ? PROMO_CABECALHO_FABRICANTE_RATIO : PROMO_CABECALHO_LINHA_RATIO);
  const alturaRodapePromo = A4_LARGURA / (ehFabricantePromo ? PROMO_RODAPE_FABRICANTE_RATIO : PROMO_RODAPE_LINHA_RATIO);
  const geometriaCompleto = _geometriaGrid(doc, COLS_COMPLETO, ROWS_POR_PAGINA_COMPLETO, true, {
    areaTopoY: alturaCabecalhoPromo + GAP,
    areaFimY: A4_ALTURA - alturaRodapePromo - GAP,
  });
  // forcarQuebraEntreGrupos agora SEMPRE true, nos dois modos (antes só no
  // "fabricante" — ver comentário no call site de
  // _construirSequenciaConteudoPromocional acima sobre o bug de título
  // divergente do conteúdo que isso corrige no modo "linha"). Mesmo
  // princípio já documentado pro "fabricante": "o cabeçalho da página
  // precisa sempre corresponder a TODOS os cards que aparecem nela".
  // BUG REAL 2026-09-14 (ver comentário completo em _calcularLayoutConteudo
  // sobre `alturaRodapeReal`): passa `alturaRodapePromo` (o rodapé de
  // verdade, mais baixo, deste catálogo) em vez de deixar a função usar o
  // `FOOTER_HEIGHT` do Catálogo Completo por padrão — sem isso a última
  // linha de produtos reais de CADA página era cortada uma linha antes do
  // que cabia de verdade, e a linha vazia de "preenchimento" tomava o lugar
  // dos produtos que deveriam estar ali.
  const { posicoes, preenchimentoFinal } = _calcularLayoutConteudo(
    sequencia, geometriaCompleto, 0, true, alturaRodapePromo
  );

  let pagina = 0;

  // --- Páginas de conteúdo: sequência única e contínua entre Linhas,
  // sem blocos de cabeçalho de marca (ver _construirSequenciaConteudoPromocional) ---
  let paginaLocalAtual = -1;

  function _desenharPreenchimentoDaPagina(numeroPagina) {
    preenchimentoFinal
      .filter((p) => p.pagina === numeroPagina)
      .forEach((p) => _desenharCardVazio(doc, p.x, p.y, p.cardWidth, p.cardHeight));
  }

  for (let i = 0; i < sequencia.length; i += 1) {
    const bloco = sequencia[i];
    const pos = posicoes[i];
    if (pos.pagina !== paginaLocalAtual) {
      if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);
      paginaLocalAtual = pos.pagina;
      doc.addPage();
      pagina += 1;
      _desenharCabecalhoPromo(doc, bloco.linha, modo, logoCabecalho);
      _desenharRodapePromo(doc, pagina, modo);
    }

    if (bloco.tipo === "cardVazio") {
      _desenharCardVazio(doc, pos.x, pos.y, geometriaCompleto.cardWidth, geometriaCompleto.cardHeight);
    } else {
      const preco = precosPorCodigo?.get(String(bloco.produto.codigo)) ?? null;
      _desenharCard(
        doc, bloco.produto, pos.x, pos.y,
        geometriaCompleto.cardWidth, geometriaCompleto.cardHeight,
        geometriaCompleto.photoBoxWidth, geometriaCompleto.photoBoxHeight, true, null, preco
      );
    }

    // Ver comentário de CEDER_A_CADA_N_BLOCOS no topo do arquivo.
    if (i > 0 && i % CEDER_A_CADA_N_BLOCOS === 0) await _cederEventLoop();
  }

  if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);

  doc.end();
}

// Helpers de desenho compartilhados com os catálogos de layout próprio
// (catalogo-pdf-arielo.service.js) — função (e não objeto) pra resolver os
// nomes só na hora da chamada, depois de todo o módulo carregado.
function _interno() {
  return {
    _geometriaGrid, _desenharCardCatalogoCompleto, AREA_TOPO_Y, GAP, _desenharCardVidro, _desenharCardVazio,
    obterFoto, _agruparPorLinha, _cederEventLoop, _desenharCabecalho, _desenharRodape,
    _desenharCabecalhoIndice, _desenharLinhaIndice, _desenharFotoAjustada, _truncarParaAltura,
    TITULO_FONTE, TITULO_FONTE_ARQUIVO, RODAPE_NUMERO_FONTE, RODAPE_NUMERO_FONTE_ARQUIVO,
    A4_LARGURA, A4_ALTURA, PAGE_MARGIN, FOOTER_HEIGHT,
    INDICE_HEADER_HEIGHT, INDICE_TITULO_GAP_TOPO, INDICE_TITULO_TAMANHO, INDICE_TITULO_GAP_LINHAS, INDICE_LINHA_ALTURA,
    // Catálogo Completo contínuo (catalogo-pdf-continuo.service.js)
    _fotosUtilizaveis, _desenharFotoProtegida, _rotuloProduto, _nomeExibicao, _agruparPorMarca, _limparCodigoOemParaExibicao, _extrairEspecEletrica,
  };
}

module.exports = { gerarPdfCatalogo, gerarPdfCatalogoCompleto, gerarPdfCatalogoPromocional, carregarLogoPromocional, limparCacheBboxFotos };
