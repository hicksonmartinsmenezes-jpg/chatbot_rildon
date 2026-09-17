/**
 * Exportação do relatório de métricas.
 * Layout A4 compacto e orientado para impressão, mantendo o papel timbrado
 * e os dados já fornecidos por metrics.service.js.
 *
 * ════════════════════════════════════════════════════════════════════════
 * GUIA RÁPIDO PRA QUEM VAI MEXER NESTE ARQUIVO
 * ════════════════════════════════════════════════════════════════════════
 *
 * COMO É CHAMADO:
 *   metrics.routes.js chama gerarPdfMetricas(data, destino) — `data` é o
 *   objeto retornado por buscarMetricas() em metrics.service.js (já pronto,
 *   com todos os números calculados), `destino` é um stream onde o PDF é
 *   escrito (um PassThrough, no caso da rota de exportar). Este arquivo NÃO
 *   faz nenhuma query nem cálculo de negócio — só desenha o que já vem
 *   pronto em `data`.
 *
 * SISTEMA DE COORDENADAS (a parte que mais confunde quem nunca mexeu em PDF):
 *   - Origem (0,0) é o CANTO SUPERIOR ESQUERDO da página (diferente de
 *     matemática/gráfico normal). Y cresce PRA BAIXO.
 *   - Unidade é "pt" (ponto tipográfico, 1/72 polegada) — NÃO É PIXEL.
 *     Uma folha A4 tem 595.28 x 841.89 pt (guardado em doc.page.width/
 *     height depois que a página existe — ver comentário no "BUG
 *     CORRIGIDO" mais abaixo sobre por que não dá pra ler isso antes do
 *     1º addPage()).
 *   - Toda função de desenho aqui recebe (x, y, largura, ...) e desenha a
 *     partir do canto superior esquerdo daquele elemento.
 *
 * ESTRUTURA DO RELATÓRIO (o que sai em cada página):
 *   PÁGINA 1 — "Resumo de <mês>" (grade de cards KPI) → "Comparação com o
 *     mês anterior" + "Distribuição de notas de satisfação" (lado a lado)
 *     → "Atendentes" (tabela larga).
 *   PÁGINA 2 — "Satisfação por atendente" → "O que os clientes disseram"
 *     (feedbacks de nota baixa) → "Atendimentos nos últimos 6 meses"
 *     (gráfico de barras). Esse último só cai pra uma PÁGINA 3 se não
 *     sobrar espaço na 2 (ver o `if` logo antes de chamar graficoBarras).
 *   Cabeçalho (logo + título + subtítulo) e rodapé (nº da página) se
 *   repetem em toda página nova — ver a função pagina(n) dentro de
 *   gerarPdfMetricas.
 *
 * PRA MUDANÇAS COMUNS:
 *   - Mudar cor de algo → é quase sempre uma das constantes de cor lá
 *     embaixo (AZUL, VERDE, VERMELHO, TEXTO, SEC...), não um valor solto
 *     no meio do código.
 *   - Mudar espaçamento entre elementos → procure a constante `gap` (8pt,
 *     dentro de gerarPdfMetricas) ou os números somados/multiplicados nas
 *     contas de posição (ex: `cardsY + Math.floor(i / 4) * (cardH + gap)`).
 *   - Adicionar/remover um card do resumo → edite o array `valores` (ver
 *     comentário "PÁGINA 1"), cada linha é
 *     [título, valor, cor?, trend?] — cor e trend são opcionais.
 *   - Adicionar/remover uma coluna de tabela → as tabelas usam a função
 *     genérica tabela(x, y, w, colunas, frac, linhas, opts) — `frac` é a
 *     fração da largura total que cada coluna ocupa (tem que somar ~1).
 *   - As linhas de comentário começando com "Pedido do usuário" ou "BUG
 *     CORRIGIDO" são o HISTÓRICO de por que cada coisa é do jeito que é —
 *     não são instrução de uso, são contexto pra não desfazer sem querer
 *     um ajuste que já foi pedido antes.
 * ════════════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

// Imagem de fundo (papel timbrado) usada em toda página — ver _fundo().
const FUNDO_IMG = fs.readFileSync(path.join(__dirname, "../assets/metricas-papel-timbrado.png"));
// Margem lateral/de conteúdo usada em quase toda função de desenho deste
// arquivo (x = MARGIN, largura útil = doc.page.width - MARGIN*2).
const MARGIN = 36;
// Pedido do usuário (2026-09-16, com print do PDF real): título/subtítulo
// estavam desenhados em y=45/72 — dentro da faixa azul do papel timbrado
// (o "RILDON" do logo), sobrepondo o texto. A faixa azul + onda do papel
// timbrado só libera a partir de ~93pt (11% dos 841.89pt de altura do A4 —
// medido por pixel no arquivo fonte, ver metricas-papel-timbrado.png).
// TITULO_Y/SUBTITULO_Y ficam abaixo dessa linha; TOP (onde a 1ª faixa de
// conteúdo — "Resumo do mês" — começa) desce mais ainda, dando respiro
// depois do subtítulo em vez de colar em cima dele.
// 2026-09-16 (pedido do usuário, 2ª rodada: "desça bem mais por favor") —
// primeiro ajuste (112/136/168) só tirou da faixa azul; usuário pediu mais
// espaço ainda. Valores bem mais baixos, com folga de sobra até o rodapé
// (conteúdo da página 1 termina bem antes dos ~794pt úteis do A4).
const TITULO_Y = 170;      // y do título "RELATÓRIO DE MÉTRICAS" (ver _cabecalho)
const SUBTITULO_Y = 196;   // y da linha "Gerado em .../Métricas de ..." (ver _cabecalho)
const TOP = 230;           // y onde a 1ª faixa de conteúdo de cada página começa
const BOTTOM = 48;         // distância do rodapé (nº de página) até a borda inferior
// Paleta de cores — mude aqui, não em valores soltos no meio do código.
const AZUL = "#006097";        // cor de destaque (barras do gráfico)
const AZUL_TITULO = "#1c4894"; // fundo de título com destaque (título principal + faixas de seção) — texto sempre branco em cima
const AZUL_BORDA = "#d6e5ee";  // borda fina dos cards
const TEXTO = "#263238";       // cor de texto padrão (quase preto)
const SEC = "#66717b";         // cor de texto secundário (rótulos, legendas)
const LINHA = "#e3e8ec";       // linhas divisórias de tabela
const CARD = "#ffffff";        // fundo dos cards KPI
const CINZA = "#f5f7f9";       // fundo do cabeçalho das tabelas
const VERDE = "#16803c";       // valor/variação "boa" (ver _tendenciaInfo/_corTendencia)
const VERMELHO = "#c62828";    // valor/variação "ruim"

const MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

/**
 * "2026-09" → "Setembro/2026". Usado no título "Resumo de <mês>" e no
 * subtítulo do cabeçalho quando o PDF é de um mês histórico (data.mesRef
 * preenchido — ver gerarPdfMetricas).
 */
