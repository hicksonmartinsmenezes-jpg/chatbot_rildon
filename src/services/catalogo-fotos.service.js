/**
 * catalogo-fotos.service.js — acesso às fotos de produto do catálogo X2
 * (src/config/catalogo-x2/fotos/*.zip).
 *
 * Por que os zips ficam zipados: a pasta catalogo-x2/ está dentro do
 * OneDrive, e extrair ~27.600 fotos de uma vez (um arquivo pequeno por foto)
 * trava/atrasa o sync (ver README da pasta e memória do projeto). Por isso
 * este serviço NUNCA extrai o zip inteiro pra disco — ele lê só o índice
 * (Central Directory, leve) de cada zip uma vez, e descompacta sob demanda
 * apenas a foto pedida, usando src/utils/zip-reader.js.
 *
 * 2026-08-28: pedido do usuário — mostrou um recorte do Catálogo Completo
 * em PDF com "fotos técnicas" (desenho de linha, tipo diagrama de pinagem)
 * no lugar da foto real do produto, pediu pra sempre usar a foto real. Causa
 * raiz medida: o X2 lista, pra alguns produtos (principalmente conectores
 * elétricos), um DESENHO TÉCNICO como a 1ª imagem da galeria, com a(s)
 * foto(s) real(is) só depois — o scraper (x2-fotos-scraper.js) baixa TODAS
 * as imagens da galeria na ordem em que aparecem, e este serviço sempre
 * devolvia o índice 0 como "a foto" (ver obterFoto), então a foto exibida
 * era o desenho, não a peça de verdade. Amostragem no catálogo inteiro
 * (2.224 produtos com 2+ fotos) confirmou que esses desenhos/ícones
 * genéricos de "sem foto" são sempre pequenos (a maioria ≤190px de lado —
 * inclusive um cluster grande em exatos 82×72px, o ícone genérico já
 * documentado em catalogo-pdf.service.js/_bboxConteudoFoto), enquanto fotos
 * reais do produto vêm em resolução bem maior (a esmagadora maioria
 * ≥600px). `_reordenarFotos` abaixo lê só o CABEÇALHO do JPEG (marcador
 * SOFx, ver `_dimensoesJpeg`) — não decodifica os pixels inteiros, é
 * ordens de magnitude mais rápido que um decode completo (testado: decode
 * completo de ~2.200 produtos não terminava em 2min; só o cabeçalho,
 * ~10s) — e empurra pro FIM da lista qualquer foto com o maior lado abaixo
 * de DIAGRAM_MAX_DIM, SEM nunca descartar nenhuma (se um produto só tiver
 * fotos pequenas, elas continuam disponíveis, só não em primeiro).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { listarEntradas, extrairArquivo } = require("../utils/zip-reader");

const FOTOS_DIR = path.join(__dirname, "../config/catalogo-x2/fotos");

// 2026-09-08 (pedido do usuário: "criar possibilidade de adicionar foto"):
// fotos enviadas manualmente pelo atendente via upload — pasta SEPARADA de
// FOTOS_DIR de propósito (decisão do usuário): nunca tocada por nenhum
// resync do X2 (x2-fotos-scraper.js só escreve em FOTOS_DIR), então uma
// foto enviada aqui sobrevive a qualquer "Atualizar Fotos" rodado depois.
// Estrutura: fotos-manuais/<codigoProduto>/<arquivo>.
const FOTOS_MANUAIS_DIR = path.join(__dirname, "../config/catalogo-x2/fotos-manuais");
const MAX_TAMANHO_FOTO_MANUAL = 8 * 1024 * 1024; // 8MB — generoso pra foto de celular, sem abrir espaço pra abuso

const MIME_POR_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

// Ver comentário acima — limiar medido na amostra real do catálogo (desenho
// técnico/ícone "sem foto": tipicamente ≤190px de lado, cluster grande em
// 82px; fotos reais: predominantemente ≥600px, com uma faixa 300-600px que
// não foi auditada a fundo — o limiar fica conservador, abaixo dessa faixa
// cinzenta, pra não arriscar empurrar uma foto real pequena por engano).
const DIAGRAM_MAX_DIM = 300;

// Lê só os marcadores do cabeçalho JPEG (SOF0/SOF2 etc., 0xFFC0-0xFFCF
// exceto os de Huffman/aritmética) pra achar width/height SEM decodificar
// os pixels — muito mais barato que um decode completo (ver jpeg-js, usado
// em catalogo-pdf.service.js pra outro propósito que precisa dos pixels de
// verdade). Retorna null pra qualquer coisa que não seja um JPEG válido —
// nesse caso a foto simplesmente não é reordenada (mantém a posição
// original), nunca quebra a extração.
// BUG REAL corrigido 2026-09-02 (usuário mandou print mostrando desenho
// técnico ainda na posição 0 do card, meses depois do fix de 2026-08-28
// acima): a amostragem que definiu DIAGRAM_MAX_DIM só cobriu JPEG — mas o
// X2 também lista desenho técnico/ficha de especificação como PNG (ex:
// produto 114927 "INTERRUPTOR DE EMBREAGEM": foto 0 é "24303.png", um
// cartão de ficha técnica 111×97px; a foto REAL do produto é "31797.jpg",
// mas fica em 2º lugar porque _dimensoesJpeg devolve null pra qualquer
// arquivo que não comece com o marcador JPEG — incluindo PNG — e
// `_reordenarFotos` trata "não deu pra medir" como "trata como grande,
// mantém posição", nunca como pequena). Resultado: TODA foto técnica
// salva como PNG (não só a genérica "sem foto", ficha técnica também)
// escapava do reordenamento e ficava sempre em primeiro. Fix: mesma ideia
// do cabeçalho JPEG, mas pro cabeçalho PNG (assinatura fixa de 8 bytes +
// chunk IHDR, que é sempre o primeiro chunk do arquivo — 8 bytes de
// largura/altura big-endian logo em seguida, sem precisar decodificar
// nada).
function _dimensoesPng(buffer) {
  if (!buffer || buffer.length < 24) return null;
  const ASSINATURA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buffer[i] !== ASSINATURA_PNG[i]) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Dispatcher usado por _reordenarFotos — tenta JPEG, depois PNG (os dois
// formatos que aparecem nos zips, ver MIME_POR_EXT). Qualquer outra coisa
// (gif, arquivo corrompido) devolve null e a foto não é reordenada, mesmo
// comportamento de segurança de sempre.
function _dimensoesImagem(buffer) {
  return _dimensoesJpeg(buffer) || _dimensoesPng(buffer);
}

function _dimensoesJpeg(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || offset + 3 >= buffer.length) break; // EOI ou fim do buffer
    const len = buffer.readUInt16BE(offset + 2);
    const ehSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (ehSOF) {
      if (offset + 8 >= buffer.length) return null;
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + len;
  }
  return null;
}

// Map<codigoProduto, Array<{ zipPath, entrada }>> — construído uma vez, na
// primeira chamada (lazy), e mantido em memória (só o índice, não as fotos).
let indice = null;

// Map<codigoProduto, Array<{ zipPath, entrada }>> — versão REORDENADA (fotos
// pequenas/técnicas empurradas pro fim), calculada sob demanda por produto
// (só quando alguém pede as fotos daquele código) e cacheada aqui — evita
// decodificar cabeçalho JPEG de 27 mil fotos de uma vez só no boot.
let ordemCache = null;

function _garantirIndice() {
  if (indice) return indice;
  indice = new Map();

  let arquivos;
  try {
    arquivos = fs.readdirSync(FOTOS_DIR).filter(f => f.endsWith(".zip"));
  } catch (e) {
    console.error("[catalogo-fotos.service] pasta de fotos não encontrada:", e.message);
    return indice;
  }

  for (const arquivo of arquivos) {
    const zipPath = path.join(FOTOS_DIR, arquivo);
    let entradas;
    try {
      entradas = listarEntradas(zipPath);
    } catch (e) {
      console.error(`[catalogo-fotos.service] falha ao ler índice de ${arquivo}:`, e.message);
      continue;
    }
    for (const entrada of entradas) {
      const barra = entrada.name.indexOf("/");
      if (barra <= 0) continue;
      const codigo = entrada.name.slice(0, barra);
      if (!indice.has(codigo)) indice.set(codigo, []);
      indice.get(codigo).push({ zipPath, entrada });
    }
  }

  console.log(`[catalogo-fotos.service] índice de fotos pronto: ${indice.size} produtos com foto.`);
  return indice;
}

// Map<codigoProduto, Array<{ manual:true, caminho, entrada:{name} }>> — fotos
// enviadas manualmente (ver FOTOS_MANUAIS_DIR acima). `entrada.name` no
// mesmo formato "codigo/arquivo" das entradas de zip só pra caber sem
// mudança nas funções que já leem path.basename(item.entrada.name) como
// identidade estável da foto (preferência/ocultar). Reconstruído sob
// demanda (invalidado por adicionarFotoManual, não precisa de
// recarregarIndice() — volume baixo, upload já invalida na hora).
let indiceManual = null;

function _garantirIndiceManual() {
  if (indiceManual) return indiceManual;
  indiceManual = new Map();

  let pastasCodigo;
  try {
    pastasCodigo = fs.readdirSync(FOTOS_MANUAIS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[catalogo-fotos.service] falha ao ler pasta de fotos manuais:", e.message);
    }
    return indiceManual;
  }

  for (const dirent of pastasCodigo) {
    const codigo = dirent.name;
    const pastaCodigo = path.join(FOTOS_MANUAIS_DIR, codigo);
    let arquivos;
    try {
      arquivos = fs.readdirSync(pastaCodigo).filter(f => MIME_POR_EXT[path.extname(f).slice(1).toLowerCase()]);
    } catch {
      continue;
    }
    if (!arquivos.length) continue;
    indiceManual.set(codigo, arquivos.map(nomeArquivo => ({
      manual: true,
      caminho: path.join(pastaCodigo, nomeArquivo),
      entrada: { name: `${codigo}/${nomeArquivo}` },
    })));
  }

  return indiceManual;
}

function _listaManual(codigo) {
  return _garantirIndiceManual().get(codigo) || [];
}

// Lê os bytes de uma entrada — zip (extrairArquivo, descompacta sob
// demanda) ou manual (fs.readFileSync direto). Usado por toda função que
// hoje só sabia lidar com entradas de zip (obterFoto, obterFotoPorNome,
// _reordenarFotos) — mantém o resto da lógica (preferência/ocultar/ordem)
// igual pros dois tipos.
function _extrairBytes(item) {
  return item.manual ? fs.readFileSync(item.caminho) : extrairArquivo(item.zipPath, item.entrada);
}

// Só entra em jogo quando o produto tem 2+ fotos (com 0 ou 1, não tem o que
// reordenar — devolve a lista original direto). Extrai e decodifica só o
// CABEÇALHO de cada foto (ver _dimensoesJpeg) pra separar "grandes" (foto
// real, mantém a ordem relativa entre si) de "pequenas" (desenho técnico/
// ícone genérico, ver DIAGRAM_MAX_DIM — empurradas pro fim, na ordem
// relativa entre si). Se TODAS forem pequenas (produto só tem o desenho
// mesmo, sem foto real cadastrada no X2), não reordena nada — não tem
// "melhor opção" nesse caso, e mexer na ordem não muda nada de útil.
function _reordenarFotos(codigo, lista) {
  if (lista.length < 2) return lista;
  if (!ordemCache) ordemCache = new Map();
  if (ordemCache.has(codigo)) return ordemCache.get(codigo);

  const grandes = [];
  const pequenas = [];
  for (const item of lista) {
    let ehPequena = false;
    try {
      const buffer = _extrairBytes(item);
      const dim = _dimensoesImagem(buffer);
      if (dim && Math.max(dim.width, dim.height) < DIAGRAM_MAX_DIM) ehPequena = true;
    } catch {
      // Falha ao extrair/ler o cabeçalho — trata como "grande" (mantém
      // posição original) em vez de arriscar reordenar com base em nada.
    }
    (ehPequena ? pequenas : grandes).push(item);
  }

  const reordenada = grandes.length > 0 ? grandes.concat(pequenas) : lista;
  ordemCache.set(codigo, reordenada);
  return reordenada;
}

// PEDIDO DO USUÁRIO (2026-09-02, Issue de foto técnica no lugar da foto
// real): a reordenação automática (_reordenarFotos) não consegue distinguir
// ficha técnica de foto real quando o X2 salva as duas na mesma resolução
// (ex: produto 114927 — todas as 3 fotos em ~150px). Tentativa de critério
// por cor/textura testada com só 2 exemplos não deu sinal confiável o
// bastante pra arriscar trocar foto errada em produção. Em vez de um
// classificador especulativo, override MANUAL: o atendente escolhe direto
// no painel qual foto é a principal pra aquele produto (ver
// definirFotoPreferida) — sempre vence a ordenação automática, e fica
// salvo em disco (sobrevive a reinício/recarregar índice, que SÓ mexe no
// índice de zips, nunca nas preferências manuais).
const PREFERENCIAS_PATH = path.join(__dirname, "../config/catalogo-x2/fotos-preferencias.json");

let preferencias = null; // Map<codigo, nomeArquivo> — lazy, carregado do disco na 1ª chamada.

// BUG REAL corrigido 2026-09-02 (usuário testou ao vivo: trocou a foto,
// funcionou na hora, mas voltou pra foto errada depois de recarregar a
// página — mesmo com o fix de ETag/must-revalidate já aplicado): o problema
// não é o CABEÇALHO que o servidor manda agora — é que qualquer navegador
// que já tinha visto /fotos/0 daquele produto ANTES desse fix guardou a
// resposta em disco com a validade antiga (max-age=86400) e simplesmente
// NUNCA pergunta pro servidor de novo até essa validade vencer (24h) — nem
// um refresh forçado (Ctrl+Shift+R) limpa isso pra imagens carregadas via
// busca (só limpa recurso da carga inicial da página). Ou seja, trocar o
// Cache-Control não corrige entradas que JÁ estão no cache do navegador com
// o cabeçalho velho — só a URL em si mudar força um pedido novo de verdade.
// Fix: versão global (timestamp), incrementada toda vez que QUALQUER
// preferência de foto é salva — o controller expõe isso em
// GET /api/catalogo/fotos-versao e no retorno de POST .../foto-preferida, e
// o frontend embute como ?v=<versao> em toda URL de foto do painel. Trocar
// uma preferência muda a versão, que muda a URL, que garante um pedido novo
// ao servidor não importa o que esteja cacheado. Escala (5 atendentes,
// trocas raras) não justifica versão por produto — uma versão global é
// simples e resolve, mesmo custando bustar o cache de OUTRAS fotos também
// quando uma muda (efeito colateral aceitável nesse volume).
let versaoFotos = Date.now();

function obterVersaoFotos() {
  return versaoFotos;
}

function _garantirPreferencias() {
  if (preferencias) return preferencias;
  preferencias = new Map();
  try {
    const bruto = JSON.parse(fs.readFileSync(PREFERENCIAS_PATH, "utf8"));
    for (const [codigo, nomeArquivo] of Object.entries(bruto)) preferencias.set(String(codigo), String(nomeArquivo));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[catalogo-fotos.service] falha ao ler fotos-preferencias.json:", e.message);
    }
  }
  return preferencias;
}

function _salvarPreferencias() {
  const obj = Object.fromEntries(preferencias);
  fs.writeFileSync(PREFERENCIAS_PATH, JSON.stringify(obj, null, 2) + "\n", "utf8");
  versaoFotos = Date.now();
}

// Aplica a preferência (se existir e apontar pra um arquivo que ainda está
// na lista) movendo essa foto pro índice 0 — sempre por cima da ordenação
// automática. Preferência que não bate com nenhum arquivo da lista atual
// (foto removida do X2 num resync, por exemplo) é ignorada silenciosamente,
// sem quebrar a exibição — cai de volta na ordenação automática.
function _aplicarPreferencia(codigo, lista) {
  const prefs = _garantirPreferencias();
  const preferido = prefs.get(String(codigo));
  if (!preferido) return lista;
  const idx = lista.findIndex(item => path.basename(item.entrada.name) === preferido);
  if (idx <= 0) return lista; // não achou, ou já está em 1º — nada a fazer
  const copia = lista.slice();
  const [item] = copia.splice(idx, 1);
  copia.unshift(item);
  return copia;
}

// PEDIDO DO USUÁRIO (2026-09-02, mesma leva de "trocar foto principal"): às
// vezes uma das fotos cadastradas no X2 pra um produto está simplesmente
// ERRADA (foto de outra peça, borrada, etc.) — o atendente esconde ela da
// exibição (card, modal, PDF) sem apagar nada do zip/X2 de verdade (mesma
// filosofia não-destrutiva de definirFotoPreferida acima: fica só num JSON
// à parte, reversível, sobrevive a reinício/recarregar índice). Guardado
// separado de fotos-preferencias.json (arquivos com propósitos diferentes,
// mais simples que migrar o schema de um pra caber os dois).
const OCULTAS_PATH = path.join(__dirname, "../config/catalogo-x2/fotos-ocultas.json");

let ocultas = null; // Map<codigo, Set<nomeArquivo>> — lazy, carregado do disco na 1ª chamada.

function _garantirOcultas() {
  if (ocultas) return ocultas;
  ocultas = new Map();
  try {
    const bruto = JSON.parse(fs.readFileSync(OCULTAS_PATH, "utf8"));
    for (const [codigo, lista] of Object.entries(bruto)) {
      ocultas.set(String(codigo), new Set((lista || []).map(String)));
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[catalogo-fotos.service] falha ao ler fotos-ocultas.json:", e.message);
    }
  }
  return ocultas;
}

function _salvarOcultas() {
  const obj = {};
  for (const [codigo, set] of ocultas) {
    if (set.size > 0) obj[codigo] = Array.from(set);
  }
  fs.writeFileSync(OCULTAS_PATH, JSON.stringify(obj, null, 2) + "\n", "utf8");
  versaoFotos = Date.now();
}

/**
 * Lista as fotos de um produto (sem carregar os bytes) — já na ordem final
 * (preferência manual > reordenação automática, ver
 * _aplicarPreferencia/_reordenarFotos). Por padrão só devolve as VISÍVEIS
 * (não ocultas); { incluirOcultas: true } (usado só pelo modal de
 * gerenciar fotos no painel) devolve as ocultas também, no fim da lista,
 * com indice:-1 (não têm posição na ordem visível — pra pegar os bytes de
 * uma foto oculta use obterFotoPorNome, não obterFoto/indice).
 * Retorna [{ indice, nomeArquivo, oculta }, ...].
 */
