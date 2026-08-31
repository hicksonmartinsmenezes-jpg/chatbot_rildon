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
const PROMO_CABECALHO_LINHA_RATIO = 1092 / 157;
const PROMO_RODAPE_LINHA_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-rodape-linha.png"));
const PROMO_RODAPE_LINHA_RATIO = 1088 / 61;
const PROMO_CABECALHO_FABRICANTE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-cabecalho-fabricante.png"));
const PROMO_CABECALHO_FABRICANTE_RATIO = 1099 / 193;
const PROMO_RODAPE_FABRICANTE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-promocional-rodape-fabricante.png"));
const PROMO_RODAPE_FABRICANTE_RATIO = 1073 / 149;

// Área segura pro título dinâmico (fração da largura/altura do cabeçalho,
// medida pixel a pixel na arte já sem margem — mesmo princípio de
// RODAPE_NUM_X_FRACAO/Y_FRACAO abaixo): retângulo onde dá pra escrever texto
// sem invadir a faixa amarela/diagonal decorativa da arte.
const PROMO_TITULO_AREA = {
  linha: { xFrac0: 0.026, yFrac0: 0.18, xFrac1: 0.82, yFrac1: 0.72, cor: "#ffffff" },
  fabricante: { xFrac0: 0.02, yFrac0: 0.06, xFrac1: 0.67, yFrac1: 0.94, cor: "#ffffff" },
};
// Centro do texto "Página N" (fração da largura/altura do rodapé) — mesma
// técnica de RODAPE_NUM_X_FRACAO/Y_FRACAO, mas aqui o texto é "Página N"
// (não só o número) pra bater exatamente com o mockup original, na mesma
// cor escura que o mockup já usava ali.
const PROMO_PAGINA_AREA = {
  linha: { xFrac: 0.945, yFrac: 0.49, cor: "#0b3a5c" },
  fabricante: { xFrac: 0.946, yFrac: 0.72, cor: "#0b3a5c" },
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
const CABECALHO_SANGRIA_TOPO = 0;

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
const COLS = 5;
const GAP = 10;
// Largura de desenho da imagem do cabeçalho — página inteira (595.28pt em
// A4) MULTIPLICADA pelo zoom de bleed (ver CABECALHO_ESCALA_BLEED acima),
// e o X de desenho correspondente (negativo — a imagem começa um pouco
// antes da borda esquerda da página, de propósito, é o bleed).
const CABECALHO_IMG_LARGURA_DESENHO = 595.28 * CABECALHO_ESCALA_BLEED;
const CABECALHO_IMG_X_DESENHO = -CABECALHO_CONTEUDO_ESQUERDA_FRACAO * CABECALHO_IMG_LARGURA_DESENHO;
// Altura REAL/undistorcida da imagem do cabeçalho — calculada a partir da
// proporção verdadeira do arquivo e da largura de desenho acima (já com
// bleed), sem esticar/espremer o desenho (pedido do usuário original:
// "sem alterações" — o zoom aplicado é uniforme nos dois eixos, então a
// proporção da arte continua intacta). Usada só pra desenhar a imagem em
// si (ver _desenharCabecalho) — todo o resto do layout usa HEADER_HEIGHT
// (abaixo), que é a altura VISÍVEL na página (menor, por causa da
// sangria).
const CABECALHO_IMG_ALTURA_REAL = CABECALHO_IMG_LARGURA_DESENHO / CABECALHO_IMG_RATIO;
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
const GAP_FOTO_RESUMO = 13;     // respiro entre a foto e a linha de resumo
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
// Verde (em vez do azul do selo/vermelho do OEM) só pra diferenciar
// visualmente "preço" de "identificação" à primeira vista — mesmo padrão
// de caixa cheia + texto branco dos outros badges do card, só cor
// diferente. Preço é OPCIONAL por produto (usuário sobe um CSV
// código->preço próprio, nem todo código selecionado precisa vir nele) —
// sem preço pro código, o card simplesmente não desenha o badge (ver
// _desenharBadgePreco), sem placeholder feio tipo "R$ --".
const BADGE_PRECO_FUNDO = "#0f8a3c";
const BADGE_PRECO_TEXTO = "#ffffff";
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
const MARCA_HEADER_GAP_DEPOIS = 6; // espaço entre o texto do cabeçalho e a 1ª linha de cards do sub-grupo
// Pedido do usuário (2026-08-28, follow-up "se caso uma peça aparecer
// para ford e também kia, deixe os duplicados"): produto sem marca de
// veículo identificável em aplicacaoOrganizada (campo vazio, ou nenhum
// segmento no formato "MARCA: modelos") não pode sumir do catálogo
// impresso — cai num sub-grupo catch-all ao final de cada Linha, em vez
// de ser descartado.
const MARCA_OUTRAS = "OUTRAS APLICAÇÕES";

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
function _geometriaGrid(doc, cols, rows, comAplicacao = false) {
  const larguraUtil = A4_LARGURA - PAGE_MARGIN * 2;
  const cardWidth = (larguraUtil - (cols - 1) * GAP) / cols;
  const photoBoxWidth = cardWidth - PAD_CARD * 2;
  const areaTopoY = AREA_TOPO_Y;
  const areaFimY = A4_ALTURA - FOOTER_HEIGHT - 8;
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

function _bboxConteudoFoto(buffer, mimetype) {
  if (mimetype !== "image/jpeg") return null;
  let decodificada;
  try {
    decodificada = jpeg.decode(buffer, { useTArray: true });
  } catch {
    return null;
  }
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
  if (maxX < minX || maxY < minY) return null; // imagem inteiramente branca
  const conteudoLargura = maxX - minX + 1;
  const conteudoAltura = maxY - minY + 1;
  // Se o conteúdo já cobre quase o arquivo inteiro (foto normal, sem
  // margem embutida relevante), não vale mexer — evita ampliar por causa
  // de 1-2px de ruído de compressão JPEG na borda.
  if (conteudoLargura >= width * 0.97 && conteudoAltura >= height * 0.97) return null;
  return { x: minX, y: minY, width: conteudoLargura, height: conteudoAltura, imgWidth: width, imgHeight: height };
}

// Desenha a foto ajustada ao quadro (x,y,boxWidth,boxHeight) usando o
// bounding box do conteúdo real (ver _bboxConteudoFoto) em vez do tamanho
// total do arquivo — mesmo efeito de "object-fit: contain" do CSS, mas
// medido no conteúdo, não na tela toda. Sem bbox (não-JPEG, decode
// falhou, ou já preenche o arquivo quase inteiro), cai no fit antigo
// (imagem inteira). Precisa de clip porque a imagem inteira (com a
// margem branca embutida) fica MAIOR que o quadro depois do zoom no
// conteúdo — sem isso vazaria por cima dos cards vizinhos.
function _desenharFotoAjustada(doc, buffer, mimetype, x, y, boxWidth, boxHeight) {
  const bbox = _bboxConteudoFoto(buffer, mimetype);
  if (!bbox) {
    doc.image(buffer, x, y, { fit: [boxWidth, boxHeight], align: "center", valign: "center" });
    return;
  }
  const escala = Math.min(boxWidth / bbox.width, boxHeight / bbox.height);
  const larguraDesenho = bbox.imgWidth * escala;
  const alturaDesenho = bbox.imgHeight * escala;
  const xDesenho = x + (boxWidth - bbox.width * escala) / 2 - bbox.x * escala;
  const yDesenho = y + (boxHeight - bbox.height * escala) / 2 - bbox.y * escala;
  doc.save();
  doc.rect(x, y, boxWidth, boxHeight).clip();
  doc.image(buffer, xDesenho, yDesenho, { width: larguraDesenho, height: alturaDesenho });
  doc.restore();
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
// mesma padronização "MERCEDES-BENZ"/variantes -> "MB" e "VOLKSWAGEN" ->
// "VW" agora é usada em DOIS lugares — aqui, pra desenhar o texto, e em
// _extrairMarcas, pra decidir em qual sub-grupo de marca cada produto
// entra. Compartilhar a mesma função garante que o texto exibido no card
// e o cabeçalho de marca sob o qual ele é agrupado NUNCA divirjam (ex.
// produto com "Mercedes-Benz" no texto cru sempre cai no grupo "MB", e o
// texto desenhado no card também sempre mostra "MB").
function _normalizarMarcasTexto(texto) {
  return String(texto || "")
    .replace(/mercedes[-\s]*ben[zs]/gi, "MB")
    .replace(/volkswagen/gi, "VW");
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

function _desenharCardCatalogoCompleto(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, marcaAtual = null, preco = null) {
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
  // 2026-08-27: "por mais que ele seja grande nunca deixe '...' sempre
  // coloque completo nem que precise reduzir tamanho" — em vez de cortar
  // com ellipsis quando o texto não cabe em larguraMaximaSelo, encolhe o
  // fontSize até caber (_ajustarFonteSeloParaCaber); a caixa então se
  // ajusta exatamente ao texto (já garantido caber), nunca corta. Sem mais
  // descrição disputando espaço na mesma linha, o teto pode ser bem mais
  // generoso (85% em vez de 50%) — só entra em jogo em código raro/enorme.
  const larguraMaximaSelo = larguraConteudo * 0.85;
  const { tamanho: tamanhoSelo, largura: larguraTextoSelo } = _ajustarFonteSeloParaCaber(doc, rotulo, larguraMaximaSelo);
  const larguraSelo = larguraTextoSelo + CAIXA_CODIGO_PAD_H * 2 + 1.5;
  doc.font(TITULO_FONTE).fontSize(tamanhoSelo);
  const alturaLinhaSelo = doc.currentLineHeight();
  const alturaSelo = alturaLinhaSelo + CAIXA_CODIGO_PAD_V * 2;

  doc.rect(xConteudo, yTopo, larguraSelo, alturaSelo).fillColor(CAIXA_CODIGO_FUNDO).fill();
  doc.fillColor(CAIXA_CODIGO_TEXTO).font(TITULO_FONTE).fontSize(tamanhoSelo)
    .text(rotulo, xConteudo + CAIXA_CODIGO_PAD_H, yTopo + CAIXA_CODIGO_PAD_V, {
      width: larguraSelo - CAIXA_CODIGO_PAD_H * 2,
      height: alturaLinhaSelo,
      lineBreak: false,
      align: "center",
    });

  // --- Preço promocional (canto superior direito, ver _desenharBadgePreco)
  // — só desenha se `preco` foi passado (Catálogo Promocional); nos outros
  // modos (Catálogo Completo comum) preco fica null e a função não desenha
  // nada, canto continua vazio como sempre foi.
  if (preco != null) {
    _desenharBadgePreco(doc, preco, xConteudo, yTopo, larguraConteudo, larguraSelo);
  }

  // --- Código original/OEM em vermelho, embaixo do selo ---
  const oem = Array.isArray(produto.equivalentes) && produto.equivalentes.length ? produto.equivalentes[0] : null;
  if (oem) {
    doc.fillColor(OEM_COR).font("Helvetica-Bold").fontSize(OEM_FONTE)
      .text(String(oem), xConteudo, yTopo + alturaSelo + GAP_BADGE_OEM, {
        width: larguraConteudo,
        height: OEM_ALTURA,
        ellipsis: true,
        lineBreak: false,
      });
  }

  // --- Foto (abaixo do cabeçalho selo+OEM) ---
  const alturaCabecalho = alturaSelo + GAP_BADGE_OEM + OEM_ALTURA;
  const yFoto = yTopo + alturaCabecalho + GAP_HEADER_FOTO;

  try {
    const foto = obterFoto(produto.codigo, 0);
    if (foto && (foto.mimetype === "image/jpeg" || foto.mimetype === "image/png")) {
      _desenharFotoAjustada(doc, foto.buffer, foto.mimetype, xConteudo, yFoto, larguraConteudo, photoBoxHeight);
    } else {
      doc.font("Helvetica").fontSize(7).fillColor("#9ca3af")
        .text("sem foto", xConteudo, yFoto + photoBoxHeight / 2 - 5, { width: larguraConteudo, align: "center" });
    }
  } catch {
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
    // 2026-08-28: pedido do usuário "sempre que o texto couber inteiro
    // padronize ponto final" — só entra ponto quando o texto cabe INTEIRO
    // na linha (não seria cortado pelo "..." do ellipsis); texto cortado já
    // sinaliza continuação com "...", não faz sentido enfiar ponto ali.
    // pdfkit não expõe se o ellipsis disparou, então mede a largura de
    // verdade (doc.widthOfString, precisa fonte/tamanho já setados antes de
    // medir) — mesma técnica já usada em _ajustarFonteSeloParaCaber.
    doc.font(TITULO_FONTE).fontSize(RESUMO_FONTE);
    if (!/[.!?…]$/.test(resumo)) {
      const resumoComPonto = resumo + ".";
      if (doc.widthOfString(resumoComPonto) <= larguraConteudo) {
        resumo = resumoComPonto;
      }
    }
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
    const alturaDescricaoCompleta = RESUMO_ALTURA + GAP_RESUMO_APLICACAO + APLICACAO_ALTURA;
    doc.font(TITULO_FONTE).fontSize(RESUMO_FONTE);
    if (!/[.!?…]$/.test(resumo)) {
      const resumoComPonto = resumo + ".";
      if (doc.heightOfString(resumoComPonto, { width: larguraConteudo }) <= alturaDescricaoCompleta + 0.5) {
        resumo = resumoComPonto;
      }
    }
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
// Reusado por gerarPdfCatalogo (grade 5×6, catálogo comum) e
// gerarPdfCatalogoCompleto (grade 4×5, por fabricante). 2026-08-27: os dois
// modos agora têm layouts DIFERENTES (ver _desenharCardCatalogoCompleto) —
// catálogo comum mantém o desenho original (selo sobre a foto + nome
// abaixo), Catálogo Completo usa o cabeçalho novo (selo+descrição lado a
// lado + OEM em vermelho + foto maior + aplicação em preto).
function _desenharCard(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, comAplicacao = false, marcaAtual = null, preco = null) {
  _desenharCardVidro(doc, x, y, cardWidth, cardHeight);

  if (comAplicacao) {
    _desenharCardCatalogoCompleto(doc, produto, x, y, cardWidth, cardHeight, photoBoxWidth, photoBoxHeight, marcaAtual, preco);
    return;
  }

  const xFoto = x + PAD_CARD;
  const yFoto = y + PAD_CARD;

  try {
    const foto = obterFoto(produto.codigo, 0);
    if (foto && (foto.mimetype === "image/jpeg" || foto.mimetype === "image/png")) {
      _desenharFotoAjustada(doc, foto.buffer, foto.mimetype, xFoto, yFoto, photoBoxWidth, photoBoxHeight);
    } else {
      doc.font("Helvetica").fontSize(7).fillColor("#9ca3af")
        .text("sem foto", xFoto, yFoto + photoBoxHeight / 2 - 5, { width: photoBoxWidth, align: "center" });
    }
  } catch {
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
  //
  // 2026-08-28: X e largura de desenho agora usam o zoom de bleed
  // horizontal (ver CABECALHO_ESCALA_BLEED/CABECALHO_IMG_X_DESENHO acima) —
  // a imagem começa um pouco antes de x=0 e termina um pouco depois de
  // x=w, de propósito, pra empurrar a margem branca real do arquivo pra
  // fora da página nos dois lados.
  doc.image(CABECALHO_IMG, CABECALHO_IMG_X_DESENHO, -CABECALHO_SANGRIA_TOPO, { width: CABECALHO_IMG_LARGURA_DESENHO, height: CABECALHO_IMG_ALTURA_REAL });

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

// 2026-08-31 (Catálogo Promocional — ver comentário em
// PROMO_CABECALHO_LINHA_IMG acima): cabeçalho/rodapé dedicados, escolhidos
// por `modo` ("linha" | "fabricante"). Mesmo padrão de _desenharCabecalho/
// _desenharRodape (imagem cobrindo a largura inteira, altura derivada da
// proporção real do arquivo — nunca distorce), só que sem o zoom de bleed
// (os 4 arquivos já vêm sem margem branca, ver comentário acima) e com
// título/"Página N" desenhados dentro da área seguro medida em
// PROMO_TITULO_AREA/PROMO_PAGINA_AREA.
function _desenharCabecalhoPromo(doc, titulo, modo) {
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
  // Fonte auto-encolhida (mesmo princípio de _ajustarFonteSeloParaCaber):
  // nome de Linha/Fabricante é texto livre do X2, alguns são bem longos
  // (ex.: "INTERRUPTORES SENSORES E VÁLVULAS") — nunca deixa vazar pra fora
  // da área segura da arte.
  let fonte = Math.min(30, alturaArea * 0.62);
  doc.font(TITULO_FONTE);
  while (fonte > 10 && doc.fontSize(fonte).widthOfString(tituloTexto) > larguraTexto) {
    fonte -= 1;
  }
  const yTexto = yTopo + (alturaArea - fonte) / 2;
  doc.fillColor(area.cor).font(TITULO_FONTE).fontSize(fonte)
    .text(tituloTexto, x, yTexto, { width: larguraTexto, height: fonte * 1.3, ellipsis: true, lineBreak: false });

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
  doc.fillColor(area.cor).font("Helvetica-Bold").fontSize(fonteNumero)
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
function _extrairMarcas(textoOriginal) {
  if (!textoOriginal) return [];
  const texto = _normalizarMarcasTexto(textoOriginal);
  const marcas = [];
  texto.split(/;\s*/).filter(Boolean).forEach((parte) => {
    const match = parte.match(/^([^:]+):/);
    if (!match) return;
    const marca = match[1].trim().toUpperCase();
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
function _construirSequenciaConteudo(grupos) {
  const sequencia = [];
  const primeiroIndicePorGrupo = [];
  grupos.forEach(({ linha, itens }) => {
    primeiroIndicePorGrupo.push(sequencia.length);
    _agruparPorMarca(itens).forEach(({ marca, produtos }) => {
      sequencia.push({ tipo: "cabecalhoMarca", linha, marca });
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
function _construirSequenciaConteudoPromocional(grupos) {
  const sequencia = [];
  const primeiroIndicePorGrupo = [];
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
function _calcularLayoutConteudo(sequencia, geometria, alturaHeaderMarca, forcarQuebraEntreGrupos = false) {
  const { cardWidth, cardHeight, areaTopoY, areaFimY } = geometria;
  const posicoes = [];
  let pagina = -1;
  let linhaY = areaTopoY;

  // 2026-08-28 (pedido "preencha com cards vazios embaixo"): guarda o Y
  // final de CADA página assim que ela é abandonada (ver novaPagina) —
  // usado depois do loop principal pra calcular quantas linhas de card
  // vazio cabem no espaço que sobrou embaixo de cada página, não só na
  // última linha de um sub-grupo (ver preenchimentoFinal mais abaixo).
  const alturaFinalPorPagina = [];

  function novaPagina() {
    if (pagina >= 0) alturaFinalPorPagina[pagina] = linhaY;
    pagina += 1;
    linhaY = areaTopoY;
  }

  sequencia.forEach((bloco) => {
    if (bloco.tipo === "cabecalhoMarca") {
      if (pagina === -1) {
        novaPagina();
      }
      // 2026-08-28: espaço extra ANTES de um cabeçalho de marca que não é
      // o 1º bloco da página (separa visualmente do sub-grupo anterior) —
      // ver comentário em MARCA_HEADER_GAP_ANTES. Não entra quando o
      // cabeçalho já é o topo da página (logo abaixo do título da Linha),
      // pra não duplicar o respiro que TITULO_GAP_CARDS já garante ali.
      const temConteudoAcima = linhaY > areaTopoY + 0.5;
      const espacoAntes = temConteudoAcima ? MARCA_HEADER_GAP_ANTES : 0;
      if (linhaY + espacoAntes + alturaHeaderMarca + MARCA_HEADER_GAP_DEPOIS + cardHeight > areaFimY + 0.5) {
        novaPagina();
      } else {
        linhaY += espacoAntes;
      }
      posicoes.push({ pagina, x: PAGE_MARGIN, y: linhaY });
      linhaY += alturaHeaderMarca + MARCA_HEADER_GAP_DEPOIS;
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
        if (pagina === -1) {
          novaPagina();
        } else if (linhaY + cardHeight > areaFimY + 0.5) {
          novaPagina();
          headerRepetidoY = linhaY;
          linhaY += alturaHeaderMarca + MARCA_HEADER_GAP_DEPOIS;
        } else if (forcarQuebraEntreGrupos && bloco.inicioDeGrupo && linhaY > areaTopoY + 0.5) {
          // Modo "fabricante" (ver comentário em _construirSequenciaConteudoPromocional):
          // mesmo cabendo na página atual, um novo grupo (fabricante) força
          // página nova se já tem conteúdo de OUTRO grupo acima — o
          // cabeçalho da página precisa sempre corresponder a TODOS os
          // cards que aparecem nela.
          novaPagina();
        }
      }
      const x = PAGE_MARGIN + bloco.colIndex * (cardWidth + GAP);
      posicoes.push({
        pagina, x, y: linhaY,
        headerRepetidoY,
        headerRepetidoMarca: headerRepetidoY !== null ? bloco.marca : null,
      });
      if (bloco.colIndex === bloco.colsLinha - 1) {
        linhaY += cardHeight + GAP;
      }
    }
  });

  // A última página não passa por novaPagina() de novo (não tem próximo
  // bloco pra disparar a troca) — grava o Y final dela aqui, fora do loop.
  if (pagina >= 0) alturaFinalPorPagina[pagina] = linhaY;

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
  const preenchimentoFinal = [];
  alturaFinalPorPagina.forEach((yFinal, p) => {
    let y = yFinal;
    while (y + cardHeight <= areaFimY + 0.5) {
      for (let col = 0; col < COLS_COMPLETO; col += 1) {
        preenchimentoFinal.push({ pagina: p, x: PAGE_MARGIN + col * (cardWidth + GAP), y, cardWidth, cardHeight });
      }
      y += cardHeight + GAP;
    }
  });

  return { posicoes, totalPaginas: pagina + 1, preenchimentoFinal };
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

function _desenharCabecalhoMarca(doc, marca, x, y, largura, altura) {
  doc.font(TITULO_FONTE).fontSize(MARCA_HEADER_FONTE);
  _textoComSombra(doc, String(marca || "").toUpperCase(), x, y, VERMELHO_CATEGORIA, {
    width: largura,
    align: "center",
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

// Cabeçalho da(s) página(s) de índice — mesma arte de _desenharCabecalho,
// só com o título fixo "ÍNDICE" em INDICE_TITULO_TAMANHO (36pt, pedido do
// usuário) em vez do nome da busca em TITULO_TAMANHO (17pt).
function _desenharCabecalhoIndice(doc) {
  const w = doc.page.width;

  // 2026-08-28 (revertido — pedido do usuário "padronize o cabeçalho da
  // primeira pagina com o restante"): era desenhada AMPLIADA (zoom 1.08x +
  // corte simétrico nas laterais), ficando ligeiramente diferente do
  // cabeçalho das páginas de conteúdo. Agora usa exatamente a mesma
  // largura/altura/posição de _desenharCabecalho — mesma arte, mesmo zoom
  // de bleed horizontal (ver CABECALHO_ESCALA_BLEED), sem corte — só o
  // texto abaixo dela muda ("ÍNDICE" em vez do nome da busca, ver mais
  // abaixo).
  doc.image(CABECALHO_IMG, CABECALHO_IMG_X_DESENHO, -CABECALHO_SANGRIA_TOPO, { width: CABECALHO_IMG_LARGURA_DESENHO, height: CABECALHO_IMG_ALTURA_REAL });

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
  // Quicksand só é usada no card do Catálogo Completo (_desenharCardCatalogoCompleto)
  // — ver comentário em QUICKSAND_BOLD acima. gerarPdfCatalogo (modo regular/
  // busca expressa) não registra essas fontes de propósito, não é afetado.
  doc.registerFont(QUICKSAND_BOLD, QUICKSAND_BOLD_ARQUIVO);
  doc.registerFont(QUICKSAND_MEDIUM, QUICKSAND_MEDIUM_ARQUIVO);

  const grupos = _agruparPorLinha(produtos);

  // --- Pré-cálculo da paginação do índice (ver comentário acima) ---
  const larguraUtilIndice = A4_LARGURA - PAGE_MARGIN * 2;
  const areaFimYIndice = A4_ALTURA - FOOTER_HEIGHT - 8;
  const alturaDisponivelIndice = areaFimYIndice - AREA_TOPO_Y_INDICE;
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
  const { sequencia, primeiroIndicePorGrupo } = _construirSequenciaConteudo(grupos);
  const geometriaCompleto = _geometriaGrid(doc, COLS_COMPLETO, ROWS_POR_PAGINA_COMPLETO, true);
  const { posicoes, preenchimentoFinal } = _calcularLayoutConteudo(sequencia, geometriaCompleto, alturaHeaderMarca);
  const paginaInicialPorGrupo = primeiroIndicePorGrupo.map(
    (idx) => paginasIndice + 1 + posicoes[idx].pagina
  );

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

  sequencia.forEach((bloco, i) => {
    const pos = posicoes[i];
    if (pos.pagina !== paginaLocalAtual) {
      if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);
      paginaLocalAtual = pos.pagina;
      doc.addPage();
      pagina += 1;
      _desenharCabecalho(doc, bloco.linha);
      _desenharRodape(doc, pagina);
    }

    if (bloco.tipo === "cabecalhoMarca") {
      _desenharCabecalhoMarca(doc, bloco.marca, pos.x, pos.y, larguraUtilCompleto, alturaHeaderMarca);
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
          geometriaCompleto.photoBoxWidth, geometriaCompleto.photoBoxHeight, true, bloco.marca
        );
      }
    }
  });

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
function gerarPdfCatalogoPromocional(produtos, precosPorCodigo, destino, modo = "linha") {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, bufferPages: true });
  doc.pipe(destino);
  doc.registerFont(TITULO_FONTE, TITULO_FONTE_ARQUIVO);
  doc.registerFont(QUICKSAND_BOLD, QUICKSAND_BOLD_ARQUIVO);
  doc.registerFont(QUICKSAND_MEDIUM, QUICKSAND_MEDIUM_ARQUIVO);

  const grupos = modo === "fabricante" ? _agruparPorFabricante(produtos) : _agruparPorLinha(produtos);

  // 2026-08-31 (pedido do usuário: "remova sumario"): Catálogo Promocional
  // não tem mais páginas de índice/sumário — vai direto pro conteúdo. Isso
  // reverte a decisão anterior ("Mantém cabeçalho de Linha" via índice, ver
  // comentário acima no JSDoc) só pra esta função; `gerarPdfCatalogoCompleto`
  // continua com índice normalmente, não é afetado.
  const { sequencia } = _construirSequenciaConteudoPromocional(grupos);
  const geometriaCompleto = _geometriaGrid(doc, COLS_COMPLETO, ROWS_POR_PAGINA_COMPLETO, true);
  // forcarQuebraEntreGrupos só no modo "fabricante" (ver comentário em
  // _construirSequenciaConteudoPromocional) — modo "linha" mantém a
  // paginação contínua de sempre, sem quebra forçada entre Linhas.
  const { posicoes, preenchimentoFinal } = _calcularLayoutConteudo(sequencia, geometriaCompleto, 0, modo === "fabricante");

  let pagina = 0;

  // --- Páginas de conteúdo: sequência única e contínua entre Linhas,
  // sem blocos de cabeçalho de marca (ver _construirSequenciaConteudoPromocional) ---
  let paginaLocalAtual = -1;

  function _desenharPreenchimentoDaPagina(numeroPagina) {
    preenchimentoFinal
      .filter((p) => p.pagina === numeroPagina)
      .forEach((p) => _desenharCardVazio(doc, p.x, p.y, p.cardWidth, p.cardHeight));
  }

  sequencia.forEach((bloco, i) => {
    const pos = posicoes[i];
    if (pos.pagina !== paginaLocalAtual) {
      if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);
      paginaLocalAtual = pos.pagina;
      doc.addPage();
      pagina += 1;
      _desenharCabecalhoPromo(doc, bloco.linha, modo);
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
  });

  if (paginaLocalAtual !== -1) _desenharPreenchimentoDaPagina(paginaLocalAtual);

  doc.end();
}

module.exports = { gerarPdfCatalogo, gerarPdfCatalogoCompleto, gerarPdfCatalogoPromocional };
