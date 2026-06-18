// contacts-utils.js
// Helpers puros usados pelo painel de contatos.

function formatContactPhone(num) {
  const d = String(num || "").replace(/\D/g, "");
  if (d.length === 13) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return num;
}

function contactInitials(nome) {
  const parts = String(nome || "?").trim().split(" ").filter(Boolean);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : parts[0].slice(0, 2).toUpperCase();
}

function contactAvatarColor(nome) {
  const colors = ["#1d6cf5","#7c3aed","#db2777","#059669","#d97706","#0891b2"];
  let h = 0;
  for (let i = 0; i < (nome || "").length; i++) h = (h * 31 + nome.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}

function contactStatusClass(s) {
  const map = { ativo: "ct-status-ativo", inativo: "ct-status-inativo", bloqueado: "ct-status-bloqueado" };
  return map[s] || "ct-status-inativo";
}

function contactStatusLabel(s) {
  const map = { ativo: "Ativo", inativo: "Inativo", bloqueado: "Bloqueado" };
  return map[s] || "Inativo";
}
