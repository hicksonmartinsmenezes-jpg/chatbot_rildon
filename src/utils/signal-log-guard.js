/**
 * Limita o barulho do libsignal (Baileys) no console.
 *
 * Quando uma sessão de criptografia de um contato fica fora de sincronia, o
 * libsignal imprime "Session error: Bad MAC" + stack trace para CADA tentativa
 * (centenas por segundo). Escrever isso no stdout trava o event loop do Node e
 * deixa o painel lento. Aqui deixamos passar no máximo 1 linha por tipo a cada
 * 60 s, avisando quantas foram suprimidas. Não altera nenhum comportamento de
 * descriptografia, só o que é impresso. (pedido do usuário, 2026-10-01)
 */
"use strict";

const JANELA_MS = 60 * 1000;
const PADROES = [
  [/^Session error:/, "session-error"],
  [/^Failed to decrypt message with any known session/, "decrypt-failed"],
  [/^Decrypted message with closed session/, "closed-session"],
  [/^Closing (open )?session in favor of incoming prekey bundle/, "closing-session"],
  [/^Closing session:/, "closing-session"],
  [/^Opening session:/, "opening-session"],
  [/^Removing old closed session/, "removing-session"],
  [/^Migrating session to:/, "migrating-session"],
];

const estado = new Map(); // chave -> { ultimo, suprimidas }

function chaveDe(args) {
  const primeiro = args[0];
  if (typeof primeiro !== "string") return null;
  for (const [re, chave] of PADROES) if (re.test(primeiro)) return chave;
  return null;
}

function instalar() {
  if (console.__signalGuardInstalado) return;
  for (const nivel of ["error", "warn", "info", "log"]) {
    const original = console[nivel].bind(console);
    console[nivel] = (...args) => {
      const chave = chaveDe(args);
      if (!chave) return original(...args);
      const agora = Date.now();
      const e = estado.get(chave) || { ultimo: 0, suprimidas: 0 };
      if (agora - e.ultimo >= JANELA_MS) {
        const extra = e.suprimidas ? ` (+${e.suprimidas} iguais suprimidas no último minuto)` : "";
        estado.set(chave, { ultimo: agora, suprimidas: 0 });
        // imprime só a 1ª linha, sem o stack trace
        return original(`${String(args[0]).split("\n")[0]}${extra}`);
      }
      e.suprimidas += 1;
      estado.set(chave, e);
    };
  }
  console.__signalGuardInstalado = true;
}

module.exports = { instalar };
