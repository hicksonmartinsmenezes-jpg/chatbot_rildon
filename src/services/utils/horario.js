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
  const inicio    = 7 * 60 + 50;  // 07:50
  const fimSemana = 17 * 60 + 50; // 17:50
  const fimSabado = 12 * 60;       // 12:00
  if (dia === 0) return false;
  if (dia === 6) return hm >= inicio && hm < fimSabado;
  return hm >= inicio && hm < fimSemana;
}

function mensagemForaDeHorario() {
  return (
    "🕐 *Fora do horário de atendimento*\n\n" +
    "No momento estamos fechados. Mas não se preocupe, seu atendimento foi registrado!\n\n" +
    "📅 *Horário de atendimento:*\n" +
    "Segunda a sexta: 07:50 às 17:50\n" +
    "Sábado: 07:50 às 12:00\n\n" +
    "Retornaremos assim que abrirmos. 😊\n\n" +
    "Digite *0* para voltar ao menu."
  );
}

module.exports = { estaEmHorarioDeAtendimento, mensagemForaDeHorario };
