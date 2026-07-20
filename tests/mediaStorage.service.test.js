/**
 * Testes de mediaStorage.service.js — salvar em disco a mídia recebida do
 * cliente (foto/áudio/vídeo/sticker/documento) e resolver de volta o
 * caminho pra servir pelo painel (ver migration 017).
 *
 * Pedido do usuário (2026-07-20): "verifique por que arquivos de mídia e
 * áudio não aparecem no meu painel de atendimento". Resposta: decisão
 * deliberada de uma correção anterior (task #116) — nunca se salvava o
 * arquivo, só o rótulo "[tipo recebido]". Este módulo é a parte de disco
 * dessa feature nova.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

describe("mediaStorage.service", () => {
  let tmpDir;
  let mediaStorage;

  beforeEach(() => {
    jest.resetModules();
    // __dirname dentro do módulo aponta pra src/services — MEDIA_DIR real
    // seria src/media-recebida. Pra não escrever no repo de verdade durante
    // os testes, aponta __dirname pra uma pasta temporária via jest.spyOn
    // não é viável aqui (é calculado uma vez no require) — em vez disso,
    // testamos o módulo real mas limpamos os arquivos criados no afterEach.
    mediaStorage = require("../src/services/mediaStorage.service");
    tmpDir = mediaStorage.MEDIA_DIR;
  });

  afterEach(() => {
    // Limpa só os arquivos criados pelos testes (prefixo previsível),
    // nunca a pasta inteira — MEDIA_DIR é a pasta real do projeto.
    if (fs.existsSync(tmpDir)) {
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.startsWith("teste-msgid") || f.startsWith("path-traversal")) {
          fs.unlinkSync(path.join(tmpDir, f));
        }
      }
    }
  });

  test("salva o buffer em disco e devolve mediaPath (só o nome do arquivo, nunca o caminho completo)", async () => {
    const buffer = Buffer.from("conteudo-fake-de-imagem");
    const res = await mediaStorage.salvarMidiaRecebida(buffer, "image/jpeg", "teste-msgid-1");

    expect(res).not.toBeNull();
    expect(res.mediaPath).toMatch(/^teste-msgid-1-[0-9a-f]{8}\.jpg$/);
    expect(res.mediaMimetype).toBe("image/jpeg");
    expect(res.mediaPath).not.toContain(path.sep); // nunca um caminho, só o nome
    expect(res.mediaPath).not.toContain(os.tmpdir()); // nunca o caminho completo do disco

    const conteudoSalvo = fs.readFileSync(path.join(tmpDir, res.mediaPath));
    expect(conteudoSalvo.toString()).toBe("conteudo-fake-de-imagem");
  });

  test("mimetype com parâmetros (ex: 'audio/ogg; codecs=opus') ainda resolve a extensão certa", async () => {
    const res = await mediaStorage.salvarMidiaRecebida(
      Buffer.from("audio-fake"), "audio/ogg; codecs=opus", "teste-msgid-2"
    );
    expect(res.mediaPath).toMatch(/\.ogg$/);
  });

  test("mimetype desconhecido não quebra — usa um fallback sanitizado como extensão", async () => {
    const res = await mediaStorage.salvarMidiaRecebida(
      Buffer.from("bin-fake"), "application/x-estranho!!", "teste-msgid-3"
    );
    expect(res).not.toBeNull();
    expect(res.mediaPath).toMatch(/^teste-msgid-3-[0-9a-f]{8}\.[a-z0-9]+$/);
  });

  // BUG DE SEGURANÇA que este teste garante que NUNCA aconteça: messageId
  // vindo de uma mensagem adulterada/forjada não pode escrever fora de
  // MEDIA_DIR (path traversal via "../../").
  test("messageId com caracteres de path traversal é sanitizado antes de virar nome de arquivo", async () => {
    const res = await mediaStorage.salvarMidiaRecebida(
      Buffer.from("x"), "image/png", "../../../etc/path-traversal-teste"
    );
    expect(res).not.toBeNull();
    expect(res.mediaPath).not.toContain("..");
    expect(res.mediaPath).not.toContain("/");
    // O arquivo de fato foi criado DENTRO de MEDIA_DIR, não em /etc
    expect(fs.existsSync(path.join(tmpDir, res.mediaPath))).toBe(true);
  });

  test("buffer vazio ou nulo → null, não tenta escrever em disco", async () => {
    expect(await mediaStorage.salvarMidiaRecebida(null, "image/jpeg", "teste-msgid-4")).toBeNull();
    expect(await mediaStorage.salvarMidiaRecebida(Buffer.alloc(0), "image/jpeg", "teste-msgid-5")).toBeNull();
  });

  test("originalFilename (documento) é preservado em mediaFilename quando informado", async () => {
    const res = await mediaStorage.salvarMidiaRecebida(
      Buffer.from("pdf-fake"), "application/pdf", "teste-msgid-6",
      { originalFilename: "nota-fiscal.pdf" }
    );
    expect(res.mediaFilename).toBe("nota-fiscal.pdf");
  });

  test("resolverCaminhoMidia: devolve o caminho absoluto dentro de MEDIA_DIR pra um mediaPath válido", async () => {
    const salvo = await mediaStorage.salvarMidiaRecebida(Buffer.from("x"), "image/png", "teste-msgid-7");
    const resolvido = mediaStorage.resolverCaminhoMidia(salvo.mediaPath);
    expect(resolvido).toBe(path.join(tmpDir, salvo.mediaPath));
  });

  // Mesma proteção contra path traversal já usada no handler público de
  // /uploads/* em app.js — media_path nunca deveria conter "/", mas se um
  // valor malicioso chegasse até aqui (ex: dado corrompido no banco), a
  // função ainda barra qualquer resolução que escape de MEDIA_DIR.
  test("resolverCaminhoMidia: devolve null pra um mediaPath que tentaria escapar de MEDIA_DIR", () => {
    expect(mediaStorage.resolverCaminhoMidia("../../../etc/passwd")).toBeNull();
    expect(mediaStorage.resolverCaminhoMidia(null)).toBeNull();
    expect(mediaStorage.resolverCaminhoMidia("")).toBeNull();
  });
});
