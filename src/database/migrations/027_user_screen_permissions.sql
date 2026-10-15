-- Permissões de telas por usuário.
-- NULL/objeto vazio mantém o comportamento legado baseado no perfil.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.permissions IS
  'Mapa de permissões de telas do painel por usuário. Chaves são IDs das telas e valores booleanos.';
