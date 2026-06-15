const { Server } = require("socket.io");
const logger = require("../utils/logger");

let io = null;
const onlineUsers = new Map();

const COOKIE_NAME = "rildon_sid";

function extractTokenFromCookie(cookieHeader = "") {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setUserOnline(userId, socketId) {
  onlineUsers.set(userId, {
    socketId,
    online: true,
    lastSeen: new Date().toISOString()
  });
}

function setUserOffline(userId) {
  const user = onlineUsers.get(userId);

  if (user) {
    user.online = false;
    user.lastSeen = new Date().toISOString();
    onlineUsers.set(userId, user);
  }
}

function getOnlineUsers() {
  return Array.from(onlineUsers.entries()).map(([id, data]) => ({
    id,
    ...data
  }));
}

function initSocket(server) {
  const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
  io = new Server(server, {
    cors: {
      origin: allowedOrigin,
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

      setUserOnline(user.id, socket.id);
      io.emit("online_users", getOnlineUsers());
    });

    socket.on("disconnect", () => {
      logger.warn(`Painel desconectado: ${socket.id}`);

      for (const [id, data] of onlineUsers.entries()) {
        if (data.socketId === socket.id) {
          setUserOffline(id);
          io.emit("online_users", getOnlineUsers());
          break;
        }
      }
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
  getOnlineUsers
};