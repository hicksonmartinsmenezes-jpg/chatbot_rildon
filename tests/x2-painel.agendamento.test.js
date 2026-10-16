/**
 * Agendamento das rotinas do Painel X2 — defeitos P1/P2/P3 da auditoria de
 * 14/10/2026:
 *  P1: rotina semanal perdia a semana inteira quando o dia passava com o
 *      painel fechado;
 *  P2: o horário era interpretado no fuso do PROCESSO (num servidor em UTC,
 *      "07:50" virava 04:50 de Brasília);
 *  P3: rotina "a cada N horas" media a partir do FIM da execução e deslizava.
 */
const path = require("path");
const os = require("os");
const fs = require("fs");

const TZ_NEGOCIO = "America/Maceio"; // UTC-3, sem horário de verão

function carregarModulo() {
  jest.resetModules();
  process.env.TZ_NEGOCIO = TZ_NEGOCIO;
  return require("../scripts/x2-painel/rotinas");
}

/** Instante UTC correspondente a uma hora de parede em America/Maceio. */
const emMaceio = (iso) => new Date(`${iso}-03:00`);

const SEMANAL = {
  id: "r1", nome: "Lançamentos da Semana", tipo: "lancamentos-x2", secoes: [], opcoes: {},
  frequencia: "semanal", horario: "07:50", diaSemana: 1, intervaloHoras: null,
  ativa: true, criadaEm: "2026-09-01T00:00:00.000Z",
  ultimaExecucao: "2026-10-05T10:51:00.000Z", ultimoResultado: "sucesso", ultimoErro: null
};

describe("deveRodarAgora — semanal (P1)", () => {
  let rotinas;
  beforeEach(() => { rotinas = carregarModulo(); });

  test("roda na segunda, depois do horário", () => {
    expect(rotinas.deveRodarAgora(SEMANAL, emMaceio("2026-10-12T07:51:00"))).toBe(true);
  });

  test("não roda na segunda antes do horário", () => {
    expect(rotinas.deveRodarAgora(SEMANAL, emMaceio("2026-10-12T07:49:00"))).toBe(false);
  });

  test("RECUPERA na terça quando a segunda passou com o painel fechado", () => {
    expect(rotinas.deveRodarAgora(SEMANAL, emMaceio("2026-10-13T08:00:00"))).toBe(true);
  });

  test("não roda de novo depois de já ter rodado na ocorrência da semana", () => {
    const jaRodou = { ...SEMANAL, ultimaExecucao: emMaceio("2026-10-12T07:52:00").toISOString() };
    expect(rotinas.deveRodarAgora(jaRodou, emMaceio("2026-10-13T08:00:00"))).toBe(false);
  });

  test("rotina nova não dispara por uma ocorrência anterior à própria criação", () => {
    const nova = { ...SEMANAL, ultimaExecucao: null, criadaEm: emMaceio("2026-10-14T09:00:00").toISOString() };
    expect(rotinas.deveRodarAgora(nova, emMaceio("2026-10-14T10:00:00"))).toBe(false);
  });

  test("rotina desativada nunca roda", () => {
    expect(rotinas.deveRodarAgora({ ...SEMANAL, ativa: false }, emMaceio("2026-10-13T08:00:00"))).toBe(false);
  });
});

describe("deveRodarAgora — fuso do negócio (P2)", () => {
  const TZ_ORIGINAL = process.env.TZ;
  afterEach(() => { process.env.TZ = TZ_ORIGINAL; });

  test("o horário vale no fuso do negócio mesmo com o processo em UTC", () => {
    const rotinas = carregarModulo();
    // 07:49 em Maceió = 10:49 UTC. Com a regra antiga (setHours no fuso do
    // processo), um servidor em UTC já consideraria vencido às 07:49 UTC.
    expect(rotinas.deveRodarAgora(SEMANAL, emMaceio("2026-10-12T07:49:00"))).toBe(false);
    expect(rotinas.deveRodarAgora(SEMANAL, new Date("2026-10-12T07:49:00Z"))).toBe(false);
  });

  test("a janela de recuperação da noite continua valendo", () => {
    const rotinas = carregarModulo();
    expect(rotinas.deveRodarAgora(SEMANAL, emMaceio("2026-10-12T23:00:00"))).toBe(true);
  });
});

describe("deveRodarAgora — a cada N horas (P3)", () => {
  let rotinas;
  beforeEach(() => { rotinas = carregarModulo(); });

  const PORHORA = {
    id: "r2", nome: "Estoque", tipo: "estoque", secoes: [], opcoes: {},
    frequencia: "horas", horario: null, diaSemana: null, intervaloHoras: 5,
    ativa: true, criadaEm: "2026-09-01T00:00:00.000Z"
  };

  test("mede a partir do INÍCIO, não do fim (sem deslize)", () => {
    const r = {
      ...PORHORA,
      ultimoInicio: "2026-10-15T08:00:00.000Z",
      ultimaExecucao: "2026-10-15T08:40:00.000Z" // levou 40 min
    };
    expect(rotinas.deveRodarAgora(r, new Date("2026-10-15T13:00:00Z"))).toBe(true);
    expect(rotinas.deveRodarAgora(r, new Date("2026-10-15T12:59:00Z"))).toBe(false);
  });

  test("sem ultimoInicio (rotina antiga), continua pelo fim", () => {
    const r = { ...PORHORA, ultimaExecucao: "2026-10-15T08:40:00.000Z" };
    expect(rotinas.deveRodarAgora(r, new Date("2026-10-15T13:30:00Z"))).toBe(false);
    expect(rotinas.deveRodarAgora(r, new Date("2026-10-15T13:41:00Z"))).toBe(true);
  });

  test("nunca executada roda na primeira checagem", () => {
    expect(rotinas.deveRodarAgora(PORHORA, new Date())).toBe(true);
  });
});

describe("registrarInicio", () => {
  let tmp, rotinas;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "x2-rotinas-"));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    rotinas = carregarModulo();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("marca a rotina como rodando e guarda o instante de início", () => {
    const criada = rotinas.criarRotina({
      nome: "Teste", tipo: "estoque", frequencia: "horas", intervaloHoras: 5, secoes: []
    });
    rotinas.registrarInicio(criada.id);
    const salva = rotinas.carregarRotinas().find((r) => r.id === criada.id);
    expect(salva.ultimoResultado).toBe("rodando");
    expect(salva.ultimoInicio).toBeTruthy();
    rotinas.registrarExecucao(criada.id, { resultado: "sucesso" });
    const depois = rotinas.carregarRotinas().find((r) => r.id === criada.id);
    expect(depois.ultimoResultado).toBe("sucesso");
    expect(depois.ultimoInicio).toBeTruthy(); // o início não é apagado no fim
  });
});
