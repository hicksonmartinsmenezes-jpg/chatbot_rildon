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
const { obterFoto } = require("./catalogo-fotos.service");

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
const CODIGO_FORNECEDOR_MAP = new Map(
  JSON.parse(fs.readFileSync(path.join(__dirname, "../config/catalogo-x2/cod-fornecedor.json"), "utf8"))
    .map(item => [String(item.codigo), item.cod_fornecedor])
);

// Carregada uma única vez no require — reusada em toda geração de PDF, sem
// I/O repetido por página.
const RODAPE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-rodape.png"));
// Proporção exata do arquivo acima (1372×156 px) — ver comentário no topo
// do arquivo sobre por que isso precisa bater com a imagem de verdade.
const RODAPE_IMG_RATIO = 1372 / 156;

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
// cabeçalho" de novo. Já não sobra margem branca de verdade pra recortar do
// arquivo sem começar a cortar a própria cunha diagonal (medido: já na 1ª
// linha de conteúdo o desenho cobre ~98% da largura e vai estreitando aos
// poucos — não é uma faixa reta, é o próprio desenho diagonal desde o
// topo). Em vez de continuar cortando pixels reais da arte, troquei de
// técnica: a imagem inteira (sem cortar mais nada, na proporção exata de
// sempre) é desenhada "sangrando" um pouco pra fora do topo da página (y
// negativo) — a parte que passa de y=0 fica invisível (a página só mostra o
// que está dentro dela), então o efeito visual é o cabeçalho parecer mais
// baixo, sem alterar/distorcer/cortar um único pixel do arquivo de verdade.
const CABECALHO_SANGRIA_TOPO = 16;

// Centro do triângulo branco da arte (pedido do usuário, 2026-07-28: número
// da página centralizado ali) — medido pixel a pixel na imagem real
// (1372×156): o triângulo tem o ápice perto de x≈1065/y≈0 e alarga pra
// baixo, ficando sempre centrado horizontalmente em x≈1060-1065. Escolhido
// y≈130 (não o fundo exato, y=155) pra sobrar respiro pro texto não
// encostar na borda inferior da página. Se a imagem do rodapé for trocada
// de novo, essas frações também precisam ser remedidas.
const RODAPE_NUM_X_FRACAO = 1062 / 1372;
const RODAPE_NUM_Y_FRACAO = 108 / 156;

const PAGE_MARGIN = 24;
// Pedido do usuário (2026-07-31): "caiba o máximo de itens possíveis" — era
// 4 colunas. Foto/fontes/respiros foram encolhidos (ver ROWS_POR_PAGINA,
// PAD_CARD, CODIGO_FONTE/CODIGO_ALTURA, NOME_FONTE/NOME_ALTURA,
// GAP_DIVISORIA_TEXTO/GAP_FOTO_DIVISORIA abaixo) pra caber 5×6 = 30
// produtos por página (era 4×4 = 16) sem descaracterizar o card (ainda tem
// foto + código + nome, cabeçalho/rodapé da marca do mesmo tamanho de
// sempre) — usuário escolheu "deixa comigo" entre um meio-termo (~30/pág)
// e um modo mais agressivo (lista sem foto).
const COLS = 5;
const GAP = 10;
// Altura REAL/undistorcida da imagem do cabeçalho — calculada a partir da
// proporção verdadeira do arquivo, largura sempre = página inteira
// (595.28pt em A4), sem esticar/espremer o desenho (pedido do usuário:
// "sem alterações"). Usada só pra desenhar a imagem em si (ver
// _desenharCabecalho) — todo o resto do layout usa HEADER_HEIGHT (abaixo),
// que é a altura VISÍVEL na página (menor, por causa da sangria).
const CABECALHO_IMG_ALTURA_REAL = 595.28 / CABECALHO_IMG_RATIO;
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
const TITULO_GAP_TOPO = 8;
// Pedido do usuário (2026-07-30, 1ª rodada): "desça mais o título, quase
// encostando nos produtos, deixe a distância parecida como a das colunas" —
// a distância entre o título e o topo dos cards é EXATAMENTE o mesmo valor
// do respiro entre colunas (GAP), em vez de um número arbitrário.
const TITULO_GAP_CARDS = GAP;

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
const CODIGO_FONTE = 8;
const CODIGO_ALTURA = 11;
const NOME_FONTE = 6;
const NOME_ALTURA = 16;  // ~2 linhas no tamanho novo
// Espaço entre a linha divisória e o bloco de texto (código+nome) — pedido
// do usuário 2026-07-30 "desça um pouco mais" (era GAP_DIVISORIA_NOME=10,
// usado quando só o nome ficava aqui; depois 12; "desça mais a descrição
// se possível" — mais uma rodada, agora 16). Nomeado como constante porque
// entra também no cálculo de alturaFixaTexto lá embaixo — evita os dois
// lugares dessincronizarem.
// 2026-07-31: reduzido de 16 pra 6 — junto com o resto do bloco de texto
// (ver comentário acima em CODIGO_FONTE), pra caber mais linhas de card.
const GAP_DIVISORIA_TEXTO = 6;
// Respiro entre o código e o nome, dentro do mesmo bloco de texto.
const GAP_CODIGO_NOME = 2; // era 3 — reduzido em 2026-07-31, mesmo motivo acima
// Respiro entre o fim da foto e a linha divisória — era um "5" hardcoded
// direto no cálculo (gerarPdfCatalogo) e em alturaFixaTexto; virou
// constante nomeada em 2026-07-31 (reduzida pra 3) pra não desencontrar os
// dois lugares, mesmo motivo do resto deste bloco.
const GAP_FOTO_DIVISORIA = 3;

