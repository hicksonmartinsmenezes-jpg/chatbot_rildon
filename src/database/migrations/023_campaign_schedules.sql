-- Migration 023: campaign_schedules — campanhas agendadas (única ou recorrente)
-- Aplicar com: psql -U <user> -d <db> -f migrations/023_campaign_schedules.sql
--
-- Pedido do usuário (2026-08-03): "preciso que no meu campanhas eu tenha
-- opção de repetir campanha ou agendar" — confirmado que precisa dos DOIS:
-- (a) agendar pra uma data/hora futura única, (b) recorrência automática
-- (diária/semanal/mensal), sem precisar recriar a campanha toda vez.
--
-- Por que uma tabela separada de `broadcasts` (em vez de só adicionar
-- scheduled_at nela): `broadcasts`/`broadcast_recipients` guardam a lista de
-- destinatários JÁ RESOLVIDA no momento da criação — funciona bem pra envio
-- imediato, mas uma campanha recorrente precisa RECALCULAR a audiência a
-- cada disparo (ex: "Contatos Gustavo" pode ter gente nova daqui a 1 mês).
-- Por isso aqui guardamos o FILTRO (tipo + tags + atendente), não uma lista
-- congelada — exceto pra audiência "custom" (lista manual), que já é
-- inerentemente uma lista fixa mesmo hoje em dia.
--
-- Quando um agendamento dispara: cria uma linha normal em `broadcasts` (via
-- broadcast.service.js/createBroadcast, resolvendo a audiência na hora) e
-- envia — ou seja, cada disparo de uma campanha recorrente gera um
-- broadcast histórico próprio, visível na lista normal de campanhas.
--
-- Seguro de aplicar: só cria tabela nova, não toca em nada existente.

CREATE TABLE IF NOT EXISTS campaign_schedules (
  id                  SERIAL PRIMARY KEY,
  title               VARCHAR(255) NOT NULL,
  message             TEXT NOT NULL,
  image_url           TEXT,
  media_type          VARCHAR(20),

  -- Filtro de audiência (mesmo formato de getBroadcastAudience):
  -- audience_type: 'all_clients' | 'contacts' | 'custom'
  audience_type       VARCHAR(30) NOT NULL,
  audience_tags       TEXT[],
  audience_atendente_id UUID,
  -- Só usado quando audience_type = 'custom' (lista congelada de
  -- destinatários, já que "personalizada" não tem filtro pra reavaliar)
  custom_recipients   JSONB,

  -- Agendamento
  scheduled_at        TIMESTAMPTZ NOT NULL,       -- 1º (ou único) disparo
  recurrence          VARCHAR(20),                -- NULL | 'daily' | 'weekly' | 'monthly'
  next_run_at         TIMESTAMPTZ NOT NULL,        -- próximo disparo (= scheduled_at até o 1º rodar)
  last_run_at         TIMESTAMPTZ,
  last_broadcast_id   INTEGER REFERENCES broadcasts(id) ON DELETE SET NULL,

  status              VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'cancelled' | 'completed'
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_schedules_next_run
  ON campaign_schedules (next_run_at)
  WHERE status = 'active';
