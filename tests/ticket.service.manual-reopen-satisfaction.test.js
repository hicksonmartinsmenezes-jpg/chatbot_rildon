/**
 * Testes de updateTicketStatus() — reabertura MANUAL (botão "Reabrir" no
 * painel, via patchTicket) preservando a nota de satisfação.
 *
 * PEDIDO DO USUÁRIO (2026-07-27): "existem conversas que reabrem onde já
 * deram nota de atendimento. Quando fecharem, a pesquisa disparará de novo
 * — o cliente responde duas vezes". Isso já era resolvido pra reabertura
 * AUTOMÁTICA (reopenTicketIfClosed, ver ticket.service.reopen-window.test.js)
 * mas não pra reabertura MANUAL, que sempre resetava os campos de
 * satisfação (resetSatisfaction:true, o padrão do repository).
 *
 * DECISÃO (discutida com o usuário — descartei um botão manual "Fechar sem
 * pesquisa" por depender do atendente lembrar de usar o certo toda vez):
 * reabertura manual de um ticket avaliado HÁ POUCO TEMPO (mesma janela de
 * TICKET_REOPEN_WINDOW_MINUTOS já usada pro reopen automático, padrão
 * 240min/4h — pedido do usuário em 2026-09-19, era 60min) preserva a nota
 * — fechar de novo não reenvia a pesquisa.
 * Reabertura de um ticket avaliado há muito tempo (ou nunca avaliado)
 * continua resetando normalmente, como antes.
 */
jest.mock("../src/repositories/ticket.repository", () => ({
  updateStatus: jest.fn(),
}));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    atendimento: { tempoReaberturaSemPesquisa: 240 },
  }),
}));

const ticketRepository = require("../src/repositories/ticket.repository");
const { updateTicketStatus, foiReabertoManualmenteRecente } = require("../src/services/ticket.service");

function ticketAvaliado(minutosAtras, overrides = {}) {
  return {
    id: 42,
    protocolo: "2026-0042",
    userId: "cliente-1",
    status: "resolvido",
    satisfactionRating: 5,
    satisfactionRatedAt: new Date(Date.now() - minutosAtras * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("updateTicketStatus — reabertura manual preserva satisfação recente", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketRepository.updateStatus.mockResolvedValue({ id: 42, status: "aberto" });
  });

  test("reabrir (status=aberto) ticket avaliado há 5min (dentro da janela) → preserva satisfação", async () => {
    await updateTicketStatus(42, "aberto", { ticketAtual: ticketAvaliado(5) });

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: false });
  });

  test("reabrir ticket avaliado há 59min (limite da janela) → ainda preserva", async () => {
    await updateTicketStatus(42, "aberto", { ticketAtual: ticketAvaliado(59) });

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: false });
  });

  test("reabrir ticket avaliado há 3 dias (bem fora da janela) → reseta normalmente", async () => {
    await updateTicketStatus(42, "aberto", { ticketAtual: ticketAvaliado(3 * 24 * 60) });

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: true });
  });

  test("reabrir ticket resolvido mas NUNCA avaliado (satisfactionRatedAt null) → reseta normalmente", async () => {
    await updateTicketStatus(42, "aberto", {
      ticketAtual: ticketAvaliado(5, { satisfactionRatedAt: null }),
    });

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: true });
  });

  test("reabrir ticket que não estava resolvido (ex: cancelado) → reseta normalmente, mesmo com nota antiga", async () => {
    await updateTicketStatus(42, "aberto", {
      ticketAtual: ticketAvaliado(5, { status: "cancelado" }),
    });

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: true });
  });

  test("sem ticketAtual (não fornecido) → reseta normalmente (fail-safe)", async () => {
    await updateTicketStatus(42, "aberto");

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: true });
  });

  test("fechar (status=resolvido) → resetSatisfaction sempre true (ignorado pelo repository nesse caso, mas mantém o comportamento antigo)", async () => {
    await updateTicketStatus(42, "resolvido", { ticketAtual: ticketAvaliado(5) });

    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "resolvido", { resetSatisfaction: true });
  });
});

