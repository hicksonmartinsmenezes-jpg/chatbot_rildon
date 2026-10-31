'use strict';

/**
 * Regressão do BUG REAL reportado pelo usuário em 2026-10-14: "alguns
 * catálogos quando gerados, apesar de não ter duas fotos no sistema, ele é
 * arrastado para o canto esquerdo e com a marca 'sem foto', como SPEED BRAKE
 * por exemplo".
 *
 * O layout do card (1 foto grande vs. 2 lado a lado) era escolhido olhando só
 * o mimetype das fotos, que vem da EXTENSÃO do arquivo indexado — ou seja,
 * "existe um 2º .jpg?", não "esse .jpg abre?". Com um 2º arquivo ilegível
 * (EXIF malformado -> RangeError de dentro do parser do pdfkit, comum no
 * acervo real), acontecia: foto 1 desenhada em MEIA largura -> foto 2 estoura
 * -> o catch único do bloco escrevia "sem foto" na largura cheia por cima da
 * foto que já estava lá. Ver _fotosUtilizaveis em catalogo-pdf.service.js.
 *
 * Os números de geometria (largura exata da foto, quantas chamadas de
 * doc.image a arte da página gasta) não são fixados aqui de propósito — são
 * medidos a partir dos próprios cenários, então mudar o layout do catálogo não
 * quebra este teste; só muda o comportamento que ele descreve.
 */

const { Writable } = require('stream');

const mockObterFoto = jest.fn();

jest.mock('../src/services/catalogo-fotos.service', () => ({
  obterFoto: (...args) => mockObterFoto(...args),
  listarFotos: jest.fn(() => []),
  temMultiplasFotos: jest.fn(() => false),
  temAlgumaFoto: jest.fn(() => true),
  obterVersaoFotos: jest.fn(() => 1),
}));

jest.mock('../src/services/catalogo-x2.service', () => ({
  listarMarcasVeiculoConhecidas: jest.fn(() => []),
}));

const PDFDocument = require('pdfkit');
const jpeg = require('jpeg-js');
const { gerarPdfCatalogoCompleto, limparCacheBboxFotos } = require('../src/services/catalogo-pdf.service');

function jpegReal(lado, cor) {
  const data = Buffer.alloc(lado * lado * 4);
  for (let i = 0; i < lado * lado; i++) {
    data[i * 4] = cor[0];
    data[i * 4 + 1] = cor[1];
    data[i * 4 + 2] = cor[2];
    data[i * 4 + 3] = 255;
  }
  return { buffer: jpeg.encode({ data, width: lado, height: lado }, 85).data, mimetype: 'image/jpeg' };
}

const FOTO_A = jpegReal(60, [30, 90, 200]);
const FOTO_B = jpegReal(60, [200, 70, 30]);
// Indexada como .jpg (passa no teste de mimetype), mas o pdfkit não parseia —
// é o que acontece de verdade com as fotos de EXIF malformado do acervo.
const FOTO_ILEGIVEL = jpegReal(16, [120, 120, 120]);

const imagemOriginal = PDFDocument.prototype.image;
const openImageOriginal = PDFDocument.prototype.openImage;
const textOriginal = PDFDocument.prototype.text;

let desenhos;

function erroDeExifQuebrado() {
  const erro = new RangeError('The value of "offset" is out of range.');
  erro.code = 'ERR_OUT_OF_RANGE';
  return erro;
}

beforeAll(() => {
  PDFDocument.prototype.openImage = function openImageEspiao(src) {
    if (Buffer.isBuffer(src) && src === FOTO_ILEGIVEL.buffer) throw erroDeExifQuebrado();
    return openImageOriginal.call(this, src);
  };
  PDFDocument.prototype.image = function imageEspiao(src, x, y, opcoes = {}) {
    if (Buffer.isBuffer(src) && src === FOTO_ILEGIVEL.buffer) throw erroDeExifQuebrado();
    const largura = opcoes.width != null ? opcoes.width : (opcoes.fit ? opcoes.fit[0] : null);
    if (desenhos) desenhos.imagens.push(largura == null ? null : Math.round(largura));
    return imagemOriginal.apply(this, arguments);
  };
  PDFDocument.prototype.text = function textEspiao(texto) {
    if (desenhos && String(texto) === 'sem foto') desenhos.semFoto += 1;
    return textOriginal.apply(this, arguments);
  };
});

afterAll(() => {
  PDFDocument.prototype.image = imagemOriginal;
  PDFDocument.prototype.openImage = openImageOriginal;
  PDFDocument.prototype.text = textOriginal;
});

/**
 * Gera um catálogo de 1 produto cujas fotos são as passadas em `fotos` e
 * devolve o que foi realmente desenhado.
 */
async function gerarCom(fotos) {
  mockObterFoto.mockReset();
  mockObterFoto.mockImplementation((codigo, indice) => fotos[indice] || null);
  limparCacheBboxFotos();
  desenhos = { imagens: [], semFoto: 0 };

  const produto = {
    codigo: '117437',
    descricaoCurta: 'PASTILHA DE FREIO',
    descricaoComercial: 'PASTILHA DE FREIO DIANTEIRA',
    equivalentes: [],
    aplicacaoOrganizada: null,
    linha: 'FREIO',
    fabricante: 'SPEED BRAKE',
  };
  const sumidouro = new Writable({ write(pedaco, codificacao, cb) { cb(); } });
  await gerarPdfCatalogoCompleto([produto], 'SPEED BRAKE', sumidouro);
  return desenhos;
}

