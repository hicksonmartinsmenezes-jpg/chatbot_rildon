const { Server } = require("socket.io");
const logger = require("../utils/logger");

let io = null;
// userId -> { sockets:Set<string>, online:boolean, lastSeen:string, user?:object }
const onlineUsers = new Map();

const COOKIE_NAME = "rildon_sid";

function extractTokenFromCookie(cookieHeader = "") {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setUserOnline(userId, socketId, user = null) {
  if (!userId || !socketId) return;
  const id = String(userId);
  const current = onlineUsers.get(id) || { sockets: new Set(), online: false, lastSeen: null, user: null };
  current.sockets.add(socketId);
  current.online = true;
  current.lastSeen = new Date().toISOString();
  if (user) current.user = user;
  onlineUsers.set(id, current);
}

function setSocketOffline(socketId) {
  if (!socketId) return null;
  for (const [id, data] of onlineUsers.entries()) {
    if (!data.sockets?.has(socketId)) continue;

    data.sockets.delete(socketId);
    data.lastSeen = new Date().toISOString();
    data.online = data.sockets.size > 0;

    if (data.online) onlineUsers.set(id, data);
    else onlineUsers.set(id, data);

    return id;
  }
  return null;
}

function setUserOffline(userId) {
  const id = String(userId || "");
  const user = onlineUsers.get(id);

  if (user) {
    user.sockets = new Set();
    user.online = false;
    user.lastSeen = new Date().toISOString();
    onlineUsers.set(id, user);
  }
}

function getOnlineUsers() {
  return Array.from(onlineUsers.entries()).map(([id, data]) => ({
    id,
    online: Boolean(data.online && data.sockets?.size > 0),
    connections: data.sockets?.size || 0,
    lastSeen: data.lastSeen,
    user: data.user || null
  }));
}

function initSocket(server) {
  // Suporta múltiplas origens separadas por vírgula (consistente com app.js)
  const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",").map(s => s.trim()).filter(Boolean);
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  // Autenticação via cookie de sessão — rejeita conexões sem sessão válida
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie || "";
      const token = extractTokenFromCookie(cookieHeader);
      if (!token) return next(new Error("Não autenticado."));

      // Importação lazy para evitar dependência circular na inicialização
      const { buscarSessao } = require("../routes/auth.routes");
      const session = await buscarSessao(token);
      if (!session) return next(new Error("Sessão inválida ou expirada."));

      socket.user = session.user;
      next();
    } catch (err) {
      logger.error(`[Socket] Erro na autenticação: ${err.message}`);
      next(new Error("Erro de autenticação."));
    }
  });

  io.on("connection", socket => {
    logger.info(`Painel conectado: ${socket.id} (user: ${socket.user?.usuario || socket.user?.nome || "?"})`);

    socket.on("user_online", user => {
      if (!user?.id) return;

      setUserOnline(user.id, socket.id, user);
      io.emit("online_users", getOnlineUsers());
    });

    socket.on("disconnect", () => {
      logger.warn(`Painel desconectado: ${socket.id}`);

      const changedUserId = setSocketOffline(socket.id);
      if (changedUserId) io.emit("online_users", getOnlineUsers());
    });
  });
}

function emitEvent(event, data = {}) {
  if (!io) return;
  io.emit(event, data);
}

module.exports = {
  initSocket,
  emitEvent,
  setUserOnline,
  setUserOffline,
  setSocketOffline,
  getOnlineUsers
};