// PEDIDO DO USUÁRIO (2026-07-27): "quando clicar em reabrir não mande a
// saudação com o nome do funcionário nem a pesquisa de satisfação por
// determinado tempo" — cobre tickets fechados/avaliados há DIAS (fora do
// escopo do describe acima, que só preserva quando a AVALIAÇÃO em si foi
// recente). O relógio começa no clique em "Reabrir", não em quando foi
// avaliado antes — rastreado à parte por foiReabertoManualmenteRecente(),
// consultado depois por assumirTicket/patchTicket (ticket.controller.js).
describe("foiReabertoManualmenteRecente — janela pra pular saudação/pesquisa após reabertura manual", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketRepository.updateStatus.mockResolvedValue({ id: 999, status: "aberto" });
  });

  // BUG CORRIGIDO (Issue #7, 2026-08-17): foiReabertoManualmenteRecente() é
  // async (consulta settings.service pra saber a janela configurada — ver
  // _getReopenWindowMs() em ticket.service.js), então sempre retorna uma
  // Promise. Os testes deste describe comparavam a Promise direto contra
  // true/false sem "await" — passava "por acidente" no sandbox local (onde
  // esta suíte nem chegava a rodar, por falta de Postgres real), mas falha
  // sempre que executado de verdade (inclusive no CI, contra Postgres real).
  test("ticket nunca reaberto manualmente → false", async () => {
    expect(await foiReabertoManualmenteRecente(999)).toBe(false);
  });

  test("updateTicketStatus(id, 'aberto', ...) numa reabertura genuína (ticketAtual resolvido) marca o relógio — foiReabertoManualmenteRecente vira true logo em seguida", async () => {
    await updateTicketStatus(999, "aberto", {
      ticketAtual: { id: 999, status: "resolvido", satisfactionRatedAt: null },
    });

    expect(await foiReabertoManualmenteRecente(999)).toBe(true);
  });

  test("ticket avaliado há DIAS (fora da janela de _deveManterSatisfacaoAoReabrir) — reabertura manual AINDA marca o relógio novo", async () => {
    const avaliadoHaDias = {
      id: 999,
      status: "resolvido",
      satisfactionRatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await updateTicketStatus(999, "aberto", { ticketAtual: avaliadoHaDias });

    // resetSatisfaction ainda true (nota antiga não é preservada — comportamento
    // do describe acima, inalterado), mas o NOVO relógio de reabertura manual
    // (independente disso) já está ativo.
    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(999, "aberto", { resetSatisfaction: true });
    expect(await foiReabertoManualmenteRecente(999)).toBe(true);
  });

  test("status='aberto' mas ticketAtual JÁ estava aberto/em_andamento (não é uma reabertura de verdade) → não marca o relógio", async () => {
    // Ticket id próprio (1000), não reaproveitado dos testes anteriores
    // deste describe — o Map interno não é limpo entre testes (mesmo
    // padrão de dedup.js/humanMode.service.js), então usar o 999 aqui
    // pegaria o relógio já marcado por um teste anterior.
    await updateTicketStatus(1000, "aberto", {
      ticketAtual: { id: 1000, status: "em_andamento" },
    });

    expect(await foiReabertoManualmenteRecente(1000)).toBe(false);
  });

  test("expira sozinho depois da janela (TICKET_REOPEN_WINDOW_MINUTOS, padrão 240min/4h)", async () => {
    await updateTicketStatus(999, "aberto", {
      ticketAtual: { id: 999, status: "resolvido", satisfactionRatedAt: null },
    });
    expect(await foiReabertoManualmenteRecente(999)).toBe(true);

    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => realNow + 241 * 60 * 1000);
    try {
      expect(await foiReabertoManualmenteRecente(999)).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