function listarFotos(codigoProduto, { incluirOcultas = false } = {}) {
  const idx = _garantirIndice();
  const codigo = String(codigoProduto);
  const brutaZip = idx.get(codigo) || [];
  const brutaManual = _listaManual(codigo);
  const bruta = brutaZip.concat(brutaManual);
  const setOcultas = _garantirOcultas().get(codigo) || new Set();

  // Reordenação automática (grande/pequena, ver _reordenarFotos) só olha
  // pras fotos do X2 — foto manual é escolha deliberada do atendente, não
  // faz sentido ela ser empurrada pro fim por parecer "pequena" numa
  // checagem de cabeçalho. Sempre entra DEPOIS das do X2 (decisão do
  // usuário, 2026-09-08: "só adiciona à lista", não vira principal sozinha)
  // — mas antes da preferência manual ser aplicada, que pode promover
  // QUALQUER uma (inclusive manual) pro topo se o atendente escolher.
  const brutaZipVisivel = brutaZip.filter(item => !setOcultas.has(path.basename(item.entrada.name)));
  const brutaManualVisivel = brutaManual.filter(item => !setOcultas.has(path.basename(item.entrada.name)));
  const lista = _aplicarPreferencia(codigo, _reordenarFotos(codigo, brutaZipVisivel).concat(brutaManualVisivel));
  const resultado = lista.map((item, i) => ({ indice: i, nomeArquivo: path.basename(item.entrada.name), oculta: false, manual: !!item.manual }));

  if (incluirOcultas) {
    for (const item of bruta) {
      const nomeArquivo = path.basename(item.entrada.name);
      if (setOcultas.has(nomeArquivo)) resultado.push({ indice: -1, nomeArquivo, oculta: true, manual: !!item.manual });
    }
  }
  return resultado;
}

