-- Migration 010: mapa persistente @lid → @s.whatsapp.net
CREATE TABLE IF NOT EXISTS lid_map (
  lid        TEXT PRIMARY KEY,
  jid        TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lid_map_jid ON lid_map(jid);
CREATE INDEX IF NOT EXISTS idx_lid_map_updated ON lid_map(updated_at DESC);
