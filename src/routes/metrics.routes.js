const express = require("express");
const { listTickets } = require("../services/ticket.service");

const router = express.Router();

function sameDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

router.get("/metrics", async (req, res) => {
  try {
     const tickets = await listTickets();

    const today = new Date();

    const total = tickets.length;

    const abertos = tickets.filter(t => t.status === "aberto").length;
    const andamento = tickets.filter(t => t.status === "em_andamento").length;
    const resolvidos = tickets.filter(t => t.status === "resolvido").length;
    const cancelados = tickets.filter(t => t.status === "cancelado").length;

    const hoje = tickets.filter(t => {
      if (!t.createdAt) return false;
      return sameDay(new Date(t.createdAt), today);
    }).length;

    const taxaResolucao = total > 0
      ? Math.round((resolvidos / total) * 100)
      : 0;

    const porStatus = {};
    const porSetor = {};
    const porDia = {};

    for (const ticket of tickets) {
      const status = ticket.status || "sem_status";
      const setor = ticket.sector || ticket.type || "geral";
      const dia = ticket.createdAt
        ? new Date(ticket.createdAt).toLocaleDateString("pt-BR")
        : "Sem data";

      porStatus[status] = (porStatus[status] || 0) + 1;
      porSetor[setor] = (porSetor[setor] || 0) + 1;
      porDia[dia] = (porDia[dia] || 0) + 1;
    }

    const setorMaisMovimentado = Object.entries(porSetor)
      .sort((a, b) => b[1] - a[1])[0] || ["—", 0];

    res.json({
      total,
      hoje,
      abertos,
      andamento,
      resolvidos,
      cancelados,
      pendentes: abertos + andamento,
      taxaResolucao,
      setorMaisMovimentado: {
        nome: setorMaisMovimentado[0],
        total: setorMaisMovimentado[1]
      },
      porStatus,
      porSetor,
      porDia
    });

  } catch (error) {
    console.error("Erro métricas:", error);

    res.status(500).json({
      error: "Erro ao carregar métricas."
    });
  }
});

module.exports = router;