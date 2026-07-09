-- Schema principal do Rildon Eletropeças Chatbot
-- Para novas instalações: psql -U <user> -d <db> -f schema.sql
-- Para ambientes existentes: use os arquivos em migrations/

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
  -- 2FA (TOTP) — ver migrations/011_add_totp_2fa.sql para o histórico
  totp_secret         TEXT,
  totp_pending_secret TEXT,
  totp_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  totp_backup_codes   JSONB,
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

-- Desafios de 2FA pendentes (entre senha validada e código TOTP validado)
CREATE TABLE IF NOT EXISTS two_factor_challenges (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_expires ON two_factor_challenges(expires_at);

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
-- Setores válidos: suporte, vendas, financeiro, garantia, geral, atendimento
-- Status válidos:  aberto, em_andamento, resolvido, cancelado
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
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ticket_status CHECK (status IN ('aberto','em_andamento','resolvido','cancelado')),
  CONSTRAINT chk_ticket_sector CHECK (sector IN ('suporte','vendas','financeiro','garantia','geral','atendimento'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id    ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_protocolo  ON tickets(protocolo);
CREATE INDEX IF NOT EXISTS idx_tickets_sector     ON tickets(sector);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_name ON tickets(assigned_to_name);
-- Sem ela, "ORDER BY created_at DESC" (usado em toda listagem/filtro de
-- tickets) cai em sort completo conforme a tabela cresce. Ver migration 012.
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);
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
  status       VARCHAR(50) DEFAULT NULL,  -- NULL = sem status; 'sent', 'delivered', 'read'
  message_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_user_id    ON history(user_id);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at);
CREATE INDEX IF NOT EXISTS idx_history_message_id ON history(message_id);
-- Composto: sem ele, "SELECT DISTINCT ON (user_id) ... ORDER BY user_id,
-- created_at DESC" (painel de Conversas, consultado a cada 30s) não
-- consegue usar um índice só de user_id nem só de created_at para resolver
-- a ordenação — cai em sort completo da tabela. Ver migration 012.
CREATE INDEX IF NOT EXISTS idx_history_user_created ON history(user_id, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at);


-- Auditoria de ações críticas
CREATE TABLE IF NOT EXISTS audit_logs (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT,
  user_name  TEXT,
  user_role  TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  details    JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs(user_id);

-- Mensagens já processadas (deduplicação)
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_at
ON processed_messages(processed_at);


-- Contatos / Agenda
CREATE TABLE IF NOT EXISTS contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome         VARCHAR(255) NOT NULL,
  whatsapp     VARCHAR(30) NOT NULL,
  estado       VARCHAR(2),
  status       VARCHAR(20) NOT NULL DEFAULT 'ativo',
  tags         TEXT[] NOT NULL DEFAULT '{}',
  atendente_id UUID REFERENCES users(id) ON DELETE SET NULL,
  departamento VARCHAR(100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp ON contacts(whatsapp);
CREATE INDEX IF NOT EXISTS idx_contacts_status   ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_nome     ON contacts(lower(nome));

-- Migration 013: tags (array) precisa de índice GIN, não btree; e
-- atendente_id é usado em filtro/JOIN sem índice nenhum antes disso.
CREATE INDEX IF NOT EXISTS idx_contacts_tags      ON contacts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_contacts_atendente ON contacts(atendente_id);

-- Mapa persistente @lid → @s.whatsapp.net
CREATE TABLE IF NOT EXISTS lid_map (
  lid        TEXT PRIMARY KEY,
  jid        TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lid_map_jid ON lid_map(jid);
CREATE INDEX IF NOT EXISTS idx_lid_map_updated ON lid_map(updated_at DESC);

-- Campanhas / Transmissões
CREATE TABLE IF NOT EXISTS broadcasts (
  id                SERIAL PRIMARY KEY,
  title             VARCHAR(255) NOT NULL,
  message           TEXT NOT NULL,
  image_url         TEXT,
  total_recipients  INTEGER NOT NULL DEFAULT 0,
  sent_count        INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  status            VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id            SERIAL PRIMARY KEY,
  broadcast_id  INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  contact_name  TEXT,
  status        VARCHAR(30) NOT NULL DEFAULT 'pending',
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_user      ON broadcast_recipients(user_id);

-- Controle de migrations (usado pelo runner src/database/migrate.js)
CREATE TABLE IF NOT EXISTS migrations_log (
  id         SERIAL PRIMARY KEY,
  filename   TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
