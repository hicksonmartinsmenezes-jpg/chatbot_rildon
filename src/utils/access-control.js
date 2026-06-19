/**
 * Regras centralizadas de acesso do painel.
 * Mantém a autorização no backend, não apenas no frontend.
 */
function normalizePerfil(user) {
  return String(user?.perfil || "").toLowerCase();
}

function isPrivileged(user) {
  const perfil = normalizePerfil(user);
  return perfil === "admin" || perfil === "supervisor" || perfil === "api";
}

function normalizeSector(value) {
  return String(value || "geral").trim().toLowerCase() || "geral";
}

function sameSector(user, ticket) {
  return normalizeSector(user?.sector || user?.setor) === normalizeSector(ticket?.sector);
}

function sameUserId(a, b) {
  return String(a || "") === String(b || "");
}

function attendantConversationsFullAccess() {
  // Por padrão, o painel Conversas do atendente deve enxergar e operar igual ao admin.
  // Para voltar ao modo restrito por setor/atribuição, defina no .env:
  // ATTENDANT_CONVERSATIONS_FULL_ACCESS=false
  return String(process.env.ATTENDANT_CONVERSATIONS_FULL_ACCESS || "true").toLowerCase() !== "false";
}

function canUseFullConversationPanel(user) {
  if (!user) return false;
  if (isPrivileged(user)) return true;
  return normalizePerfil(user) === "atendente" && attendantConversationsFullAccess();
}

function canAccessTicket(user, ticket, { allowUnassigned = false } = {}) {
  if (!user || !ticket) return false;
  if (isPrivileged(user)) return true;
  if (canUseFullConversationPanel(user)) return true;

  if (normalizePerfil(user) !== "atendente") return false;

  const assignedTo = ticket.assignedTo ?? ticket.assigned_to;
  if (sameUserId(assignedTo, user.id)) return true;

  return Boolean(allowUnassigned && !assignedTo && sameSector(user, ticket));
}

function canManageTicket(user, ticket) {
  if (!user || !ticket) return false;
  if (isPrivileged(user)) return true;
  if (canUseFullConversationPanel(user)) return true;

  if (normalizePerfil(user) !== "atendente") return false;
  const assignedTo = ticket.assignedTo ?? ticket.assigned_to;
  return sameUserId(assignedTo, user.id);
}

function canSeeSensitiveDashboard(user) {
  return isPrivileged(user);
}

function requireProfiles(...profiles) {
  const allowed = profiles.map(p => String(p).toLowerCase());
  return (req, res, next) => {
    const perfil = normalizePerfil(req.user);
    if (!req.user || !allowed.includes(perfil)) {
      return res.status(403).json({ error: "Acesso negado." });
    }
    return next();
  };
}

function requirePrivileged(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sessão inválida." });
  if (!isPrivileged(req.user)) {
    return res.status(403).json({ error: "Acesso permitido apenas para administradores ou supervisores." });
  }
  return next();
}

module.exports = {
  normalizePerfil,
  isPrivileged,
  normalizeSector,
  attendantConversationsFullAccess,
  canUseFullConversationPanel,
  canAccessTicket,
  canManageTicket,
  canSeeSensitiveDashboard,
  requireProfiles,
  requirePrivileged
};
