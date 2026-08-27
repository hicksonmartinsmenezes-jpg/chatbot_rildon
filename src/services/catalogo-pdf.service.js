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
// 2026-08-27: código voltou a ser um SELO sobre a foto (_desenharCaixaCodigo)
// — CODIGO_ALTURA e GAP_CODIGO_NOME abaixo ficaram SEM USO no bloco de texto
// (não entram mais em alturaFixaTexto nem em _desenharCard), mas mantidas
// documentadas caso o código volte a virar linha de texto solta de novo (já
// foi e voltou 2x neste arquivo — ver histórico dos comentários acima).
// CODIGO_FONTE continua em uso (fonte do texto dentro do próprio selo).
const CODIGO_FONTE = 8;
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
// valendo sozinho pro catálogo comum). Entra tanto em alturaFixaTexto
// (_geometriaGrid) quanto no cálculo de yNome (_desenharCard) — nomeada pra
// não desencontrar os dois lugares.
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
const APLICACAO_ALTURA = 20; // ~3 linhas nesse tamanho
// 2026-08-27: usuário pediu "desça mais as aplicações no card" — era 3,
// mais respiro entre o fim do nome e o início do bloco de aplicação.
const APLICACAO_GAP = 9;     // respiro entre o nome e esse bloco
const APLICACAO_COR = "#4b5563";

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
const INDICE_CABECALHO_ESCALA = 1.08;
const INDICE_CABECALHO_IMG_ALTURA_REAL = (A4_LARGURA * INDICE_CABECALHO_ESCALA) / CABECALHO_IMG_RATIO;
const INDICE_CABECALHO_SANGRIA_TOPO = CABECALHO_SANGRIA_TOPO * INDICE_CABECALHO_ESCALA;
const INDICE_HEADER_HEIGHT = INDICE_CABECALHO_IMG_ALTURA_REAL - INDICE_CABECALHO_SANGRIA_TOPO;

// Pedido do usuário (2026-08-26): mais respiro entre o cabeçalho e o título
// "ÍNDICE", e entre o título e a 1ª linha da lista — valores escolhidos
// (não pedidos em pt exatos) bem maiores que os respiros padrão
// (TITULO_GAP_TOPO=8 / TITULO_GAP_CARDS=10) usados no resto do PDF.
const INDICE_TITULO_GAP_TOPO = 26;
const INDICE_TITULO_GAP_LINHAS = 34;

// Início da área de conteúdo da página de índice — mesma lógica de
// AREA_TOPO_Y acima, só com as constantes maiores específicas do índice
// (cabeçalho/respiros/título) em vez das compartilhadas.
const AREA_TOPO_Y_INDICE = INDICE_HEADER_HEIGHT + INDICE_TITULO_GAP_TOPO + INDICE_TITULO_TAMANHO + INDICE_TITULO_GAP_LINHAS;

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

