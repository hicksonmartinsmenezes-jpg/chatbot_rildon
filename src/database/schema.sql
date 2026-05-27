CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(120) NOT NULL,
  usuario VARCHAR(80) UNIQUE NOT NULL,
  senha TEXT NOT NULL,
  perfil VARCHAR(30) DEFAULT 'atendente',
  sector VARCHAR(80) DEFAULT 'geral',
  numero VARCHAR(30),
  foto TEXT,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo VARCHAR(40) UNIQUE NOT NULL,
  user_id VARCHAR(120),
  customer_name VARCHAR(120),
  cpf VARCHAR(30),
  type VARCHAR(80),
  sector VARCHAR(80),
  description TEXT,
  status VARCHAR(40) DEFAULT 'aberto',
  assigned_to UUID,
  assigned_to_name VARCHAR(120),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(120),
  contact_name VARCHAR(120),
  message TEXT,
  response TEXT,
  sector VARCHAR(80),
  status VARCHAR(40),
  message_id VARCHAR(120),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(120),
  user_name VARCHAR(120),
  action VARCHAR(120),
  description TEXT,
  extra JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut VARCHAR(80),
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(120) UNIQUE NOT NULL,
  value TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_status
ON tickets(status);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id
ON tickets(user_id);

CREATE INDEX IF NOT EXISTS idx_tickets_created_at
ON tickets(created_at);

CREATE INDEX IF NOT EXISTS idx_history_user_id
ON history(user_id);

CREATE INDEX IF NOT EXISTS idx_history_created_at
ON history(created_at);

CREATE INDEX IF NOT EXISTS idx_logs_created_at
ON activity_logs(created_at);