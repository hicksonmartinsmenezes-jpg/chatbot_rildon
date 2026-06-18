const crypto = require("crypto");

function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  req.id = typeof incoming === "string" && incoming.length <= 80
    ? incoming
    : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

module.exports = requestId;