// Cor do texto do código — pedido do usuário (2026-07-30): "azul oceano/
// petróleo", rgb(0, 96, 151), mais sóbrio que o azul do painel usado antes.
const AZUL = "#006097";

// Pedido do usuário (2026-07-29): "use isso de referência, preciso que
// fique exatamente assim as bordas e caixa" — cor medida pixel a pixel na
// imagem de referência (site real de e-commerce, cards de "Sensor de
// Estacionamento"): borda ciano rgb(0,174,239) = #00aeef, bem mais grossa
// que a cinza anterior.
const BORDA_CARD = "#00aeef";
const BORDA_CARD_ESPESSURA = 3; // era 1.75 (cinza) — bem mais grossa, igual à referência
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
const CAIXA_CODIGO_PAD_V = 3;

// Pedido do usuário (2026-07-28): título da seção ("AMORTECEDORES" etc.) em
// "Futura Md BT" 17pt. Fonte ainda não recebida (ver comentário em
// _desenharCabecalho) — usando Helvetica-Bold como placeholder até o
// usuário mandar o arquivo .ttf/.otf real.
const TITULO_FONTE = "Helvetica-Bold";
const TITULO_TAMANHO = 17;

// Onde o topo dos cards começa: fim da arte do cabeçalho + respiro antes do
// título + altura do título + respiro depois do título (TITULO_GAP_CARDS,
// igual ao GAP das colunas). Uma única fórmula usada tanto pra desenhar o
// título (_desenharCabecalho) quanto pra saber onde os cards começam
// (gerarPdfCatalogo) — evita os dois lugares dessincronizarem se qualquer
// uma dessas peças mudar de novo no futuro.
const AREA_TOPO_Y = HEADER_HEIGHT + TITULO_GAP_TOPO + TITULO_TAMANHO + TITULO_GAP_CARDS;

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
function _rotuloProduto(produto) {
  const codigoFornecedor =
    CODIGO_FORNECEDOR_MAP.get(String(produto.codigo)) ||
    (produto.referencia ? String(produto.referencia).split(" - ")[0].trim() : null);
  return codigoFornecedor || String(produto.codigo);
}

