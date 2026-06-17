-- Migration 009: Tabela de contatos
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
