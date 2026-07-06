/**
 * Testes de dataHojeISO — a data de "hoje" no fuso do negócio, que define o
 * card "Encerrados hoje" do Dashboard. O ponto sensível é a FRONTEIRA de fuso:
 * um horário UTC pode ser "ontem" ou "amanhã" no fuso local. Sem TZ_NEGOCIO
 * definido, o padrão é America/Maceio (UTC-3, sem horário de verão) —
 * o que torna estes casos determinísticos.
 */
const { dataHojeISO } = require("../src/utils/horario");

describe("dataHojeISO", () => {
  test("formato ISO YYYY-MM-DD", () => {
    expect(dataHojeISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("meio do dia UTC → mesmo dia no fuso do negócio (UTC-3)", () => {
    // 10:00Z → 07:00 em Maceió, ainda dia 06.
    expect(dataHojeISO(new Date("2026-07-06T10:00:00Z"))).toBe("2026-07-06");
  });

  test("madrugada UTC cruza para o dia anterior no fuso local", () => {
    // 02:00Z → 23:00 do dia 05 em Maceió (UTC-3).
    expect(dataHojeISO(new Date("2026-07-06T02:00:00Z"))).toBe("2026-07-05");
  });

  test("virada de mês respeita o fuso", () => {
    // 01:00Z do dia 01 → 22:00 do dia 30 do mês anterior em Maceió.
    expect(dataHojeISO(new Date("2026-08-01T01:00:00Z"))).toBe("2026-07-31");
  });
});
