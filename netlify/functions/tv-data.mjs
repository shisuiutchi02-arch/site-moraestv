import { Buffer } from 'node:buffer';
import { getStore } from '@netlify/blobs';

const BLOB_KEY = 'tv-database-v1';
const MAX_PUT_BYTES = 48 * 1024 * 1024;

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

function jsonHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

/** Expõe GET/PUT no mesmo caminho que o server.js local. */
export const config = {
  path: '/api/data',
};

export default async function handler(request) {
  const headers = jsonHeaders();
  const store = getStore('moraestv-tv-db');

  if (request.method === 'GET') {
    let data = await store.get(BLOB_KEY, { type: 'json' });
    if (data === null || data === undefined) data = defaultDb();
    else data = normalizeDb(data);
    return new Response(JSON.stringify(data), { status: 200, headers });
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
    return new Response(JSON.stringify(normalized), { status: 200, headers });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  return new Response(JSON.stringify({ error: 'Método não suportado' }), { status: 405, headers });
}
