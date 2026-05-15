-- Tabela única para o documento JSON da MoraesTV (planos, clientes, banners).
-- Rode no SQL Editor do Supabase ou via CLI: supabase db push

CREATE TABLE IF NOT EXISTS tv_site_data (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload JSONB NOT NULL DEFAULT '{"version":1,"planos":[],"clientes":[],"banners":[]}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tv_site_data (id, payload)
VALUES (1, '{"version":1,"planos":[],"clientes":[],"banners":[]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE tv_site_data IS 'Estado do site: um único documento JSON consumido por /api/data';
