/**
 * Varredura 2026-10-15 — garante que o relatório não volte a misturar
 * recortes de tempo nem a esconder atendimentos:
 *  - resumo do mês com WHERE de período (antes vinha acumulado desde sempre);
 *  - "hoje" convertido no fuso do negócio dos dois lados da comparação;
 *  - fila atual (pendentes/em atendimento) vinda de query própria;
 *  - atendentes contados a partir dos TICKETS (admin que atende aparece);
 *  - mediana e cobertura de TMA/TME;
 *  - dias sem atendimento preenchidos com zero;
 *  - contatos novos no mês separados do acumulado de leads.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const { buscarMetricas } = require("../src/services/metrics.service");

const LIMITES = {
  mes_inicio: "2026-09-01T03:00:00.000Z",
  mes_fim: "2026-10-01T03:00:00.000Z",
  mes_anterior_inicio: "2026-08-01T03:00:00.000Z",
  janela_inicio: "2026-09-01T03:00:00.000Z",
  janela_fim: "2026-10-01T03:00:00.000Z"
};

/** Responde cada query pelo trecho de SQL que a identifica. */
function mockPool() {
  const sqls = [];
  pool.query.mockImplementation((sql) => {
    sqls.push(sql);
    const tem = (t) => sql.includes(t);
    if (tem("mes_anterior_inicio")) return { rows: [LIMITES] };
    if (tem("AS pendentes_agora")) return { rows: [{ pendentes_agora: 4, em_atendimento_agora: 2, tickets_no_banco: 806 }] };
    if (tem("AS mensal")) return { rows: [{ total: 195, abertos: 1, andamento: 0, resolvidos: 194, cancelados: 0, hoje: 3, mensal: 195 }] };
    if (tem("generate_series") && tem("FROM tickets")) return { rows: [{ dia: "01/09/2026", total: 2 }, { dia: "02/09/2026", total: 0 }] };
    if (tem("EXTRACT(HOUR")) return { rows: [{ hora: 9, total: 5 }] };
    if (tem("WITH agg AS")) {
      return { rows: [
        { id: "u1", nome: "Rafael", sem_atendente: false, fora_do_cadastro: false, ativo: true, total_atendidos: 515, em_atendimento: 0, atendidos_hoje: 0, atendidos_semana: 1, atendidos_mes: 158 },
        { id: "u2", nome: "Administrador", sem_atendente: false, fora_do_cadastro: false, ativo: true, total_atendidos: 28, em_atendimento: 1, atendidos_hoje: 0, atendidos_semana: 0, atendidos_mes: 30 },
        { id: null, nome: "Sem atendente", sem_atendente: true, fora_do_cadastro: false, ativo: true, total_atendidos: 239, em_atendimento: 0, atendidos_hoje: 0, atendidos_semana: 0, atendidos_mes: 7 }
      ] };
    }
    if (tem("AS tma_mediana_min")) {
      return { rows: [{
        tma_mediana_min: "42.0", tma_mediana_anterior_min: "60.0", tma_amostra: 221, tma_com_fechamento: 195,
        tme_mediana_min: "11.5", tme_mediana_anterior_min: "10.0", tme_amostra: 181, tickets_no_mes: 195,
        sla_resposta_dentro: 150, sla_resolucao_dentro: 100
      }] };
    }
    if (tem("leads_acumulado")) return { rows: [{ leads_acumulado: 346, novos_no_mes: 12 }] };
    if (tem("FROM history") && tem("generate_series")) return { rows: [{ dia: "01/09/2026", total: 40 }] };
    if (tem("FROM history")) return { rows: [{ total: 1200, recebidas: 700, enviadas: 500, clientes: 85 }] };
    if (tem("GROUP BY t.assigned_to")) return { rows: [{ nome: "Rafael", media: "4.71", total: 49 }] };
    if (tem("AVG(satisfaction_rating)")) return { rows: [{ media: "4.77", total: 60 }] };
    if (tem("satisfaction_feedback IS NOT NULL")) return { rows: [] };
    if (tem("mes_atual_total")) {
      return { rows: [{
        mes_atual_total: 195, mes_atual_resolvidos: 194, mes_atual_cancelados: 0,
        mes_anterior_total: 320, mes_anterior_resolvidos: 300,
        tempo_resolucao_atual_min: "7094.7", tempo_resolucao_anterior_min: "3968.5",
        tempo_resposta_atual_min: "4757.9", tempo_resposta_anterior_min: "100.0",
        avaliacoes_atual: 60, avaliacoes_mes_anterior: 100
      }] };
    }
    if (tem("GROUP BY satisfaction_rating")) return { rows: [{ nota: 5, total: 50 }] };
    if (tem("GROUP BY sector")) return { rows: [{ sector: "geral", total: 180 }] };
    if (tem("'YYYY-MM'")) return { rows: [{ mes: "2026-09", total: 195 }] };
    throw new Error(`query não prevista no teste: ${sql.slice(0, 80)}`);
  });
  return sqls;
}

