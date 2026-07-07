-- Migration 011: autenticação de dois fatores (TOTP) para usuários do painel
--
-- totp_secret        : segredo base32 ATIVO (só existe quando totp_enabled = TRUE)
-- totp_pending_secret: segredo gerado durante o setup, antes de confirmar com um
--                      código válido — nunca autentica sozinho, só vira "secret"
--                      real depois da confirmação (evita ativar 2FA por engano
--                      com um segredo que o usuário nunca comprovou saber usar)
-- totp_enabled       : liga/desliga a exigência do segundo fator no login
-- totp_backup_codes  : códigos de recuperação de uso único (hash bcrypt, nunca
--                      texto puro) — usados se o usuário perder o dispositivo TOTP
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret         TEXT,
  ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_backup_codes   JSONB;

-- Desafios de 2FA pendentes entre "senha validada" e "código TOTP validado".
-- Token de vida curta (poucos minutos) — nunca abre sessão sozinho.
CREATE TABLE IF NOT EXISTS two_factor_challenges (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_expires ON two_factor_challenges(expires_at);
