import { Buffer } from 'node:buffer';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getStore } from '@netlify/blobs';

const BLOB_KEY = 'tv-database-v1';
const MAX_PUT_BYTES = 48 * 1024 * 1024;

let pgPool;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 2),
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 12000,
      ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
    });
  }
  return pgPool;
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

async function getUserFromBearer(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const jwt = m[1].trim();
  if (!jwt) return null;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const supabase = createClient(url, anonKey);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data || !data.user) return null;
  return data.user;
}

function defaultDb() {
  return { version: 1, planos: [], clientes: [], banners: [] };
}

function normalizeDb(j) {
  const d = typeof j === 'object' && j !== null ? j : {};
  return {
    version: typeof d.version === 'number' ? d.version : 1,
    planos: Array.isArray(d.planos) ? d.planos : [],
    clientes: Array.isArray(d.clientes) ? d.clientes : [],
    banners: Array.isArray(d.banners) ? d.banners : [],
  };
}

function publicApiSlice(doc) {
  const n = normalizeDb(doc);
  return { version: n.version, planos: n.planos, banners: n.banners, clientes: [] };
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

function usePostgres() {
  return Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
}

/** Expõe GET/PUT no mesmo caminho que o server.js local. */
export const config = {
  path: '/api/data',
};

export default async function handler(request) {
  const headers = jsonHeaders();

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (usePostgres()) {
    if (request.method === 'GET') {
      try {
        let payload = await tvLoadPayload();
        if (payload == null) payload = defaultDb();
        const doc = normalizeDb(
          typeof payload === 'object' && payload !== null ? payload : defaultDb()
        );
        const user = await getUserFromBearer(request.headers.get('authorization'));
        const out = user ? doc : publicApiSlice(doc);
        return new Response(JSON.stringify(out), {
          status: 200,
          headers: {
            ...headers,
            'X-Api-Scope': user ? 'full' : 'public',
            'X-Data-Auth': 'required',
          },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Erro ao ler banco' }), {
          status: 500,
          headers,
        });
      }
    }

    if (request.method === 'PUT') {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
        return new Response(
          JSON.stringify({ error: 'Defina SUPABASE_URL e SUPABASE_ANON_KEY na Netlify' }),
          { status: 500, headers }
        );
      }
      const user = await getUserFromBearer(request.headers.get('authorization'));
      if (!user) {
        return new Response(JSON.stringify({ error: 'Não autorizado: faça login no dashboard.' }), {
          status: 401,
          headers,
        });
      }
      const buf = Buffer.from(await request.arrayBuffer());
      if (buf.length > MAX_PUT_BYTES) {
        return new Response(JSON.stringify({ error: 'Corpo grande demais (limite ~48 MB)' }), {
          status: 413,
          headers,
        });
      }
      let doc;
      try {
        doc = JSON.parse(buf.toString('utf8'));
      } catch {
        return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers });
      }
      const normalized = normalizeDb(doc);
      try {
        await tvSavePayload(normalized);
        return new Response(JSON.stringify(normalized), {
          status: 200,
          headers: { ...headers, 'X-Api-Scope': 'full' },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Erro ao gravar no Postgres' }), {
          status: 500,
          headers,
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Método não suportado' }), { status: 405, headers });
  }

  const store = getStore('moraestv-tv-db');

  if (request.method === 'GET') {
    let data = await store.get(BLOB_KEY, { type: 'json' });
    if (data === null || data === undefined) data = defaultDb();
    else data = normalizeDb(data);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...headers, 'X-Api-Scope': 'full', 'X-Data-Auth': 'optional' },
    });
  }

  if (request.method === 'PUT') {
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.length > MAX_PUT_BYTES) {
      return new Response(JSON.stringify({ error: 'Corpo grande demais (limite ~48 MB)' }), {
        status: 413,
        headers,
      });
    }
    let doc;
    try {
      doc = JSON.parse(buf.toString('utf8'));
    } catch {
      return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers });
    }
    const normalized = normalizeDb(doc);
    await store.setJSON(BLOB_KEY, normalized);
    return new Response(JSON.stringify(normalized), {
      status: 200,
      headers: { ...headers, 'X-Api-Scope': 'full' },
    });
  }

  return new Response(JSON.stringify({ error: 'Método não suportado' }), { status: 405, headers });
}