/**
 * 2026-09-08: versão barata de "esse produto tem 2+ fotos?" pra decidir, em
 * lote (até 400 produtos por página de busca — ver LIMITE_PAGINA_PAINEL em
 * catalogo.controller.js), quais cards devem mostrar 2 fotos lado a lado
 * (mesma regra do PDF, ver temDuasFotos em catalogo-pdf.service.js). Só
 * consulta o índice em memória (Map já carregado, ver _garantirIndice) e
 * filtra ocultas — NÃO chama _reordenarFotos (lê cabeçalho JPEG, custo por
 * arquivo) nem extrairArquivo (descompacta a foto). Pode dar falso positivo
 * raríssimo se as 2 fotos "visíveis" contando aqui não forem jpeg/png
 * válidas (checado de verdade só na hora de servir a foto em si,
 * obterFoto) — aceitável: o pior caso é o 2º <img> do card quebrar/cair no
 * onerror do navegador, não afeta a 1ª foto nem o resto da página.
 */
function temMultiplasFotos(codigoProduto) {
  const idx = _garantirIndice();
  const codigo = String(codigoProduto);
  const bruta = (idx.get(codigo) || []).concat(_listaManual(codigo));
  if (bruta.length < 2) return false;
  const setOcultas = _garantirOcultas().get(codigo) || new Set();
  let visiveis = 0;
  for (const item of bruta) {
    if (!setOcultas.has(path.basename(item.entrada.name))) {
      visiveis += 1;
      if (visiveis >= 2) return true;
    }
  }
  return false;
}

