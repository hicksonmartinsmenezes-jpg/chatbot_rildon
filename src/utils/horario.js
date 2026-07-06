// FIX: usar TZ_NEGOCIO (nome correto no .env) — antes usava TZ_ATENDIMENTO que não existe
const TIMEZONE = process.env.TZ_NEGOCIO || "America/Maceio";

function agoraInfo() {
  const date = new Date();
  const hora = Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(date)
  );
  const min = Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, minute: "2-digit" }).format(date)
  );
  const diaTexto = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" }).format(date);
  const mapa = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dia: mapa[diaTexto], hora, min, hm: hora * 60 + min };
}

function estaEmHorarioDeAtendimento() {
  const { dia, hm } = agoraInfo();
  const inicioSemana = 7 * 60 + 50;  // 07:50 — seg a sex
  const inicioSabado = 8 * 60;        // 08:00 — sábado (alinhado com empresa.js e menu)
  const fimSemana    = 17 * 60 + 50;  // 17:50
  const fimSabado    = 12 * 60;        // 12:00

  if (dia === 0) return false;                                          // domingo: fechado
  if (dia === 6) return hm >= inicioSabado && hm < fimSabado;          // sábado
  return hm >= inicioSemana && hm < fimSemana;                          // seg–sex
}

// ── Retorna quando a loja vai reabrir (para exibir ao cliente) ─────────────────
function proximoAtendimento() {
  const { dia, hm } = agoraInfo();

  // Antes de abrir: informa que abre mais tarde hoje
  if (dia >= 1 && dia <= 5 && hm < 7 * 60 + 50) return "hoje às *07:50h*";
  if (dia === 6 && hm < 8 * 60)                  return "hoje às *08:00h*";

  // Sábado após fechar, sexta após fechar ou domingo → segunda-feira
  if (dia === 0 ||
      (dia === 6 && hm >= 12 * 60) ||
      (dia === 5 && hm >= 17 * 60 + 50)) {
    return "segunda-feira às *07:50h*";
  }

  // Seg–Qui após fechar → próximo dia útil (dia+1 é sempre um dia útil aqui)
  const nomes = ["", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira"];
  return `${nomes[dia + 1]} às *07:50h*`;
}

// Data de "hoje" no fuso do negócio, em formato ISO (YYYY-MM-DD).
// Usada por cards "do dia" (ex.: Encerrados hoje no Dashboard). Aceita uma data
// opcional para testes determinísticos.
function dataHojeISO(date = new Date()) {
  // en-CA formata como YYYY-MM-DD; o timeZone garante o dia correto no fuso do negócio.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function mensagemForaDeHorario() {
  return (
    "🕐 *Fora do horário de atendimento*\n\n" +
    `Estamos fechados agora, mas voltamos ${proximoAtendimento()}! 😊\n\n` +
    "📅 *Horário de atendimento:*\n" +
    "Segunda a sexta: 07:50 às 17:50\n" +
    "Sábado: 08:00 às 12:00\n\n" +
    "_Você pode deixar sua mensagem que respondemos assim que abrirmos._\n\n" +
    "Digite *0* para ver o menu."
  );
}

module.exports = { estaEmHorarioDeAtendimento, mensagemForaDeHorario, proximoAtendimento, dataHojeISO };
