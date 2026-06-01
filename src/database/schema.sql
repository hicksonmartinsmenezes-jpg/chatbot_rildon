CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS protocolo_seq START 1;

-- Usuários
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        VARCHAR(255) NOT NULL,
  usuario     VARCHAR(100) UNIQUE NOT NULL,
  senha       TEXT NOT NULL,
  perfil      VARCHAR(50) NOT NULL DEFAULT 'operador',
  sector      VARCHAR(100) NOT NULL DEFAULT 'geral',
  numero      VARCHAR(30) NOT NULL DEFAULT '',
  email       VARCHAR(255),
  foto        TEXT,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessões de autenticação
CREATE TABLE IF NOT EXISTS auth_sessions (
  token       TEXT PRIMARY KEY,
  user_data   JSONB NOT NULL,
  expires_at  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
ON auth_sessions(expires_at);

-- Sessões do bot
CREATE TABLE IF NOT EXISTS sessions (
  user_id     TEXT PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated
ON sessions(updated_at);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id                SERIAL PRIMARY KEY,
  protocolo         VARCHAR(50) UNIQUE NOT NULL,
  user_id           TEXT NOT NULL,
  customer_name     TEXT,
  cpf               VARCHAR(20),
  type              VARCHAR(100) NOT NULL,
  sector            VARCHAR(100) NOT NULL DEFAULT 'geral',
  description       TEXT,
  status            VARCHAR(50) NOT NULL DEFAULT 'aberto',
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id
ON tickets(user_id);

CREATE INDEX IF NOT EXISTS idx_tickets_status
ON tickets(status);

CREATE INDEX IF NOT EXISTS idx_tickets_protocolo
ON tickets(protocolo);

CREATE INDEX IF NOT EXISTS idx_tickets_cpf
ON tickets(REGEXP_REPLACE(cpf, '\D', '', 'g'));

-- Histórico
CREATE TABLE IF NOT EXISTS history (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  contact_name TEXT,
  message      TEXT,
  response     TEXT,
  sector       VARCHAR(100) NOT NULL DEFAULT 'geral',
  status       VARCHAR(50) NOT NULL DEFAULT '',
  message_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_user_id
ON history(user_id);

CREATE INDEX IF NOT EXISTS idx_history_created_at
ON history(created_at);

CREATE INDEX IF NOT EXISTS idx_history_message_id
ON history(message_id);

-- Respostas rápidas
CREATE TABLE IF NOT EXISTS quick_replies (
  id         SERIAL PRIMARY KEY,
  shortcut   VARCHAR(100) NOT NULL UNIQUE,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Configurações
CREATE TABLE IF NOT EXISTS settings (
  id         SERIAL PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Log de atividades
CREATE TABLE IF NOT EXISTS activity_logs (
  id          SERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  user_name   TEXT,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     TEXT,
  description TEXT,
  extra       JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created
ON activity_logs(created_at);

-- Mensagens já processadas
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_at
ON processed_messages(processed_at);