describe('catálogo completo — layout do card quando uma das fotos não abre', () => {
  // A arte fixa da página (cabeçalho/rodapé) também passa por doc.image, e
  // não é a mesma em todo cenário: com 0 produtos SÓ a página de índice é
  // desenhada (2 imagens: cabeçalho+rodapé dela); assim que há 1 produto
  // com ao menos 1 foto utilizável, a página de CONTEÚDO também entra (mais
  // 2 imagens: seu próprio cabeçalho+rodapé) — 4 no total, antes de
  // qualquer foto de produto. Dois baselines, um pra cada formato de
  // cenário: "sem produto" é o mesmo usado pelo Issue #57 (produto
  // irrecuperável = omitido = só a página de índice); "com produto" é o
  // usado quando a foto (original ou recuperada via _removerExifJpeg)
  // sobrevive e o produto aparece de verdade no catálogo.
  let arteDaPaginaSemProduto;
  let arteDaPaginaComProduto;
  let larguraFotoUnica;
  let larguraFotoMetade;

  beforeAll(async () => {
    arteDaPaginaSemProduto = (await gerarCom([])).imagens.length;
    const refUnica = await gerarCom([FOTO_A]);
    // 1 produto com 1 foto: a diferença entre o total e as fotos de fato
    // desenhadas (1, nesse cenário de referência) dá a arte fixa real
    // quando o produto sobrevive ao filtro do Issue #57.
    arteDaPaginaComProduto = refUnica.imagens.length - 1;
    larguraFotoUnica = refUnica.imagens.slice(arteDaPaginaComProduto);
    larguraFotoMetade = (await gerarCom([FOTO_A, FOTO_B])).imagens.slice(arteDaPaginaComProduto);
  });

  test('cenários de referência: 1 foto ocupa a largura cheia, 2 fotos ocupam metade cada', () => {
    expect(larguraFotoUnica).toHaveLength(1);
    expect(larguraFotoMetade).toHaveLength(2);
    expect(larguraFotoMetade[0]).toBe(larguraFotoMetade[1]);
    // A meia largura é de fato menor que a cheia — garante que os dois
    // cenários de referência não colapsaram no mesmo layout.
    expect(larguraFotoMetade[0]).toBeLessThan(larguraFotoUnica[0]);
  });

  test('2ª foto ilegível: desenha a 1ª em largura CHEIA e NÃO escreve "sem foto"', async () => {
    const resultado = await gerarCom([FOTO_A, FOTO_ILEGIVEL]);
    const fotosDoProduto = resultado.imagens.slice(arteDaPaginaComProduto);

    expect(fotosDoProduto).toEqual(larguraFotoUnica);
    // O sintoma relatado: foto encolhida pra metade (como se houvesse 2) com
    // o aviso "sem foto" escrito por cima dela.
    expect(fotosDoProduto[0]).not.toBe(larguraFotoMetade[0]);
    expect(resultado.semFoto).toBe(0);
  });

  test('1ª foto ilegível e 2ª boa: usa a 2ª em largura cheia em vez de "sem foto"', async () => {
    const resultado = await gerarCom([FOTO_ILEGIVEL, FOTO_B]);

    expect(resultado.imagens.slice(arteDaPaginaComProduto)).toEqual(larguraFotoUnica);
    expect(resultado.semFoto).toBe(0);
  });

  // 2026-10-29 (Issue #57, mesmo bug de fundo desta suíte): antes, um
  // produto sem nenhuma foto utilizável sobrevivia até aqui e ganhava o
  // placeholder "sem foto" escrito por cima — era exatamente esse texto
  // que, combinado com o bug de layout acima, confundia o usuário. Agora
  // gerarPdfCatalogoCompleto pré-filtra os produtos por _fotosUtilizaveis
  // ANTES de montar índice/corpo: um produto sem foto de verdade (nem
  // mesmo depois de tentar _removerExifJpeg) não entra mais no catálogo —
  // não aparece, em vez de aparecer com "sem foto". A foto ilegível aqui
  // não tem segmento EXIF de verdade pra _removerExifJpeg remover (é um
  // JPEG sintético do jpeg-js), então o teste segue cobrindo exatamente o
  // caso "mesmo tentando, não teve jeito" (irrecuperável) — ver
  // verificar-fix-exif.js para a cobertura do caso recuperável, validada
  // contra fotos reais do acervo (10/10 do fabricante 12M).
  test('as duas ilegíveis (irrecuperável mesmo após tentar remover EXIF): produto some do catálogo, sem placeholder', async () => {
    const resultado = await gerarCom([FOTO_ILEGIVEL, FOTO_ILEGIVEL]);

    // Produto sem nenhuma foto utilizável é filtrado ANTES da página de
    // conteúdo existir — só sobra a arte da página de índice (ver
    // comentário no beforeAll acima).
    expect(resultado.imagens).toHaveLength(arteDaPaginaSemProduto);
    expect(resultado.semFoto).toBe(0);
  });

  test('sem nenhuma foto cadastrada: produto também some do catálogo (Issue #57), sem placeholder', async () => {
    const resultado = await gerarCom([]);

    expect(resultado.imagens).toHaveLength(arteDaPaginaSemProduto);
    expect(resultado.semFoto).toBe(0);
  });
});
