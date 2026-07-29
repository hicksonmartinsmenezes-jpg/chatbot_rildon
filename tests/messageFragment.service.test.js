/**
 * BUG CORRIGIDO (item #4 da análise de conversas em produção — fragmentação):
 * cliente manda o pedido em várias mensagens curtas seguidas ("Preciso de um
 * orçamento" / "Alternador" / "Corsa 2010") e o bot processava cada uma na
 * hora, avançando/respondendo com base em só o primeiro fragmento.
 * scheduleFragment() deve juntar fragmentos do mesmo usuário que chegam
 * dentro da janela de espera numa única chamada.
 */
jest.useFakeTimers();

const { scheduleFragment, clearPending, temPendente } = require("../src/services/messageFragment.service");

describe("messageFragment.service — agrupamento de mensagens fragmentadas", () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  it("mensagem única (sem fragmento seguinte) é processada sozinha após a janela", () => {
    const processar = jest.fn().mockResolvedValue(undefined);

    scheduleFragment("u1", { text: "Bom dia", messageId: "m1" }, processar);
    expect(processar).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2500);

    expect(processar).toHaveBeenCalledTimes(1);
    expect(processar).toHaveBeenCalledWith({ text: "Bom dia", messageId: "m1" });
  });

  it("três fragmentos rápidos do mesmo usuário viram uma única chamada com o texto combinado", () => {
    const processar = jest.fn().mockResolvedValue(undefined);

    scheduleFragment("u2", { text: "Preciso de um orçamento", messageId: "m1" }, processar);
    jest.advanceTimersByTime(500);
    scheduleFragment("u2", { text: "Alternador", messageId: "m2" }, processar);
    jest.advanceTimersByTime(500);
    scheduleFragment("u2", { text: "Corsa 2010 1.0", messageId: "m3" }, processar);

    // ainda dentro da janela desde o último fragmento — não processou
    jest.advanceTimersByTime(2000);
    expect(processar).not.toHaveBeenCalled();

    jest.advanceTimersByTime(600);

    expect(processar).toHaveBeenCalledTimes(1);
    expect(processar).toHaveBeenCalledWith({
      text: "Preciso de um orçamento\nAlternador\nCorsa 2010 1.0",
      messageId: "m3", // messageId do ÚLTIMO fragmento
    });
  });

  it("usuários diferentes não se misturam", () => {
    const processar = jest.fn().mockResolvedValue(undefined);

    scheduleFragment("clienteA", { text: "oi", messageId: "a1" }, processar);
    scheduleFragment("clienteB", { text: "olá", messageId: "b1" }, processar);

    jest.advanceTimersByTime(2500);

    expect(processar).toHaveBeenCalledTimes(2);
    expect(processar).toHaveBeenCalledWith({ text: "oi", messageId: "a1" });
    expect(processar).toHaveBeenCalledWith({ text: "olá", messageId: "b1" });
  });

  it("clearPending() cancela o processamento agendado", () => {
    const processar = jest.fn().mockResolvedValue(undefined);

    scheduleFragment("u3", { text: "teste", messageId: "m1" }, processar);
    expect(temPendente("u3")).toBe(true);

    clearPending("u3");
    expect(temPendente("u3")).toBe(false);

    jest.advanceTimersByTime(5000);
    expect(processar).not.toHaveBeenCalled();
  });

  it("fragmento chegando bem depois (fora da janela) vira uma NOVA mensagem isolada, não se junta à anterior", () => {
    const processar = jest.fn().mockResolvedValue(undefined);

    scheduleFragment("u4", { text: "primeira pergunta", messageId: "m1" }, processar);
    jest.advanceTimersByTime(2500);
    expect(processar).toHaveBeenCalledTimes(1);

    scheduleFragment("u4", { text: "segunda pergunta, minutos depois", messageId: "m2" }, processar);
    jest.advanceTimersByTime(2500);

    expect(processar).toHaveBeenCalledTimes(2);
    expect(processar).toHaveBeenLastCalledWith({ text: "segunda pergunta, minutos depois", messageId: "m2" });
  });
});