// Pedido do usuário (2026-07-29): "a caixa" da referência — o código do
// fabricante agora é uma CAIXA cheia (fundo azul, texto branco) sobreposta
// no canto superior esquerdo da foto, igual ao card de "Sensor de
// Estacionamento" mandado como modelo. Substitui o texto azul solto que
// existia antes (ver histórico no topo do arquivo). Largura da caixa segue
// o texto (com um mínimo/máximo), não é um tamanho fixo — evita caixa
// gigante pra código curto ou cortando código longo sem necessidade.
function _desenharCaixaCodigo(doc, produto, xFoto, yFoto, larguraMaxima) {
  const rotulo = _rotuloProduto(produto);
  doc.font("Helvetica-Bold").fontSize(CODIGO_FONTE);
  const larguraTexto = doc.widthOfString(rotulo);
  const larguraBadge = Math.min(larguraTexto + CAIXA_CODIGO_PAD_H * 2, larguraMaxima - 8);

  // Altura real da linha de texto nesse fontSize (pedido do usuário
  // 2026-07-30: "altura exata do código, se tiver espaço remova") — em vez
  // de um valor fixo, uso a métrica de verdade da fonte via
  // doc.currentLineHeight(), então a caixa nunca sobra espaço vazio em
  // cima/embaixo do texto, só o respiro mínimo de CAIXA_CODIGO_PAD_V.
  const alturaLinha = doc.currentLineHeight();
  const alturaBadge = alturaLinha + CAIXA_CODIGO_PAD_V * 2;

  const xBadge = xFoto + 4;
  const yBadge = yFoto + 4;

  doc.rect(xBadge, yBadge, larguraBadge, alturaBadge).fillColor(CAIXA_CODIGO_FUNDO).fill();
  doc.fillColor(CAIXA_CODIGO_TEXTO).font("Helvetica-Bold").fontSize(CODIGO_FONTE)
    .text(rotulo, xBadge + CAIXA_CODIGO_PAD_H, yBadge + CAIXA_CODIGO_PAD_V, {
      width: larguraBadge - CAIXA_CODIGO_PAD_H * 2,
      height: alturaLinha,
      ellipsis: true,
      lineBreak: false,
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

  doc.fillOpacity(1).strokeOpacity(1);
}

function _desenharCabecalho(doc, tituloBusca) {
  const w = doc.page.width;

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
  doc.image(CABECALHO_IMG, 0, -CABECALHO_SANGRIA_TOPO, { width: w, height: CABECALHO_IMG_ALTURA_REAL });

  // Pedido do usuário (2026-07-30): removido "RILDON PEÇAS" / "Catálogo
  // Expresso" do cabeçalho — a arte de fundo já carrega a identidade visual,
  // texto extra não é mais necessário.

  // Pedido do usuário (2026-07-28): título da seção em "Futura Md BT" 17pt.
  // Essa fonte não é uma das 14 padrão do PDF (Helvetica/Times/Courier) —
  // pdfkit só usa ela se eu tiver o arquivo .ttf/.otf pra registrar
  // (doc.registerFont). Ainda não recebi o arquivo (procurei de novo em
  // 2026-07-30, continua não existindo no projeto nem nos uploads), então
  // uso Helvetica-Bold como substituto temporário (mesmo peso visual, sem
  // itálico — a Futura não é itálica). Troca pra registerFont(caminho) assim
  // que o usuário mandar o arquivo da fonte.
  const tituloTexto = String(tituloBusca || "").toUpperCase();
  const tituloX = PAGE_MARGIN;
  // Pedido do usuário (2026-07-30, 2ª rodada): título começa SÓ DEPOIS que a
  // arte do cabeçalho termina (HEADER_HEIGHT + TITULO_GAP_TOPO) — nunca mais
  // sobreposto à imagem, então não tem como "encostar" no cinza da arte.
  const tituloY = HEADER_HEIGHT + TITULO_GAP_TOPO;
  const tituloLargura = w - PAGE_MARGIN * 2;

  // Sombra simples (pedido do usuário 2026-07-30): cópia do texto em cinza
  // escuro, levemente deslocada embaixo/direita, desenhada ANTES do texto
  // principal — pdfkit não tem blur/text-shadow nativo, então a sombra é só
  // uma 2ª cópia do texto por baixo, técnica igual à referência que o
  // usuário mandou antes (título com sombra duplicada).
  doc.fillColor("#000000", 0.35).font(TITULO_FONTE).fontSize(TITULO_TAMANHO)
    .text(tituloTexto, tituloX + 1.5, tituloY + 1.5, { width: tituloLargura });
  doc.fillOpacity(1);

  doc.fillColor(VERMELHO_CATEGORIA).font(TITULO_FONTE).fontSize(TITULO_TAMANHO)
    .text(tituloTexto, tituloX, tituloY, { width: tituloLargura });

  doc.fillColor("#111827").font("Helvetica");
}

function _desenharRodape(doc, numeroPagina) {
  const w = doc.page.width;
  const h = doc.page.height;

  // Imagem real da logo Rildon cobrindo a largura inteira da página, sem
  // distorcer (altura já calculada na proporção exata do arquivo — ver
  // RODAPE_IMG_RATIO).
  doc.image(RODAPE_IMG, 0, h - FOOTER_HEIGHT, { width: w, height: FOOTER_HEIGHT });

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

  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(fonteNumero)
    .text(String(numeroPagina), centroX - larguraCaixa / 2, yTexto, { width: larguraCaixa, align: "center", lineBreak: false });

  doc.fillColor("#111827").font("Helvetica");
}

/**
 * Gera o PDF e faz stream direto pro destino (a `res` do Express — quem
 * chama já seta os headers de Content-Type/Content-Disposition antes).
 * Não retorna Promise: o próprio doc.end() encerra a escrita/resposta.
 */
function gerarPdfCatalogo(produtos, tituloBusca, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, bufferPages: true });
  doc.pipe(destino);

  let pagina = 0;

  function novaPagina() {
    doc.addPage();
    pagina += 1;
    _desenharCabecalho(doc, tituloBusca);
    _desenharRodape(doc, pagina);
    doc.y = AREA_TOPO_Y;
  }

  novaPagina();

  const larguraUtil = doc.page.width - PAGE_MARGIN * 2;
  const cardWidth = (larguraUtil - (COLS - 1) * GAP) / COLS;
  const photoBoxWidth = cardWidth - PAD_CARD * 2;
  const areaTopoY = AREA_TOPO_Y;
  const areaFimY = doc.page.height - FOOTER_HEIGHT - 8;

  // Pedido do usuário (2026-07-28): preencher o espaço em branco que sobrava
  // no fim da página aumentando as caixas das fotos, em vez de deixar vão
  // morto. Em vez de uma altura de foto fixa, calculamos o card de trás pra
  // frente: quanto de altura total cabe em ROWS_POR_PAGINA linhas dentro do
  // espaço disponível, subtraímos tudo que é fixo (respiros + linha
  // divisória + código + nome) e o que sobra vira a altura da foto — ou
  // seja, a foto SEMPRE ocupa 100% do espaço que sobrar, sem vão embaixo.
  //
  // 2026-07-30: o código voltou a ter uma faixa de texto própria abaixo da
  // foto (era uma CAIXA sobreposta na foto, ver _desenharCaixaCodigo — não
  // usada mais aqui) — CODIGO_ALTURA volta a entrar nessa conta.
  const alturaDisponivel = areaFimY - areaTopoY;
  const cardHeightMax = (alturaDisponivel - (ROWS_POR_PAGINA - 1) * GAP) / ROWS_POR_PAGINA;
  // GAP_FOTO_DIVISORIA = respiro antes da linha divisória; GAP_DIVISORIA_TEXTO
  // = respiro dela até o código; GAP_CODIGO_NOME = respiro entre código e nome.
  const alturaFixaTexto = PAD_CARD + GAP_FOTO_DIVISORIA + GAP_DIVISORIA_TEXTO + CODIGO_ALTURA + GAP_CODIGO_NOME + NOME_ALTURA + PAD_CARD;
  const photoBoxHeight = cardHeightMax - alturaFixaTexto;
  const cardHeight = cardHeightMax;

  let col = 0;
  let linhaY = doc.y;

  produtos.forEach((produto) => {
    // Epsilon de 0.5pt: como cardHeightMax é calculado pra preencher
    // EXATAMENTE o espaço disponível (ver comentário acima), a soma
    // acumulada de ROWS_POR_PAGINA linhas bate matematicamente igual a
    // areaFimY — mas ponto flutuante às vezes fecha com um resto de
    // ~1e-13, e sem essa margem isso já disparou uma quebra de página
    // falsa na última linha (12 cards numa página + 4 sozinhos na próxima,
    // em vez dos 16 numa página só). O epsilon absorve esse resto sem
    // abrir espaço perceptível de verdade.
    if (col === 0 && linhaY + cardHeight > areaFimY + 0.5) {
      novaPagina();
      linhaY = doc.y;
    }

    const x = PAGE_MARGIN + col * (cardWidth + GAP);
    const y = linhaY;

    _desenharCardVidro(doc, x, y, cardWidth, cardHeight);

    const xFoto = x + PAD_CARD;
    const yFoto = y + PAD_CARD;

    // Pedido do usuário (2026-07-30): removido o fundo cinza clarinho atrás
    // da foto (existia desde 2026-07-28) — perguntei branco/azul-clarinho/
    // cinza mais forte e o usuário escolheu branco (ou seja, sem nenhuma cor
    // de fundo aqui, só o branco do card por baixo).
    try {
      const foto = obterFoto(produto.codigo, 0);
      if (foto && (foto.mimetype === "image/jpeg" || foto.mimetype === "image/png")) {
        doc.image(foto.buffer, xFoto, yFoto, { fit: [photoBoxWidth, photoBoxHeight], align: "center", valign: "center" });
      } else {
        doc.font("Helvetica").fontSize(7).fillColor("#9ca3af")
          .text("sem foto", xFoto, yFoto + photoBoxHeight / 2 - 5, { width: photoBoxWidth, align: "center" });
      }
    } catch {
      doc.font("Helvetica").fontSize(7).fillColor("#9ca3af")
        .text("sem foto", xFoto, yFoto + photoBoxHeight / 2 - 5, { width: photoBoxWidth, align: "center" });
    }
    doc.fillColor("#111827").font("Helvetica");

    // Linha divisória sutil separando foto de texto (pedido do usuário:
    // deixar as informações mais organizadas).
    const yDivisoria = yFoto + photoBoxHeight + GAP_FOTO_DIVISORIA;
    doc.moveTo(x + PAD_CARD, yDivisoria).lineTo(x + cardWidth - PAD_CARD, yDivisoria)
      .lineWidth(0.6).strokeColor(LINHA_DIVISORIA, 0.8).stroke();

    // Pedido do usuário (2026-07-30): "remova o código na parte de cima com
    // o background azul, vamos deixar o código junto à descrição e desça um
    // pouco mais" — tira a caixa/badge de cima da foto (v4, 2026-07-29) e
    // volta o código pra baixo, junto do nome, como texto azul (mesmo
    // formato da v2/v3 original), com mais respiro em relação à divisória.
    const yCodigo = yDivisoria + GAP_DIVISORIA_TEXTO;
    doc.fillColor(AZUL).font("Helvetica-Bold").fontSize(CODIGO_FONTE)
      .text(_rotuloProduto(produto), x + PAD_CARD, yCodigo, {
        width: cardWidth - PAD_CARD * 2,
        height: CODIGO_ALTURA,
        ellipsis: true,
      });

    // Nome (preto, negrito, maiúsculo, ~2 linhas com reticências) — 8pt
    // (pedido do usuário 2026-07-30: diminuir um pouco; era 9pt). Logo
    // abaixo do código, com um respiro pequeno entre os dois.
    const yNome = yCodigo + CODIGO_ALTURA + GAP_CODIGO_NOME;
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(NOME_FONTE)
      .text(String(produto.nome || "").toUpperCase(), x + PAD_CARD, yNome, {
        width: cardWidth - PAD_CARD * 2,
        height: NOME_ALTURA,
        ellipsis: true,
        lineGap: 0.5,
      });

    doc.font("Helvetica");

    col += 1;
    if (col >= COLS) {
      col = 0;
      linhaY += cardHeight + GAP;
    }
  });

  doc.end();
}

module.exports = { gerarPdfCatalogo };