/**
 * Oculta (oculta=true) ou restaura (oculta=false) uma foto do produto.
 * Nunca deixa ocultar a ÚLTIMA foto visível (trava contra o produto ficar
 * sem NENHUMA foto por acidente). Se a foto ocultada era a preferida
 * manual (ver definirFotoPreferida), a preferência é removida junto — não
 * faz sentido ficar "presa" numa foto que não aparece mais. Lança erro
 * "de negócio" (nomeArquivo inválido / última foto) — quem chama trata
 * como 400, não 500.
 */
function ocultarFoto(codigoProduto, nomeArquivo, oculta = true) {
  const idx = _garantirIndice();
  const codigo = String(codigoProduto);
  const original = (idx.get(codigo) || []).concat(_listaManual(codigo));
  const existe = original.some(item => path.basename(item.entrada.name) === nomeArquivo);
  if (!existe) {
    throw new Error(`"${nomeArquivo}" não é uma foto cadastrada do produto ${codigo}.`);
  }

  const todasOcultas = _garantirOcultas();
  const setCodigo = todasOcultas.get(codigo) || new Set();

  if (oculta) {
    const aindaVisiveisDepois = original.filter(item => {
      const nome = path.basename(item.entrada.name);
      return nome !== nomeArquivo && !setCodigo.has(nome);
    }).length;
    if (aindaVisiveisDepois === 0) {
      throw new Error("Não é possível ocultar a última foto do produto.");
    }
    setCodigo.add(nomeArquivo);
    todasOcultas.set(codigo, setCodigo);

    const prefs = _garantirPreferencias();
    if (prefs.get(codigo) === nomeArquivo) {
      prefs.delete(codigo);
      _salvarPreferencias();
    }
  } else {
    setCodigo.delete(nomeArquivo);
    if (setCodigo.size === 0) todasOcultas.delete(codigo);
  }

  if (ordemCache) ordemCache.delete(codigo);
  _salvarOcultas();
  return listarFotos(codigo, { incluirOcultas: true });
}

