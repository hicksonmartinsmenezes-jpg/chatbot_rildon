const { Server } = require("socket.io");
const logger = require("../utils/logger");

let io = null;
const onlineUsers = new Map();

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

  io.on("connection", socket => {
    logger.info(`Painel conectado em tempo real: ${socket.id}`);

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