// Extraído de gerarPdfCatalogo (2026-08-26, Issue #21) pra ser reusado
// também por gerarPdfCatalogoCompleto — mesma matemática de sempre (foto
// preenche 100% do espaço que sobra depois de descontar o bloco fixo de
// texto), só parametrizada por cols/rows em vez de usar COLS/ROWS_POR_PAGINA
// direto, pra caber tanto a grade 5×6 padrão quanto a 4×5 do modo completo
// sem duplicar a função.
function _geometriaGrid(doc, cols, rows, comAplicacao = false) {
  const larguraUtil = doc.page.width - PAGE_MARGIN * 2;
  const cardWidth = (larguraUtil - (cols - 1) * GAP) / cols;
  const photoBoxWidth = cardWidth - PAD_CARD * 2;
  const areaTopoY = AREA_TOPO_Y;
  const areaFimY = doc.page.height - FOOTER_HEIGHT - 8;
  const alturaDisponivel = areaFimY - areaTopoY;
  const cardHeightMax = (alturaDisponivel - (rows - 1) * GAP) / rows;
  // Issue #23: bloco extra de "aplicação organizada" (só no Catálogo
  // Completo, comAplicacao=true) soma altura fixa reservada — a foto
  // encolhe um pouco pra abrir espaço, igual ao princípio já usado pro
  // resto do bloco de texto (nome) desde a v3.
  // 2026-08-27: código voltou a ser um SELO sobreposto no canto superior
  // esquerdo da foto (_desenharCaixaCodigo) em vez de uma linha de texto
  // própria abaixo da foto — CODIGO_ALTURA/GAP_CODIGO_NOME saíram da conta
  // (o selo não ocupa altura fixa do bloco de texto, fica por cima da
  // foto), o que também aumenta a caixa de foto disponível, como pedido.
  const alturaFixaTexto = PAD_CARD + GAP_FOTO_DIVISORIA + GAP_DIVISORIA_TEXTO + NOME_ALTURA
    + (comAplicacao ? GAP_DIVISORIA_TEXTO_EXTRA_COMPLETO + APLICACAO_GAP + APLICACAO_ALTURA : 0)
    + PAD_CARD;
  const photoBoxHeight = cardHeightMax - alturaFixaTexto;
  const cardHeight = cardHeightMax;
  return { cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, areaTopoY, areaFimY };
}