function _nomeMes(mesRef) {
  const [ano, mes] = String(mesRef).split("-").map(Number);
  return `${MESES_PT[mes - 1]}/${ano}`;
}

/**
 * "2026-09" → "Set/26" (rótulo curto pro eixo do gráfico de barras).
 * Pedido do usuário (2026-09-17): rótulo curto pro eixo do gráfico "Atendimentos
 * nos últimos 6 meses" — abreviação de 3 letras + ano com 2
 * dígitos, formato compacto o bastante pra 6 barras lado a lado sem
 * sobrepor texto.
 */
function _rotuloMesCurto(mesStr) {
  const [ano, mes] = String(mesStr).split("-").map(Number);
  return `${MESES_PT[mes - 1].slice(0, 3)}/${String(ano).slice(2)}`;
}

/**
 * Formata um número de MINUTOS pra exibição: "45" → "45 min", "125" →
 * "2h05", "120" → "2h" (sem minutos quando é hora cheia). `null`/`undefined`
 * vira "sem dados". Usado nos cards e tabela de TMA/TME.
 */
function _formatarMin(min) {
  if (min == null) return "sem dados";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// Pedido do usuário (2026-09-16): "aos que tem referencia do mês anterior
// [...] coloque uma cor verde ou vermelho caso inferior" — antes a variação
// (ex: "+870%") ia colada no mesmo texto/cor do valor principal do card,
// sem destaque. Retorna { texto, bom } pra cartao() desenhar a variação
// separada, menor e colorida. `invertido=true` é pra métricas onde SUBIR é
// RUIM (tempo de resolução/resposta — demorar mais não é bom), mesmo
// critério já usado no painel ao vivo (metricTrendHtml em 05-metrics.js).
//
// Pedido do usuário (2026-09-17, print real com "+178% vs mês ant." no card
// de Tempo de resolução): "seria mais rapido ou mais lento que o mes
// anterior?" — pra métricas de tempo, "+178%" sozinho exige o leitor saber
// de cabeça que invertido=true significa "subir é ruim", o que não é óbvio
// batendo o olho no card. `rotulos = [textoBom, textoRuim]` troca o "vs mês
// ant." genérico por uma palavra que já responde a pergunta direto (ex:
// "178% mais lento").
/**
 * @param {number|null} pct - variação percentual vs mês anterior (pode ser negativo).
 * @param {boolean} invertido - true pras métricas onde SUBIR é ruim (tempo
 *   de resolução/resposta). false (padrão) é o caso normal onde subir é bom
 *   (atendimentos, taxa de resolução).
 * @param {[string,string]|null} rotulos - opcional [textoSeBom, textoSeRuim]
 *   pra trocar o "+X% vs mês ant." genérico por uma frase pronta (ex:
 *   ["mais rápido", "mais lento"]).
 * @returns {{texto:string, bom:boolean|null}|null} `bom` é usado por
 *   cartao() pra escolher a cor (VERDE/VERMELHO/SEC); null quando pct === 0
 *   (nem melhorou nem piorou). Retorna null (sem desenhar nada) se pct for
 *   null/undefined (dado não disponível).
 */
function _tendenciaInfo(pct, invertido = false, rotulos = null) {
  if (pct == null) return null;
  if (pct === 0) return { texto: "= vs mês ant.", bom: null };
  const subiu = pct > 0;
  const bom = invertido ? !subiu : subiu;
  if (rotulos) {
    return { texto: `${Math.abs(pct)}% ${bom ? rotulos[0] : rotulos[1]}`, bom };
  }
  return { texto: `${subiu ? "+" : ""}${pct}% vs mês ant.`, bom };
}

// Mesmo critério de _tendenciaInfo, só que devolvendo direto a cor — usado
// pra colorir a coluna "Variação" da tabela "Comparação com o mês anterior"
// (pedido do usuário: "deixe comparações com mes anterior de uma forma que
// seja mais entendivel" — cor verde/vermelho deixa claro de cara se aquele
// número foi bom ou ruim, sem precisar interpretar o sinal do %/pp).
/**
 * Igual _tendenciaInfo, mas devolve só a cor (VERDE/VERMELHO/SEC), sem
 * texto — usado em tabela() via opts.coresUltimaCol (colore a última
 * coluna, "Variação", por linha).
 */
function _corTendencia(valor, invertido = false) {
  if (valor == null || valor === 0) return SEC;
  const subiu = valor > 0;
  const bom = invertido ? !subiu : subiu;
  return bom ? VERDE : VERMELHO;
}

// Pedido do usuário (2026-09-16): "horario de pico deixe no formato de hora
// mesmo, por exemplo 10:30am" — porHora só tem granularidade de HORA (sem
// minuto, ver EXTRACT(HOUR ...) em metrics.service.js), então os minutos
// exibidos são sempre ":00"; o pedido em si é sobre usar hora cheia em
// formato 12h com am/pm em vez de "10h".
/** "14" → "2:00pm". Só recebe a HORA (sem minuto — porHora só tem essa granularidade). */
function _formatarHora12(hora) {
  const h = Number(hora);
  const periodo = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00${periodo}`;
}

/** Desenha a imagem de fundo (papel timbrado) cobrindo a página inteira (full-bleed). Chamada 1x por página, dentro de pagina(n). */
function _fundo(doc) {
  doc.image(FUNDO_IMG, 0, 0, { width: doc.page.width, height: doc.page.height });
}

/**
 * Desenha o título "RELATÓRIO DE MÉTRICAS" + a linha de subtítulo (data de
 * geração / mês do relatório) em TITULO_Y/SUBTITULO_Y. NÃO desenha o fundo
 * (isso é _fundo) nem o logo (isso já vem embutido na imagem de fundo).
 * Se quiser um fundo colorido atrás do título, use
 * `doc.rect(x, y, w, h).fillColor(cor).fill()` ANTES desta chamada de
 * `.text(...)` — PDFKit não tem um método `.background()` encadeável.
 */
function _cabecalho(doc, subtitulo) {
  const w = doc.page.width - MARGIN * 2;
  const tituloTexto = "RELATÓRIO DE MÉTRICAS";
  const tituloFonte = "Helvetica-Bold";
  const tituloTamanho = 18;

  // Fundo "grudado" no título (em vez de uma faixa cobrindo a página
  // inteira): mede a largura REAL do texto com doc.widthOfString() — por
  // isso precisa setar a mesma fonte/tamanho do título ANTES de medir,
  // senão a medida sai errada — soma um respiro (padding) e centraliza o
  // retângulo em cima disso. Se o texto do título mudar um dia, o fundo se
  // reajusta sozinho (não é um número fixo).
  // Cor escura (AZUL_TITULO) → texto precisa ficar branco (#ffffff) em
  // cima, senão o texto some. Se trocar pra uma cor clara, troque o
  // fillColor do título de volta pra algo escuro (ex: "#000000").
  // Pedido do usuário (2026-09-17): todo título com fundo (este + as
  // "faixas" de seção, ver faixa() logo abaixo) usa a MESMA cor —
  // AZUL_TITULO — e o mesmo texto branco centralizado. Trocar a cor aqui
  // significa trocar a constante AZUL_TITULO lá em cima, não este valor.
  const paddingX = 14;
  const paddingY = 6;
  // PDFKit ancora o texto pela linha inteira (que reserva espaço pra
  // acento — "Ó"/"É" do título sobem mais que letra maiúscula normal),
  // não pelo topo da tinta visível. Sem esse ajuste, a letra fica
  // encostada perto do topo da caixa e sobra espaço embaixo (medido no
  // PDF renderizado: ~2pt em cima vs ~11pt embaixo). Esse deslocamento
  // sobe a caixa pra igualar o respiro dos dois lados — se trocar a
  // fonte/tamanho do título, meça de novo e reajuste este valor.
  const ajusteVertical = 4.5;
  doc.font(tituloFonte).fontSize(tituloTamanho);
  const tituloLargura = doc.widthOfString(tituloTexto);
  const fundoW = tituloLargura + paddingX * 2;
  const fundoH = tituloTamanho + paddingY * 2;
  const fundoX = MARGIN + (w - fundoW) / 2;
  doc.rect(fundoX, TITULO_Y - paddingY - ajusteVertical, fundoW, fundoH).fillColor(AZUL_TITULO).fill();

  doc.fillColor("#ffffff").font(tituloFonte).fontSize(tituloTamanho)
    .text(tituloTexto, MARGIN, TITULO_Y, { width: w, align: "center", lineBreak: false });
  doc.fillColor(SEC).font("Helvetica").fontSize(9)
    .text(subtitulo, MARGIN, SUBTITULO_Y, { width: w, align: "center", lineBreak: false });
}

/** Desenha "Página N" centralizado, a BOTTOM pt do fim da página. */
function _rodape(doc, pagina) {
  doc.fillColor("#7a838b").font("Helvetica").fontSize(8)
    .text(`Página ${pagina}`, MARGIN, doc.page.height - BOTTOM, { width: doc.page.width - MARGIN * 2, align: "center", lineBreak: false });
}

/**
 * Monta o PDF inteiro e escreve no stream `destino`. Ver o "GUIA RÁPIDO" no
 * topo do arquivo pra estrutura geral (páginas, coordenadas) — daqui pra
 * baixo, cada helper interno (pagina/faixa/cartao/tabela/graficoBarras) tem
 * seu próprio comentário logo acima da definição.
 * @param {object} data - retorno de buscarMetricas() em metrics.service.js.
 * @param {NodeJS.WritableStream} destino - onde o PDF gerado é escrito (doc.pipe(destino)).
 */
function gerarPdfMetricas(data, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  doc.pipe(destino);

  const historico = !!data.mesRef;
  const agora = new Date();
  const geradoEm = agora.toLocaleDateString("pt-BR") + " " + agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  // Pedido do usuário (2026-09-16): "resumo do mês deveria mostrar qual mês
  // especificamente" — nomeMesExibido cobre os dois casos: com mesRef (PDF
  // histórico) usa o mês escolhido; sem mesRef (mês corrente, comportamento
  // de sempre) usa o mês/ano de "agora", já que é esse o mês que
  // metrics.service.js usou pra calcular tudo quando nenhum mês é passado.
  const nomeMesExibido = historico ? _nomeMes(data.mesRef) : `${MESES_PT[agora.getMonth()]}/${agora.getFullYear()}`;
  const subtitulo = historico ? `Métricas de ${nomeMesExibido}  •  gerado em ${geradoEm}` : `Gerado em ${geradoEm}`;
  const gap = 8;

  /**
   * Abre uma página nova: adiciona a página no doc, desenha o fundo (papel
   * timbrado), o cabeçalho (título+subtítulo) e o rodapé ("Página n").
   * SEMPRE chame isso pra começar uma página — nunca doc.addPage() direto,
   * senão a página fica sem papel timbrado/cabeçalho/rodapé.
   * @param {number} n - número da página, só pro rodapé ("Página n").
   */
  function pagina(n) {
    doc.addPage();
    _fundo(doc);
    _cabecalho(doc, subtitulo);
    _rodape(doc, n);
  }

  /**
   * Desenha uma "faixa" — a barra com título em negrito que antecede cada
   * bloco de conteúdo (ex: "Resumo de Setembro/2026", "Atendentes"). Tem
   * altura FIXA de 22pt; o conteúdo abaixo dela deve começar em `y + 27`
   * (22 de altura + ~5 de respiro), esse "+27" é repetido no código toda
   * vez que uma tabela/gráfico vem logo abaixo de uma faixa.
   * Pedido do usuário (2026-09-17): mesma cor/estilo do título principal
   * (_cabecalho) — fundo AZUL_TITULO, texto branco, CENTRALIZADO na faixa
   * (antes era fundo AZUL_CLARO, texto AZUL, alinhado à esquerda com
   * x+9). Aqui não precisa medir o texto (doc.widthOfString) igual no
   * título principal porque o fundo já é a largura inteira `w` passada —
   * só troca align:"left" (implícito) por align:"center".
   * @param {string} titulo
   * @param {number} x, y - canto superior esquerdo.
   * @param {number} w - largura da faixa.
   */
  function faixa(titulo, x, y, w) {
    doc.roundedRect(x, y, w, 22, 4).fillColor(AZUL_TITULO).fill();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10.5)
      .text(titulo, x, y + 6, { width: w, align: "center", lineBreak: false });
  }

  // Pedido do usuário (2026-09-17): títulos como "TMA (Tempo Médio
  // Atendimento)" não cabem numa linha só na largura do card — apesar de
  // lineBreak:false, o pdfkit ainda quebra o texto em 2 linhas quando um
  // width é passado (só afeta se cria página nova, não impede o wrap em si),
  // e a 2ª linha ficava sobrepondo o valor principal embaixo. Título agora
  // pode quebrar em até 2 linhas de verdade (sem lineBreak:false) e
  // valor/trend passam a ter posição Y FIXA (y+30 e y+47, não mais relativa
  // a onde o título parou) — reserva espaço pro pior caso (título de 2
  // linhas) sempre, pra manter todos os cards de uma mesma fileira alinhados
  // entre si (senão um card com título curto ficaria com o valor mais alto
  // que o vizinho de título longo, na mesma linha da grade).
  /**
   * Desenha 1 card KPI (retângulo branco com borda, título pequeno em
   * cima, valor grande no meio, variação opcional embaixo). Usado na grade
   * de "Resumo de <mês>" (array `valores`, mais abaixo).
   * @param {number} x, y - canto superior esquerdo do card.
   * @param {number} w, h - largura/altura do card (ver cardW/cardH).
   * @param {string} titulo - rótulo pequeno (ex: "Atendimentos").
   * @param {string|number} valor - valor grande em destaque.
   * @param {string} cor - cor do valor (default TEXTO; ex: VERDE pra "Resolvidos").
   * @param {{texto:string, bom:boolean|null}|null} trend - variação
   *   opcional desenhada embaixo do valor, colorida conforme `bom` (ver
   *   _tendenciaInfo — é o formato que essa função espera).
   */
  function cartao(x, y, w, h, titulo, valor, cor = TEXTO, trend = null) {
    doc.roundedRect(x, y, w, h, 5).fillColor(CARD).fill().lineWidth(0.7).strokeColor(AZUL_BORDA).stroke();
    doc.fillColor(SEC).font("Helvetica").fontSize(7.8)
      .text(titulo, x + 9, y + 8, { width: w - 18 });
    doc.fillColor(cor).font("Helvetica-Bold").fontSize(13)
      .text(String(valor), x + 9, y + 30, { width: w - 18, lineBreak: false });
    // Pedido do usuário (2026-09-16): variação vs mês anterior destacada —
    // linha própria, menor, verde quando é uma variação boa e vermelha
    // quando é ruim (ver _tendenciaInfo — critério "bom" já leva em conta
    // métricas invertidas, tipo tempo de resolução).
    if (trend) {
      const corTrend = trend.bom === true ? VERDE : trend.bom === false ? VERMELHO : SEC;
      doc.fillColor(corTrend).font("Helvetica-Bold").fontSize(8)
        .text(trend.texto, x + 9, y + 47, { width: w - 18, lineBreak: false });
    }
  }

  /** Texto de CABEÇALHO de coluna de tabela (negrito, cor SEC). Usado internamente por tabela(). */
  function textoCab(x, y, w, texto, align = "left", size = 8) {
    doc.fillColor(SEC).font("Helvetica-Bold").fontSize(size)
      .text(String(texto), x, y, { width: w, align, lineBreak: false });
  }

  /** Texto de CÉLULA de tabela. `texto ?? "—"` — valor nulo/undefined vira um travessão. Usado internamente por tabela() e diretamente na tabela de feedbacks (página 2). */
  function textoCel(x, y, w, texto, align = "left", size = 8.2, bold = false, cor = TEXTO) {
    doc.fillColor(cor).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
      .text(String(texto ?? "—"), x, y, { width: w, align, lineBreak: false });
  }

  /**
   * Tabela genérica: cabeçalho cinza + linhas zebradas (cor alternada).
   * A função central de desenho deste arquivo — quase toda tabela do PDF
   * (exceto a de feedbacks, que tem altura de linha variável) usa isto.
   * @param {number} x, y - canto superior esquerdo.
   * @param {number} w - largura total da tabela.
   * @param {string[]} colunas - títulos das colunas (cabeçalho).
   * @param {number[]} frac - fração de `w` que cada coluna ocupa, na mesma
   *   ordem de `colunas` (ex: [0.5, 0.5] = 2 colunas iguais). Deve somar ~1.
   * @param {Array<Array<string|number>>} linhas - os dados, um array por
   *   linha, na mesma ordem/quantidade de `colunas`. Célula vazia = "—".
   *   Array vazio → desenha "Sem dados ainda." e sai.
   * @param {object} [opts]
   * @param {string} [opts.fonte=8.2] - tamanho de fonte das células/cabeçalho.
   * @param {number} [opts.headH=20] - altura da linha de cabeçalho.
   * @param {number} [opts.rowH=18] - altura de cada linha de dado.
   * @param {string[]} [opts.align] - alinhamento por coluna ("left"/"right"/"center").
   * @param {string[]} [opts.coresUltimaCol] - cor por LINHA (não por coluna)
   *   pra pintar só a última coluna (ex: coluna "Variação" verde/vermelho —
   *   ver _corTendencia). Índice do array = índice da linha em `linhas`.
   * @returns {number} o `y` onde a tabela terminou — use pra posicionar o
   *   próximo elemento abaixo dela.
   */
  function tabela(x, y, w, colunas, frac, linhas, opts = {}) {
    const fs = opts.fonte || 8.2;
    const headH = opts.headH || 20;
    const rowH = opts.rowH || 18;
    let cx = x;
    doc.roundedRect(x, y, w, headH, 3).fillColor(CINZA).fill();
    colunas.forEach((c, i) => {
      const cw = w * frac[i];
      textoCab(cx + 5, y + 6, cw - 10, c, opts.align?.[i] || "left", fs);
      cx += cw;
    });
    let cy = y + headH;
    if (!linhas.length) {
      doc.fillColor("#8a939b").font("Helvetica-Oblique").fontSize(fs)
        .text("Sem dados ainda.", x + 6, cy + 5, { width: w });
      return cy + 18;
    }
    linhas.forEach((linha, idx) => {
      if (idx % 2) doc.rect(x, cy, w, rowH).fillColor("#fbfcfd").fill();
      cx = x;
      linha.forEach((v, i) => {
        const cw = w * frac[i];
        let valor = String(v ?? "—");
        doc.font("Helvetica").fontSize(fs);
        const limite = Math.max(8, cw - 10);
        if (doc.widthOfString(valor) > limite) {
          while (valor.length > 1 && doc.widthOfString(`${valor}…`) > limite) valor = valor.slice(0, -1);
          valor += "…";
        }
        // Pedido do usuário (2026-09-16): "deixe comparações com mes
        // anterior de uma forma que seja mais entendivel" — coluna final
        // (Variação) pode vir colorida verde/vermelho por linha via
        // opts.coresUltimaCol (ver _corTendencia), em negrito pra destacar.
        const ultimaCol = i === colunas.length - 1;
        const corCel = ultimaCol && opts.coresUltimaCol?.[idx] ? opts.coresUltimaCol[idx] : TEXTO;
        textoCel(cx + 5, cy + 5, cw - 10, valor, opts.align?.[i] || "left", fs, ultimaCol && !!opts.coresUltimaCol?.[idx], corCel);
        cx += cw;
      });
      doc.moveTo(x, cy + rowH).lineTo(x + w, cy + rowH).lineWidth(0.35).strokeColor(LINHA).stroke();
      cy += rowH;
    });
    return cy;
  }

  // Pedido do usuário (2026-09-17): "coloque por grafico de meses
  // anteriores os atendimentos" — barras simples desenhadas com os
  // primitivos do próprio pdfkit (roundedRect), já que não há lib de
  // gráficos no projeto e o volume de dados (6 barras) não justifica
  // adicionar uma só pra isso. `dados` é um array de { total, rotulo }
  // na ordem em que devem aparecer (mais antigo → mais recente).
  /**
   * Gráfico de barras verticais simples. Todas as barras têm a mesma
   * largura (calculada a partir de `w`/quantidade de barras) e altura
   * proporcional ao MAIOR valor do conjunto (barra mais alta = 100% da
   * área útil). Cada barra mostra o valor em negrito acima e o rótulo
   * abaixo (ver graficoY/faixa no final de gerarPdfMetricas pra exemplo de
   * uso).
   * @param {number} x, y - canto superior esquerdo da área do gráfico
   *   (não da 1ª barra — a função calcula o resto).
   * @param {number} w, h - largura/altura total reservada pro gráfico
   *   (rótulos inclusos — ver `areaBarras = h - 30` dentro da função).
   * @param {Array<{total:number, rotulo:string}>} dados - um item por
   *   barra, na ordem em que devem aparecer da esquerda pra direita.
   *   Array vazio → desenha "Sem dados ainda." e sai.
   */
  function graficoBarras(x, y, w, h, dados) {
    if (!dados.length) {
      doc.fillColor("#8a939b").font("Helvetica-Oblique").fontSize(9).text("Sem dados ainda.", x, y, { width: w });
      return;
    }
    const gapBarra = 10;
    const barW = (w - gapBarra * (dados.length - 1)) / dados.length;
    const max = Math.max(1, ...dados.map(d => d.total));
    // Reserva 14pt em cima (rótulo do valor) e 16pt embaixo (rótulo do mês
    // + linha de base) da altura total `h`, o resto é a área útil das barras.
    const areaBarras = h - 30;
    const baseY = y + areaBarras;
    doc.moveTo(x, baseY).lineTo(x + w, baseY).lineWidth(0.5).strokeColor(LINHA).stroke();
    dados.forEach((d, i) => {
      const bx = x + i * (barW + gapBarra);
      const altura = Math.max(2, (d.total / max) * (areaBarras - 14));
      const by = baseY - altura;
      doc.roundedRect(bx, by, barW, altura, 2).fillColor(AZUL).fill();
      doc.fillColor(TEXTO).font("Helvetica-Bold").fontSize(8.5)
        .text(String(d.total), bx, by - 13, { width: barW, align: "center", lineBreak: false });
      doc.fillColor(SEC).font("Helvetica").fontSize(7.8)
        .text(d.rotulo, bx, baseY + 6, { width: barW, align: "center", lineBreak: false });
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // PÁGINA 1 — RESUMO E DISTRIBUIÇÕES
  // Ordem visual de cima pra baixo: faixa "Resumo de <mês>" → grade de
  // cards KPI (array `valores`) → "Comparação com o mês anterior" (tabela,
  // coluna esquerda) + "Distribuição de notas de satisfação" (tabela,
  // coluna direita) lado a lado → "Atendentes" (tabela larga).
  // ────────────────────────────────────────────────────────────────────
  pagina(1);
  // BUG CORRIGIDO (2026-09-16): "W" (largura útil da página) só pode ser lida
  // de doc.page DEPOIS do primeiro addPage() — o documento é criado com
  // autoFirstPage:false (ver construtor acima), então doc.page é null até a
  // primeira página existir. Calcular W antes de pagina(1) (como estava)
  // derrubava TODA chamada de gerarPdfMetricas com "Cannot read properties
  // of null (reading 'width')", com ou sem filtro de mês — essa é a causa
  // real por trás dos crashes reportados na exportação de métricas em PDF.
  const W = doc.page.width - MARGIN * 2;
  faixa(`Resumo de ${nomeMesExibido}`, MARGIN, TOP, W);

  const cardW = (W - gap * 3) / 4;
  // Pedido do usuário (2026-09-16): variação vs mês anterior ganhou linha
  // própria colorida dentro do card (ver cartao()) — cardH subiu de 48 pra
  // 58 pra abrir espaço pra essa linha extra sem espremer o valor principal.
  // Pedido do usuário (2026-09-17): títulos "TMA (Tempo Médio Atendimento)"/
  // "TME (Tempo Médio 1ª Resposta)" precisam de até 2 linhas (ver cartao())
  // — cardH subiu de 58 pra 66 pra caber título de 2 linhas + valor + trend
  // sem cortar nem sobrepor, em TODOS os cards da grade (não só nesses 2).
  const cardH = 66;
  const cardsY = TOP + 30;
  // BUG CORRIGIDO (2026-09-16, relatado pelo usuário com print real: "como é
  // possivel 688 resolvidos se teve 84 atendimentos"): "Resolvidos" usava
  // data.resolvidos — contagem DESDE SEMPRE (status atual de todos os
  // tickets, sem filtro de data nenhum, ver summaryRes em metrics.service.js)
  // — enquanto "Atendimentos" ao lado já usava data.mensal (só o mês). Isso
  // criava números que pareciam quebrados (688 resolvidos num mês com só 84
  // atendimentos). O mesmo cálculo já existia certo em outro lugar deste
  // arquivo (tabela "Comparação com o mês anterior" usa
  // tendencia.mesAtualResolvidos/taxaResolucaoAtual) — só não estava sendo
  // usado aqui nos cards.
  //
  // Pedido do usuário (2026-09-16): "retire andamentos e cancelados" — os
  // dois saíram da grade (eram a foto de AGORA, sem filtro de mês nenhum,
  // igual "Pendentes" que continua — não tinham "versão do mês" que fizesse
  // sentido, o que também ajudava a confundir com o resto dos cards).
  //
  // Pedido do usuário (2026-09-17): "remova janela e pendentes" — "Janela"
  // (rótulo "no mês"/"últimos 30 dias") e "Pendentes" saíram da grade, que
  // agora fecha certinho em 2 linhas de 4 cards (8 no total) sem sobrar
  // espaço vazio. "Pendentes" nunca teve versão do mês (é a foto de AGORA,
  // igual Em andamento/Cancelados que já tinham saído por esse motivo);
  // "Janela" só explicava o período do PDF, informação que já está no
  // subtítulo do cabeçalho.
  //
  // Pedido do usuário (2026-09-17, print real com "+178% vs mês ant." no
  // card de Tempo de resolução): "seria mais rapido ou mais lento que o mes
  // anterior?" — as duas métricas de tempo (Tempo de resolução e 1ª
  // resposta) agora usam _tendenciaInfo(..., rotulos) pra trocar o "%"
  // genérico por "mais rápido"/"mais lento" já dito por extenso.
  //
  // Pedido do usuário (2026-09-17): "TMA (Tempo Médio Atendimento) / TME
  // (Tempo Médio 1ª Resposta) padronize assim e adicione Novos Contatos" —
  // os títulos "Tempo de resolução"/"Tempo de 1ª resposta" viraram TMA/TME,
  // a mesma sigla+nome já usados na aba "Tempos" do painel ao vivo
  // (frontend/index.html, cards #metric-tempo-resolucao/#metric-tempo-resposta)
  // — o PDF ficava com nomenclatura diferente do painel pra exatamente a
  // mesma métrica.
  const ROTULOS_TEMPO = ["mais rápido", "mais lento"];
  const valores = [
    ["Atendimentos", data.mensal ?? 0, TEXTO, _tendenciaInfo(data.tendencia?.totalVariacaoPct)],
    ["Resolvidos", data.tendencia?.mesAtualResolvidos ?? 0, VERDE],
    ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`],
    // Pedido do usuário (2026-09-16): "horario de pico deixe no formato de
    // hora mesmo, por exemplo 10:30am" — só tem granularidade de hora (sem
    // minuto, ver _formatarHora12), então os minutos exibidos são sempre
    // ":00", mas o formato agora é relógio 12h com am/pm em vez de "10h".
    // Pedido do usuário (2026-09-17): total de atendimentos naquele horário
    // no mês saiu do "(39)" colado no valor principal e virou uma linha
    // própria embaixo, em verde — reaproveitando o mesmo slot de "trend" do
    // card (ver cartao()), só que fixo em verde (bom: true) por não ser uma
    // comparação com mês anterior, e sim um destaque informativo.
    ["Horário de pico", data.horarioPico ? _formatarHora12(data.horarioPico.hora) : "sem dados", TEXTO,
      data.horarioPico ? { texto: `${data.horarioPico.total} atendimentos no mês`, bom: true } : null],
    ["Satisfação média", data.satisfacaoMedia != null ? `${Number(data.satisfacaoMedia).toFixed(1)} / 5` : "sem dados"],
    ["TMA (Tempo Médio Atendimento)", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), TEXTO, _tendenciaInfo(data.tendencia?.tempoResolucaoVariacaoPct, true, ROTULOS_TEMPO)],
    ["TME (Tempo Médio 1ª Resposta)", _formatarMin(data.tendencia?.tempoRespostaAtualMin), TEXTO, _tendenciaInfo(data.tendencia?.tempoRespostaVariacaoPct, true, ROTULOS_TEMPO)],
    ["Avaliações", data.satisfacaoTotalRespostas ?? 0],
    // Pedido do usuário (2026-09-17): "adicione Novos Contatos" — usa o
    // mesmo dado que a aba "Tempos" do painel ao vivo já expõe
    // (data.novosContatosLeads, contacts com tag 'Leads'). Importante: essa
    // contagem é ACUMULADA (não tem filtro de created_at nenhum na query —
    // ver leadsRes em metrics.service.js), diferente de quase todo o resto
    // desta grade que é escopado ao mês. O painel ao vivo já avisa isso no
    // tooltip do card ("Total acumulado (não é só o mês)"); aqui o aviso
    // fica no rodapé cinza do card (mesmo slot de trend, cor neutra — não é
    // uma comparação boa/ruim) pra não repetir o erro já corrigido antes
    // (cards mostrando números de recortes de tempo diferentes lado a lado
    // sem deixar isso claro, ver 688 resolvidos vs 84 atendimentos).
    ["Novos Contatos", data.novosContatosLeads ?? 0, TEXTO, { texto: "total acumulado", bom: null }]
  ];
  valores.forEach((v, i) => cartao(MARGIN + (i % 4) * (cardW + gap), cardsY + Math.floor(i / 4) * (cardH + gap), cardW, cardH, v[0], v[1], v[2] || TEXTO, v[3] || null));

  // linhasCards calculado a partir de valores.length (e não mais fixo em 3)
  // pra não sobrar espaço vazio depois que "Pendentes"/"Janela" saíram e a
  // grade encolheu de 10 pra 8 cards (2 linhas de 4 em vez de 3).
  const linhasCards = Math.ceil(valores.length / 4);
  const blocoY = cardsY + linhasCards * (cardH + gap) + 12;
  const colW = (W - gap) / 2;

  // Pedido do usuário (2026-09-16): "deixe comparações com mes anterior de
  // uma forma que seja mais entendivel" — cabeçalhos mais explícitos
  // ("Este mês"/"Mês anterior" em vez de "Atual"/"Anterior") e a coluna
  // "Variação" agora vem colorida (verde=bom, vermelho=ruim) e em negrito,
  // igual ao destaque que os cards de cima já ganharam — mesmo critério
  // "invertido" (tempo subir é ruim) de _corTendencia/_tendenciaInfo.
  faixa("Comparação com o mês anterior", MARGIN, blocoY, colW);
  const compFim = tabela(MARGIN, blocoY + 27, colW, ["Métrica", "Este mês", "Mês anterior", "Variação"], [0.36, 0.20, 0.24, 0.20], [
    ["Atendimentos", data.mensal ?? 0, data.tendencia?.totalMesAnterior ?? 0, data.tendencia?.totalVariacaoPct != null ? `${data.tendencia.totalVariacaoPct > 0 ? "+" : ""}${data.tendencia.totalVariacaoPct}%` : "—"],
    ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`, `${data.tendencia?.taxaResolucaoMesAnterior ?? 0}%`, data.tendencia?.taxaResolucaoVariacaoPontos != null ? `${data.tendencia.taxaResolucaoVariacaoPontos > 0 ? "+" : ""}${data.tendencia.taxaResolucaoVariacaoPontos}pp` : "—"],
    ["TMA (Tempo Médio Atendimento)", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), _formatarMin(data.tendencia?.tempoResolucaoAnteriorMin), data.tendencia?.tempoResolucaoVariacaoPct != null ? `${data.tendencia.tempoResolucaoVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoResolucaoVariacaoPct}%` : "—"],
    ["TME (Tempo Médio 1ª Resposta)", _formatarMin(data.tendencia?.tempoRespostaAtualMin), _formatarMin(data.tendencia?.tempoRespostaAnteriorMin), data.tendencia?.tempoRespostaVariacaoPct != null ? `${data.tendencia.tempoRespostaVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoRespostaVariacaoPct}%` : "—"]
  ], {
    align: ["left", "right", "right", "right"],
    coresUltimaCol: [
      _corTendencia(data.tendencia?.totalVariacaoPct),
      _corTendencia(data.tendencia?.taxaResolucaoVariacaoPontos),
      _corTendencia(data.tendencia?.tempoResolucaoVariacaoPct, true),
      _corTendencia(data.tendencia?.tempoRespostaVariacaoPct, true)
    ]
  });

  const x2 = MARGIN + colW + gap;
  faixa("Distribuição de notas de satisfação", x2, blocoY, colW);
  tabela(x2, blocoY + 27, colW, ["Nota", "Avaliações"], [0.55, 0.45], [5, 4, 3, 2, 1].map(n => [`Nota ${n}`, data.distribuicaoNotas?.[n] ?? 0]), { align: ["left", "right"] });

  // Pedido do usuário (2026-09-16): "remova atendimentos por setor" — saiu
  // do relatório (já tinha saído do painel ao vivo antes, ver histórico).
  // "Atendentes" ocupa a largura toda agora que não divide mais a linha com
  // a tabela de Setor.
  const baixoY = Math.max(compFim, blocoY + 27 + 20 + 5 * 18) + 12;
  faixa("Atendentes", MARGIN, baixoY, W);
  if (historico) {
    tabela(MARGIN, baixoY + 27, W, ["Atendente", "Mês", "Histórico", "Em atendimento agora"], [0.46, 0.18, 0.18, 0.18], (data.atendentes || []).map(a => [a.nome, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]), { align: ["left", "right", "right", "right"], fonte: 8 });
  } else {
    tabela(MARGIN, baixoY + 27, W, ["Atendente", "Hoje", "7 dias", "Mês", "Histórico", "Em atendimento agora"], [0.34, 0.12, 0.12, 0.12, 0.15, 0.15], (data.atendentes || []).map(a => [a.nome, a.atendidosHoje, a.atendidosSemana, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]), { align: ["left", "right", "right", "right", "right", "right"], fonte: 7.8 });
  }

  // ────────────────────────────────────────────────────────────────────
  // PÁGINA 2 — SATISFAÇÃO DETALHADA
  // Ordem: "Satisfação por atendente" (tabela) → "O que os clientes
  // disseram" (feedbacks nota 1-2, tabela de altura variável por linha) →
  // "Atendimentos nos últimos 6 meses" (gráfico de barras — pula pra
  // página 3 se não sobrar espaço, ver `if` logo abaixo).
  // ────────────────────────────────────────────────────────────────────
  pagina(2);
  faixa("Satisfação por atendente", MARGIN, TOP, W);
  const sat = Object.entries(data.satisfacaoPorAtendente || {}).sort((a, b) => b[1].media - a[1].media);
  const satFim = tabela(MARGIN, TOP + 27, W, ["Atendente", "Média", "Avaliações"], [0.58, 0.21, 0.21], sat.map(([nome, v]) => [nome, `${Number(v.media || 0).toFixed(1)} / 5`, v.total]), { align: ["left", "right", "right"] });

  const feedbackY = satFim + 16;
  faixa("O que os clientes disseram (notas 1–2, mais recentes)", MARGIN, feedbackY, W);
  const feedbacks = (data.feedbacksNegativos || []).slice(0, 15);
  const ty = feedbackY + 27;
  const cols = [0.16, 0.20, 0.09, 0.55];
  const heads = ["Protocolo", "Cliente", "Nota", "Comentário"];
  const tw = W;
  const hh = 20;
  doc.roundedRect(MARGIN, ty, tw, hh, 3).fillColor(CINZA).fill();
  let cx = MARGIN;
  heads.forEach((h, i) => { const cw = tw * cols[i]; textoCab(cx + 5, ty + 6, cw - 10, h, "left", 8); cx += cw; });
  let fy = ty + hh;
  if (!feedbacks.length) {
    doc.fillColor("#8a939b").font("Helvetica-Oblique").fontSize(9).text("Sem dados ainda.", MARGIN + 6, fy + 5, { width: tw });
  } else {
    feedbacks.forEach((f, i) => {
      doc.font("Helvetica").fontSize(8.1);
      const comentario = String(f.feedback || "Sem comentário");
      const comentarioW = tw * cols[3] - 10;
      const alturaTexto = doc.heightOfString(comentario, { width: comentarioW, lineGap: 1 });
      const h = Math.min(42, Math.max(20, alturaTexto + 8));
      if (i % 2) doc.rect(MARGIN, fy, tw, h).fillColor("#fbfcfd").fill();
      cx = MARGIN;
      [
        `#${f.protocolo}`,
        f.customerName || "Não informado",
        `${f.rating}/5`
      ].forEach((v, j) => {
        const cw = tw * cols[j];
        textoCel(cx + 5, fy + 6, cw - 10, v, "left", 8.1);
        cx += cw;
      });
      doc.fillColor(TEXTO).font("Helvetica").fontSize(8.1)
        .text(comentario, cx + 5, fy + 5, { width: comentarioW, height: h - 6, lineGap: 1, ellipsis: true });
      doc.moveTo(MARGIN, fy + h).lineTo(MARGIN + tw, fy + h).lineWidth(0.35).strokeColor(LINHA).stroke();
      fy += h;
    });
  }

  // Pedido do usuário (2026-09-17): 1ª versão era uma tabela dia a dia
  // ("Evolução diária"), mas o usuário pediu pra trocar por um gráfico dos
  // MESES anteriores ("acha boa ideia?" — sim: mostra tendência ao longo do
  // tempo de um jeito mais direto que uma lista de ~30 linhas, e evita o
  // risco de estourar 2+ páginas extras num mês cheio, como a versão
  // anterior fazia). Usa data.porMeses (novo em metrics.service.js: mês do
  // relatório + 5 anteriores, zerado onde não há ticket — ver comentário
  // lá sobre por que os rótulos são calculados por aritmética de
  // ano/mês em vez de Date/TZ).
  const graficoAltura = 22 + 34 + 140;
  let graficoY = fy + 16;
  if (graficoY + graficoAltura > doc.page.height - BOTTOM - 10) {
    pagina(3);
    graficoY = TOP;
  }
  faixa("Atendimentos nos últimos 6 meses", MARGIN, graficoY, W);
  graficoBarras(MARGIN + 12, graficoY + 34, W - 24, 140, (data.porMeses || []).map(m => ({ total: m.total, rotulo: _rotuloMesCurto(m.mes) })));

  doc.end();
}

module.exports = { gerarPdfMetricas };