/**
 * Define (ou remove, se nomeArquivo for null/vazio) a foto preferida de um
 * produto — sempre exibida em 1º, por cima da ordenação automática. Lança
 * erro se nomeArquivo não corresponder a nenhuma foto real do produto
 * (evita salvar uma preferência que nunca vai bater com nada).
 */
function definirFotoPreferida(codigoProduto, nomeArquivo) {
  const idx = _garantirIndice();
  const codigo = String(codigoProduto);
  const prefs = _garantirPreferencias();

  if (!nomeArquivo) {
    prefs.delete(codigo);
    _salvarPreferencias();
    return listarFotos(codigo);
  }

  const original = (idx.get(codigo) || []).concat(_listaManual(codigo));
  const existe = original.some(item => path.basename(item.entrada.name) === nomeArquivo);
  if (!existe) {
    throw new Error(`"${nomeArquivo}" não é uma foto cadastrada do produto ${codigo}.`);
  }
  prefs.set(codigo, String(nomeArquivo));
  _salvarPreferencias();
  return listarFotos(codigo);
}

/**
 * Extrai uma foto específica de um produto (índice já na ordem final —
 * preferência manual > reordenação automática). Retorna
 * { buffer, mimetype } ou null se o produto/índice de foto não existir.
 */
function obterFoto(codigoProduto, indiceFoto = 0) {
  const idx = _garantirIndice();
  const codigo = String(codigoProduto);
  const originalZip = idx.get(codigo) || [];
  const originalManual = _listaManual(codigo);
  if (!originalZip.length && !originalManual.length) return null;
  const setOcultas = _garantirOcultas().get(codigo) || new Set();
  const visiveisZip = originalZip.filter(item => !setOcultas.has(path.basename(item.entrada.name)));
  const visiveisManual = originalManual.filter(item => !setOcultas.has(path.basename(item.entrada.name)));
  const lista = _aplicarPreferencia(codigo, _reordenarFotos(codigo, visiveisZip).concat(visiveisManual));
  if (!lista[indiceFoto]) return null;

  const item = lista[indiceFoto];
  let buffer;
  try {
    buffer = _extrairBytes(item);
  } catch (e) {
    console.error(`[catalogo-fotos.service] falha ao extrair foto (codigo=${codigoProduto}):`, e.message);
    return null;
  }
  const ext = path.extname(item.entrada.name).slice(1).toLowerCase();
  const mimetype = MIME_POR_EXT[ext] || "application/octet-stream";
  return { buffer, mimetype };
}

