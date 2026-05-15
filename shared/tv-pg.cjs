'use strict';

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 2),
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 12000,
      ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function tvLoadPayload() {
  const p = getPool();
  if (!p) return null;
  const r = await p.query('SELECT payload FROM tv_site_data WHERE id = 1');
  if (!r.rows.length) return null;
  return r.rows[0].payload;
}

async function tvSavePayload(payloadJson) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL ausente');
  await p.query(
    `INSERT INTO tv_site_data (id, payload, updated_at)
     VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [JSON.stringify(payloadJson)]
  );
}

module.exports = { getPool, tvLoadPayload, tvSavePayload };
