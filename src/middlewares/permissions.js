const { requirePrivileged, requireProfiles } = require("../utils/access-control");

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sessão inválida." });
  if (String(req.user.perfil || "").toLowerCase() !== "admin") {
    return res.status(403).json({ error: "Acesso permitido apenas para administradores." });
  }
  return next();
}

module.exports = {
  requireAdmin,
  requirePrivileged,
  requireProfiles
};
