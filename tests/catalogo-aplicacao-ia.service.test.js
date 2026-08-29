/**
 * Testes de catalogo-aplicacao-ia.service.js (Issue #23, 2026-08-26) — cache
 * em disco (mockado em memória aqui) do texto de "aplicação" já organizado
 * pela IA, com dedup por texto cru (produtos diferentes que compartilham o
 * MESMO texto de aplicação processam a IA uma única vez).
 *
 * `fs` é mockado com um "arquivo" em memória (Map de path→conteúdo) — evita
 * tocar o cache real em disco (src/config/catalogo-x2/aplicacao-ia-cache.json)
 * durante os testes. ai.service#organizarAplicacaoIA também é mockado, pra
 * controlar exatamente quantas vezes é chamado (é isso que o dedup/cache
 * está testando) sem depender de rede de verdade.
 */

jest.mock("../src/services/ai.service", () => ({
  organizarAplicacaoIA: jest.fn(),
}));

describe("catalogo-aplicacao-ia.service — anexarAplicacoesOrganizadas", () => {
  let anexarAplicacoesOrganizadas;
  let organizarAplicacaoIA;
  let memFs;

  beforeEach(() => {
    jest.resetModules();
    memFs = new Map(); // path -> string

    jest.doMock("fs", () => {
      const real = jest.requireActual("fs");
      const CACHE_PATH_HINT = "aplicacao-ia-cache.json";
      // Só intercepta operações no arquivo de cache desta feature — todo o
      // resto (logger.js criando pasta de logs, etc.) usa o fs real, sem
      // precisar mockar o módulo inteiro.
      return {
        ...real,
        existsSync: (p) => (String(p).includes(CACHE_PATH_HINT) ? memFs.has(p) : real.existsSync(p)),
        readFileSync: (p, ...rest) => {
          if (String(p).includes(CACHE_PATH_HINT)) {
            if (!memFs.has(p)) throw new Error("ENOENT");
            return memFs.get(p);
          }
          return real.readFileSync(p, ...rest);
        },
        writeFileSync: (p, content, ...rest) => {
          if (String(p).includes(CACHE_PATH_HINT)) { memFs.set(p, content); return; }
          return real.writeFileSync(p, content, ...rest);
        },
        renameSync: (from, to) => {
          if (String(to).includes(CACHE_PATH_HINT)) {
            memFs.set(to, memFs.get(from));
            memFs.delete(from);
            return;
          }
          return real.renameSync(from, to);
        },
      };
    });

    ({ organizarAplicacaoIA } = require("../src/services/ai.service"));
    ({ anexarAplicacoesOrganizadas } = require("../src/services/catalogo-aplicacao-ia.service"));
    organizarAplicacaoIA.mockReset();
  });

  test("produto sem `aplicacao` é ignorado — não conta nem chama IA", async () => {
    const produtos = [{ codigo: "1", nome: "Peça sem aplicação" }];

    const resultado = await anexarAplicacoesOrganizadas(produtos);

    expect(resultado.totalUnicos).toBe(0);
    expect(organizarAplicacaoIA).not.toHaveBeenCalled();
    expect(produtos[0].aplicacaoOrganizada).toBeUndefined();
  });

  test("dedup: 3 produtos com o MESMO texto de aplicação → IA chamada 1 única vez", async () => {
    organizarAplicacaoIA.mockResolvedValue("FORD: Escort; VW: Uno");
    const texto = "Escort, Uno, Ford, VW";
    const produtos = [
      { codigo: "1", aplicacao: texto },
      { codigo: "2", aplicacao: texto },
      { codigo: "3", aplicacao: texto },
    ];

    const resultado = await anexarAplicacoesOrganizadas(produtos);

    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1);
    expect(resultado.totalUnicos).toBe(1);
    expect(resultado.novosComSucesso).toBe(1);
    // Todos os 3 produtos recebem o mesmo resultado organizado.
    for (const p of produtos) expect(p.aplicacaoOrganizada).toBe("FORD: Escort; VW: Uno");
  });

  test("cache hit: 2ª chamada com o mesmo texto NÃO chama a IA de novo", async () => {
    organizarAplicacaoIA.mockResolvedValue("FORD: Escort");
    const texto = "Escort, Ford";

    await anexarAplicacoesOrganizadas([{ codigo: "1", aplicacao: texto }]);
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1);

    // Mesmo texto, produto DIFERENTE, chamada SEPARADA (simula uma 2ª
    // exportação de PDF depois que o cache já foi salvo em disco).
    const produtos2 = [{ codigo: "2", aplicacao: texto }];
    const resultado2 = await anexarAplicacoesOrganizadas(produtos2);

    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1); // não subiu pra 2
    expect(resultado2.jaEmCache).toBe(1);
    expect(produtos2[0].aplicacaoOrganizada).toBe("FORD: Escort");
  });

  test("maxNovos limita quantos textos NOVOS são processados nessa chamada", async () => {
    organizarAplicacaoIA.mockResolvedValue("organizado");
    const produtos = [
      { codigo: "1", aplicacao: "texto A" },
      { codigo: "2", aplicacao: "texto B" },
      { codigo: "3", aplicacao: "texto C" },
    ];

    const resultado = await anexarAplicacoesOrganizadas(produtos, { maxNovos: 1 });

    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1);
    expect(resultado.totalUnicos).toBe(3);
    expect(resultado.novosProcessados).toBe(1);
    // Só 1 dos 3 produtos ganhou aplicacaoOrganizada nessa rodada.
    const comOrganizada = produtos.filter(p => p.aplicacaoOrganizada);
    expect(comOrganizada.length).toBe(1);
  });

  test("falha da IA (retorna null) → produto fica sem aplicacaoOrganizada, sem lançar erro", async () => {
    organizarAplicacaoIA.mockResolvedValue(null);
    const produtos = [{ codigo: "1", aplicacao: "texto qualquer" }];

    await expect(anexarAplicacoesOrganizadas(produtos)).resolves.toBeDefined();
    expect(produtos[0].aplicacaoOrganizada).toBeUndefined();
  });

  test("falha da IA fica marcada em cache — não tenta de novo o mesmo texto que já falhou", async () => {
    organizarAplicacaoIA.mockResolvedValue(null);
    const texto = "texto que sempre falha";

    await anexarAplicacoesOrganizadas([{ codigo: "1", aplicacao: texto }]);
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1);

    await anexarAplicacoesOrganizadas([{ codigo: "2", aplicacao: texto }]);
    // Já "tentou e falhou" fica em cache como "" — não tenta de novo à toa.
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1);
  });

  // Regressão do bug real de 2026-08-29: um lote grande rodou sem crédito
  // na API no meio do caminho, organizarAplicacaoIA retornava null pra
  // TODO tipo de falha (sem distinguir "não tentei de verdade" de "tentei
  // e não deu"), e isso gravava ~49% do cache como "sem aplicação" pra
  // sempre — nem recarregar crédito e rodar de novo destravava, porque o
  // hash já contava como "já tentado". Fix: organizarAplicacaoIA agora
  // retorna undefined pra "não tentei de verdade" (sem chave, circuit
  // breaker, erro de rede/HTTP) — esse teste garante que ESSE caso
  // específico NÃO fica preso em cache.
  test("skip real da IA (undefined) NÃO fica em cache — tenta de novo na próxima chamada", async () => {
    organizarAplicacaoIA.mockResolvedValue(undefined);
    const texto = "texto sem crédito pra processar ainda";

    const r1 = await anexarAplicacoesOrganizadas([{ codigo: "1", aplicacao: texto }]);
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(1);
    expect(r1.jaEmCache).toBe(0); // não ficou em cache — undefined não conta como "já tentado"

    // 2ª chamada com o MESMO texto: precisa tentar de novo (não pode ter
    // ficado marcado como "" permanentemente).
    await anexarAplicacoesOrganizadas([{ codigo: "2", aplicacao: texto }]);
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(2);

    // Agora simula o crédito recarregado — sucesso real na 3ª tentativa —
    // e confirma que dali em diante ENTRA no cache normalmente.
    organizarAplicacaoIA.mockResolvedValue("FORD: Escort");
    const r3 = await anexarAplicacoesOrganizadas([{ codigo: "3", aplicacao: texto }]);
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(3);
    expect(r3.novosComSucesso).toBe(1);

    const r4 = await anexarAplicacoesOrganizadas([{ codigo: "4", aplicacao: texto }]);
    expect(organizarAplicacaoIA).toHaveBeenCalledTimes(3); // agora sim ficou em cache
    expect(r4.jaEmCache).toBe(1);
    expect(r4.novosComSucesso).toBe(0);
  });
});
