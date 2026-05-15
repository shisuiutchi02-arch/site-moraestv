/**
 * Migra data/tv-database.json para a tabela tv_site_data no Supabase.
 * Uso (PowerShell):
 *   $env:DATABASE_URL="postgresql://postgres:...@db....supabase.co:5432/postgres"
 *   node scripts/migrate-json-to-supabase.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const JSON_FILE = join(ROOT, 'data', 'tv-database.json');

function normalizeDb(j) {
  const d = typeof j === 'object' && j !== null ? j : {};
  return {
    version: typeof d.version === 'number' ? d.version : 1,
    planos: Array.isArray(d.planos) ? d.planos : [],
    clientes: Array.isArray(d.clientes) ? d.clientes : [],
    banners: Array.isArray(d.banners) ? d.banners : [],
  };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Defina DATABASE_URL (connection string do Supabase).');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
});

let raw = '{"version":1,"planos":[],"clientes":[],"banners":[]}';
try {
  raw = await readFile(JSON_FILE, 'utf8');
} catch (e) {
  if (e && e.code === 'ENOENT') {
    console.warn('Arquivo', JSON_FILE, 'não encontrado; gravando documento vazio.');
  } else throw e;
}

const doc = normalizeDb(JSON.parse(raw));

await pool.query(
  `INSERT INTO tv_site_data (id, payload, updated_at)
   VALUES (1, $1::jsonb, now())
   ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
  [JSON.stringify(doc)]
);

console.log('Migrado com sucesso:', JSON_FILE, '→ tv_site_data (id=1)');
console.log('Resumo:', {
  planos: doc.planos.length,
  clientes: doc.clientes.length,
  banners: doc.banners.length,
});

await pool.end();