describe("buscarMetricas — varredura 2026-10-15", () => {
  beforeEach(() => jest.clearAllMocks());

  test("resumo do mês é filtrado por período e não acumulado", async () => {
    const sqls = mockPool();
    const d = await buscarMetricas("2026-09");
    const resumo = sqls.find(s => s.includes("AS mensal"));
    expect(resumo).toMatch(/WHERE created_at >= \$1 AND created_at < \$2/);
    expect(d.total).toBe(195);
    expect(d.taxaResolucao).toBe(Math.round((194 / 195) * 100));
  });

  test('"hoje" compara os dois lados no fuso do negócio', async () => {
    const sqls = mockPool();
    await buscarMetricas("2026-09");
    const resumo = sqls.find(s => s.includes("AS hoje"));
    expect(resumo).toContain("(NOW() AT TIME ZONE $3)::date");
    expect(resumo).not.toContain("DATE(created_at) = CURRENT_DATE");
  });

  test("fila atual vem de query própria, sem recorte de mês", async () => {
    mockPool();
    const d = await buscarMetricas("2026-09");
    expect(d.pendentesAgora).toBe(4);
    expect(d.emAtendimentoAgora).toBe(2);
    expect(d.pendentes).toBe(4); // compatibilidade com o painel
  });

  test("atendentes incluem admin que atendeu e a linha sem atendente", async () => {
    mockPool();
    const d = await buscarMetricas("2026-09");
    const nomes = d.atendentes.map(a => a.nome);
    expect(nomes).toEqual(["Rafael", "Administrador", "Sem atendente"]);
    expect(d.atendentes.reduce((s, a) => s + a.atendidosMes, 0)).toBe(195); // fecha com o total do mês
    expect(d.atendentes.find(a => a.semAtendente)).toBeTruthy();
  });

  test("TMA/TME trazem mediana, variação e cobertura", async () => {
    mockPool();
    const { tendencia } = await buscarMetricas("2026-09");
    expect(tendencia.tempoResolucaoMedianaMin).toBe(42);
    expect(tendencia.tempoResolucaoMedianaVariacaoPct).toBe(-30);
    expect(tendencia.tempoRespostaMedianaMin).toBe(11.5);
    expect(tendencia.cobertura).toEqual({
      ticketsNoMes: 195, tmaAmostra: 221, tmaComFechamentoGravado: 195, tmeAmostra: 181
    });
    expect(tendencia.tempoResolucaoAtualMin).toBe(7094.7); // média continua disponível
  });

  test("gráfico por dia preenche dias sem atendimento", async () => {
    const sqls = mockPool();
    const d = await buscarMetricas("2026-09");
    expect(sqls.some(s => s.includes("generate_series"))).toBe(true);
    expect(d.porDia["02/09/2026"]).toBe(0);
  });

  test("contatos novos no mês separados do acumulado de leads", async () => {
    mockPool();
    const d = await buscarMetricas("2026-09");
    expect(d.novosContatosNoMes).toBe(12);
    expect(d.novosContatosLeads).toBe(346);
  });
});

describe("buscarMetricas — SLA e volume de mensagens (2026-10-15)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("SLA calcula o percentual dentro da meta", async () => {
    mockPool();
    const d = await buscarMetricas("2026-09");
    expect(d.sla.respostaPct).toBe(Math.round((150 / 181) * 100));
    expect(d.sla.resolucaoPct).toBe(Math.round((100 / 221) * 100));
    expect(d.sla.metaRespostaMin).toBe(15);
  });

  test("volume de mensagens vem do histórico, com quebra por dia", async () => {
    mockPool();
    const d = await buscarMetricas("2026-09");
    expect(d.mensagens.total).toBe(1200);
    expect(d.mensagens.recebidas).toBe(700);
    expect(d.mensagens.clientes).toBe(85);
    expect(d.mensagens.porDia["01/09/2026"]).toBe(40);
  });

  test("intervalo livre marca o rótulo de comparação", async () => {
    mockPool();
    const d = await buscarMetricas({ de: "2026-09-01", ate: "2026-09-15" });
    expect(d.periodo).toEqual({ de: "2026-09-01", ate: "2026-09-15", rotuloComparacao: "período anterior" });
  });
});