/**
 * Extrai uma foto pelo NOME do arquivo em vez do índice — usada pra
 * mostrar a miniatura de uma foto OCULTA (ver ocultarFoto acima), que não
 * tem posição estável na lista visível (por isso obterFoto/indice não
 * serve pra ela). Busca na lista BRUTA (sem filtrar ocultas), então também
 * funciona pra foto visível — reaproveitável.
 */
function obterFotoPorNome(codigoProduto, nomeArquivo) {
  const idx = _garantirIndice();
  const codigo = String(codigoProduto);
  const original = (idx.get(codigo) || []).concat(_listaManual(codigo));
  const item = original.find(it => path.basename(it.entrada.name) === nomeArquivo);
  if (!item) return null;

  let buffer;
  try {
    buffer = _extrairBytes(item);
  } catch (e) {
    console.error(`[catalogo-fotos.service] falha ao extrair foto por nome (codigo=${codigoProduto}, nome=${nomeArquivo}):`, e.message);
    return null;
  }
  const ext = path.extname(item.entrada.name).slice(1).toLowerCase();
  const mimetype = MIME_POR_EXT[ext] || "application/octet-stream";
  return { buffer, mimetype };
}

// PEDIDO DO USUÁRIO (2026-08-12): mesmo motivo de recarregarIndices() em
// catalogo-x2.service.js — "Atualizar Fotos" rodando sozinha (agendada)
// baixava fotos novas pro zip, mas esse índice (lazy, construído só na
// 1ª chamada) nunca sabia que o zip mudou — ficava servindo o índice
// velho até o bot reiniciar. Zera e reconstrói na hora (não lazy — devolve
// já pronto pra quem chamou, igual carregarEstoque() em estoque.service.js).
function recarregarIndice() {
  indice = null;
  ordemCache = null; // fotos novas podem mudar qual índice é "a grande"
  // preferencias e ocultas NÃO são zeradas aqui de propósito — são escolha
  // manual do atendente, independente do índice de zips ser reconstruído.
  return _garantirIndice();
}