// Extraído de gerarPdfCatalogo (2026-08-26, Issue #21) — desenha um card de
// produto completo (moldura + foto + divisória + código + nome) em x/y
// dados, sem saber nada sobre grade/paginação. Reusado por gerarPdfCatalogo
// (grade 5×6) e gerarPdfCatalogoCompleto (grade 4×5) — comportamento
// idêntico ao que já existia antes da extração, só parametrizado.
function _desenharCard(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, comAplicacao = false) {
  _desenharCardVidro(doc, x, y, cardWidth, cardHeight);

  const xFoto = x + PAD_CARD;
  const yFoto = y + PAD_CARD;

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

  // 2026-08-27 (pedido do usuário, testando o Catálogo Completo impresso):
  // código de volta como SELO sobreposto no canto superior esquerdo da foto
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
  // 2026-08-27: "desça mais um pouco" (pedido específico sobre o card do
  // Catálogo Completo) — só nesse modo (comAplicacao=true) soma um respiro
  // extra; o catálogo padrão (busca/seleção manual, sem bloco de aplicação)
  // continua com o espaçamento de sempre, sem esse ajuste.
  const yNome = yDivisoria + GAP_DIVISORIA_TEXTO + (comAplicacao ? GAP_DIVISORIA_TEXTO_EXTRA_COMPLETO : 0);
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(NOME_FONTE)
    .text(_nomeExibicao(produto, comAplicacao).toUpperCase(), x + PAD_CARD, yNome, {
      width: cardWidth - PAD_CARD * 2,
      height: NOME_ALTURA,
      ellipsis: true,
      lineGap: 0.5,
    });

  // Issue #23 (2026-08-26): bloco de aplicação já organizada pela IA (ver
  // catalogo-aplicacao-ia.service.js) — só desenha texto se
  // `produto.aplicacaoOrganizada` já estiver preenchido (cache hit); sem
  // isso, o espaço reservado por APLICACAO_ALTURA em _geometriaGrid fica
  // simplesmente em branco (nunca quebra o layout, nunca mostra "undefined").
  if (comAplicacao && produto.aplicacaoOrganizada) {
    const yAplicacao = yNome + NOME_ALTURA + APLICACAO_GAP;
    doc.fillColor(APLICACAO_COR).font("Helvetica").fontSize(APLICACAO_FONTE)
      .text(produto.aplicacaoOrganizada, x + PAD_CARD, yAplicacao, {
        width: cardWidth - PAD_CARD * 2,
        height: APLICACAO_ALTURA,
        ellipsis: true,
        lineGap: 0.5,
      });
  }

  doc.font("Helvetica");
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
  // Fonte registrada no doc via doc.registerFont em gerarPdfCatalogo (uma
  // vez por documento, antes da 1ª página) — ver TITULO_FONTE_ARQUIVO/
  // TITULO_FONTE no topo do arquivo.
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

// Cabeçalho da(s) página(s) de índice — mesma arte de _desenharCabecalho,
// só com o título fixo "ÍNDICE" em INDICE_TITULO_TAMANHO (36pt, pedido do
// usuário) em vez do nome da busca em TITULO_TAMANHO (17pt).
function _desenharCabecalhoIndice(doc) {
  const w = doc.page.width;

  // Pedido do usuário (2026-08-26): "aumente o cabeçalho colando os lados
  // na margem da página" — a arte é desenhada AMPLIADA (INDICE_CABECALHO_ESCALA)
  // e centralizada horizontalmente; como a largura ampliada é maior que a
  // página, os dois lados sangram simetricamente pra fora e a borda da
  // própria página corta exatamente em x=0/x=w — visualmente fica "grudado"
  // nas duas margens, sem gap branco, sem distorcer a arte original.
  const larguraAmpliada = w * INDICE_CABECALHO_ESCALA;
  const xAmpliada = -(larguraAmpliada - w) / 2;
  doc.image(CABECALHO_IMG, xAmpliada, -INDICE_CABECALHO_SANGRIA_TOPO, { width: larguraAmpliada, height: INDICE_CABECALHO_IMG_ALTURA_REAL });

  const tituloTexto = "ÍNDICE";
  const tituloX = PAGE_MARGIN;
  // Pedido do usuário (2026-08-26): respiro maior entre o cabeçalho e o
  // título "ÍNDICE" — INDICE_TITULO_GAP_TOPO em vez do TITULO_GAP_TOPO
  // compartilhado (8pt) usado no resto do PDF.
  const tituloY = INDICE_HEADER_HEIGHT + INDICE_TITULO_GAP_TOPO;
  const tituloLargura = w - PAGE_MARGIN * 2;

  // Pedido do usuário (2026-08-26): título "ÍNDICE" centralizado na página
  // (só ele — o resto do cabeçalho/linhas do índice continua como estava).
  doc.font(TITULO_FONTE).fontSize(INDICE_TITULO_TAMANHO);
  _textoComSombra(doc, tituloTexto, tituloX, tituloY, VERMELHO_CATEGORIA, { width: tituloLargura, align: "center" });

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

  doc.font(TITULO_FONTE).fontSize(INDICE_LINHA_TAMANHO);
  const opcoesNome = {
    width: larguraNomeMax,
    height: INDICE_LINHA_TAMANHO + 4,
    ellipsis: true,
    lineBreak: false,
  };
  _textoComSombra(doc, nomeUpper, xEsquerda, y, VERMELHO_CATEGORIA, opcoesNome);

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
function gerarPdfCatalogo(produtos, tituloBusca, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, bufferPages: true });
  doc.pipe(destino);
  // Registrada uma vez por documento — precisa vir antes de qualquer
  // doc.font(TITULO_FONTE) (ver _desenharCabecalho).
  doc.registerFont(TITULO_FONTE, TITULO_FONTE_ARQUIVO);

  let pagina = 0;

  function novaPagina() {
    doc.addPage();
    pagina += 1;
    _desenharCabecalho(doc, tituloBusca);
    _desenharRodape(doc, pagina);
    doc.y = AREA_TOPO_Y;
  }

  novaPagina();

  // 2026-08-26 (Issue #21): matemática de grade extraída pra _geometriaGrid
  // (reusada também por gerarPdfCatalogoCompleto) — mesmo cálculo de
  // sempre, só que agora numa função parametrizada por cols/rows em vez de
  // usar COLS/ROWS_POR_PAGINA direto aqui dentro.
  const { cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, areaFimY } =
    _geometriaGrid(doc, COLS, ROWS_POR_PAGINA);

  let col = 0;
  let linhaY = doc.y;

  produtos.forEach((produto) => {
    // Epsilon de 0.5pt: como cardHeight é calculado pra preencher
    // EXATAMENTE o espaço disponível (ver _geometriaGrid), a soma
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

    _desenharCard(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight);

    col += 1;
    if (col >= COLS) {
      col = 0;
      linhaY += cardHeight + GAP;
    }
  });

  doc.end();
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
function gerarPdfCatalogoCompleto(produtos, fabricante, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, bufferPages: true });
  doc.pipe(destino);
  doc.registerFont(TITULO_FONTE, TITULO_FONTE_ARQUIVO);

  const grupos = _agruparPorLinha(produtos);
  const itensPorPagina = COLS_COMPLETO * ROWS_POR_PAGINA_COMPLETO;

  // --- Pré-cálculo da paginação do índice (ver comentário acima) ---
  const larguraUtilIndice = A4_LARGURA - PAGE_MARGIN * 2;
  const areaFimYIndice = A4_ALTURA - FOOTER_HEIGHT - 8;
  const alturaDisponivelIndice = areaFimYIndice - AREA_TOPO_Y_INDICE;
  const linhasPorPaginaIndice = Math.max(1, Math.floor(alturaDisponivelIndice / INDICE_LINHA_ALTURA));
  const paginasIndice = Math.max(1, Math.ceil(grupos.length / linhasPorPaginaIndice));

  let paginaAtual = paginasIndice + 1;
  const paginaInicialPorGrupo = grupos.map((grupo) => {
    const inicio = paginaAtual;
    paginaAtual += Math.ceil(grupo.itens.length / itensPorPagina);
    return inicio;
  });

  let pagina = 0;

  // --- Páginas de índice ---
  for (let p = 0; p < paginasIndice; p += 1) {
    doc.addPage();
    pagina += 1;
    _desenharCabecalhoIndice(doc);
    _desenharRodape(doc, pagina);

    const offset = p * linhasPorPaginaIndice;
    const linhasDestaPagina = grupos.slice(offset, offset + linhasPorPaginaIndice);
    let y = AREA_TOPO_Y_INDICE;
    linhasDestaPagina.forEach((grupo, i) => {
      _desenharLinhaIndice(doc, grupo.linha, paginaInicialPorGrupo[offset + i], y, larguraUtilIndice);
      y += INDICE_LINHA_ALTURA;
    });
  }

  // --- Páginas de conteúdo, uma seção por Linha ---
  grupos.forEach((grupo) => {
    let col = 0;
    let linhaY = 0;
    let geometria = null;

    function novaPaginaGrupo() {
      doc.addPage();
      pagina += 1;
      _desenharCabecalho(doc, grupo.linha);
      _desenharRodape(doc, pagina);
      geometria = _geometriaGrid(doc, COLS_COMPLETO, ROWS_POR_PAGINA_COMPLETO, true);
      linhaY = geometria.areaTopoY;
    }

    novaPaginaGrupo();

    grupo.itens.forEach((produto) => {
      if (col === 0 && linhaY + geometria.cardHeight > geometria.areaFimY + 0.5) {
        novaPaginaGrupo();
      }

      const x = PAGE_MARGIN + col * (geometria.cardWidth + GAP);
      const y = linhaY;

      _desenharCard(doc, produto, x, y, geometria.cardWidth, geometria.cardHeight, geometria.photoBoxWidth, geometria.photoBoxHeight, true);

      col += 1;
      if (col >= COLS_COMPLETO) {
        col = 0;
        linhaY += geometria.cardHeight + GAP;
      }
    });
  });

  doc.end();
}

module.exports = { gerarPdfCatalogo, gerarPdfCatalogoCompleto };