/**
 * Salva uma foto enviada manualmente pelo atendente (upload, pedido do
 * usuário 2026-09-08) — pra produto que só tem 1 foto (ou nenhuma) no X2,
 * ou pra completar a galeria de qualquer produto. Fica em FOTOS_MANUAIS_DIR
 * (nunca em FOTOS_DIR — sobrevive a qualquer resync do X2). Decisão do
 * usuário: "só adiciona à lista" — não vira principal sozinha, o atendente
 * escolhe depois em "Trocar foto" se quiser promovê-la (definirFotoPreferida
 * já aceita nome de arquivo manual, ver acima).
 *
 * Valida o CONTEÚDO de verdade (magic bytes via _dimensoesImagem — mesmo
 * parser usado pra reordenar fotos do X2), não só a extensão do arquivo
 * enviado ou o mimetype que o navegador informou (esses dois são fáceis de
 * forjar/errar) — só aceita jpeg/png reais. Lança erro "de negócio" (arquivo
 * inválido/vazio/grande demais) — quem chama trata como 400, não 500.
 */
function adicionarFotoManual(codigoProduto, buffer) {
  const codigo = String(codigoProduto);
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(codigo)) {
    throw new Error("Código de produto inválido.");
  }
  if (!buffer || !buffer.length) {
    throw new Error("Arquivo vazio.");
  }
  if (buffer.length > MAX_TAMANHO_FOTO_MANUAL) {
    throw new Error(`Foto maior que o limite (${Math.round(MAX_TAMANHO_FOTO_MANUAL / 1024 / 1024)}MB).`);
  }
  const ehJpeg = !!_dimensoesJpeg(buffer);
  const ehPng = !ehJpeg && !!_dimensoesPng(buffer);
  if (!ehJpeg && !ehPng) {
    throw new Error("Não consegui reconhecer esse arquivo como uma foto JPG ou PNG válida.");
  }

  const pastaCodigo = path.join(FOTOS_MANUAIS_DIR, codigo);
  fs.mkdirSync(pastaCodigo, { recursive: true });
  const nomeArquivo = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ehJpeg ? "jpg" : "png"}`;
  fs.writeFileSync(path.join(pastaCodigo, nomeArquivo), buffer);

  indiceManual = null; // próxima leitura já enxerga o arquivo novo
  if (ordemCache) ordemCache.delete(codigo); // foto nova pode mudar quem é "grande" na reordenação
  versaoFotos = Date.now(); // bust de cache do navegador, igual troca/ocultar (ver comentário acima)

  return listarFotos(codigo, { incluirOcultas: true });
}

module.exports = { listarFotos, obterFoto, obterFotoPorNome, definirFotoPreferida, ocultarFoto, recarregarIndice, obterVersaoFotos, temMultiplasFotos, adicionarFotoManual };
