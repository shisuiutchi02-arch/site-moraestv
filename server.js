/**
 * Dev local: serve HTML e /api/data.
 * Sem DATABASE_URL: persiste em data/tv-database.json (GET/PUT sem auth).
 * Com DATABASE_URL (Supabase Postgres): lê/grava tabela tv_site_data; GET público
 * devolve só planos+banners; GET com Bearer (JWT Supabase) e PUT exigem usuário válido.
 * Produção Netlify: netlify/functions/tv-data.mjs (Postgres ou Blobs se DATABASE_URL vazio).
 */
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 3333);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tv-database.json');
const MAX_PUT_BYTES = Math.min(Number(process.env.MAX_PUT_MB || 48), 96) * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

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

function usePostgres() {
  return Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
}

/** Resposta segura para a landing (sem lista de clientes). */
function publicApiSlice(doc) {
  const n = normalizeDb(doc);
  return { version: n.version, planos: n.planos, banners: n.banners, clientes: [] };
}

async function loadDbRaw() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    return normalizeDb(j);
  } catch (e) {
    if (e && e.code === 'ENOENT') return defaultDb();
    throw e;
  }
}

async function saveDbAtomic(obj) {
  const normalized = normalizeDb(obj);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(normalized);
  const tmp = DATA_FILE + '.tmp.' + process.pid + '.' + Date.now();
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, DATA_FILE);
}

let ioLock = Promise.resolve();

function enqueueWrite(fn) {
  const next = ioLock.then(() => fn());
  ioLock = next.catch(() => {});
  return next;
}

function safeResolveStatic(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  let safe = '/' + decoded.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (safe === '/' || safe === '') safe = '/index.html';

  let filePath = path.resolve(path.normalize(path.join(ROOT, safe.slice(1))));
  const rootResolved = path.resolve(ROOT);
  const rel = path.relative(rootResolved, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const ext = path.extname(filePath).toLowerCase();
  const statTry = [];

  statTry.push(filePath);
  if (ext === '' || decoded.endsWith('/')) statTry.push(path.join(filePath, 'index.html'));

  return statTry;
}

async function tryReadFirst(candidates) {
  for (const p of candidates) {
    try {
      const stat = await fs.stat(p);
      if (stat.isFile()) return p;
    } catch (_) {}
  }
  return null;
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let sum = 0;
    req.on('data', (buf) => {
      sum += buf.length;
      if (sum > maxBytes) {
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);

  const sendJson = (code, obj, extraHeaders = {}) => {
    res.writeHead(code, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(JSON.stringify(obj));
  };

  const fail = (code, msg) => {
    res.writeHead(code, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: msg }));
  };

  const corsSameOriginHack = pathname.startsWith('/api/');

  if (corsSameOriginHack) {
    /* Mesma origem (HTML servido pelo mesmo host); apenas evita caches agressivos. */
    res.setHeader('Cache-Control', 'no-store');
  }

  if (req.method === 'GET' && pathname === '/api/data') {
    Promise.resolve()
      .then(async () => {
        if (usePostgres()) {
          const tvPg = require(path.join(ROOT, 'shared', 'tv-pg.cjs'));
          const { getUserFromBearer } = require(path.join(ROOT, 'shared', 'supabase-verify-user.cjs'));
          let payload = await tvPg.tvLoadPayload();
          if (payload == null) payload = defaultDb();
          const doc = normalizeDb(
            typeof payload === 'object' && payload !== null ? payload : defaultDb()
          );
          const user = await getUserFromBearer(req.headers.authorization);
          return { doc: user ? doc : publicApiSlice(doc), scope: user ? 'full' : 'public' };
        }
        const doc = await enqueueWrite(() => loadDbRaw());
        return { doc, scope: 'full' };
      })
      .then(({ doc, scope }) => {
        sendJson(200, doc, {
          'X-Api-Scope': scope,
          'X-Data-Auth': usePostgres() ? 'required' : 'optional',
        });
      })
      .catch(() => fail(500, 'Erro ao ler banco'));
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/data') {
    readBodyLimited(req, MAX_PUT_BYTES)
      .then(async (buf) => {
        let doc;
        try {
          doc = JSON.parse(buf.toString('utf8'));
        } catch (_) {
          fail(400, 'JSON inválido');
          return;
        }
        const normalized = normalizeDb(doc);
        if (usePostgres()) {
          if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
            fail(500, 'Com DATABASE_URL defina SUPABASE_URL e SUPABASE_ANON_KEY');
            return;
          }
          const { getUserFromBearer } = require(path.join(ROOT, 'shared', 'supabase-verify-user.cjs'));
          const user = await getUserFromBearer(req.headers.authorization);
          if (!user) {
            fail(401, 'Não autorizado: faça login no dashboard (Supabase).');
            return;
          }
          const tvPg = require(path.join(ROOT, 'shared', 'tv-pg.cjs'));
          await enqueueWrite(() => tvPg.tvSavePayload(normalized));
          sendJson(200, normalized, { 'X-Api-Scope': 'full' });
          return;
        }
        await enqueueWrite(() => saveDbAtomic(normalized));
        sendJson(200, normalized, { 'X-Api-Scope': 'full' });
      })
      .catch((err) => {
        if (err && err.message === 'BODY_TOO_LARGE') fail(413, 'Corpo grande demais (banners?)');
        else if (String(err || '').trim()) fail(500, err.message || 'Erro ao gravar');
        else fail(400, 'Erro ao processar PUT');
      });
    return;
  }

  if (pathname.startsWith('/api/')) {
    fail(404, 'Sem rota');
    return;
  }

  Promise.resolve()
    .then(() => safeResolveStatic(pathname))
    .then((candidates) =>
      candidates
        ? tryReadFirst(candidates)
        : Promise.resolve(null)
    )
    .then((fileOrNull) => {
      if (!fileOrNull) {
        res.writeHead(404, { 'Content-Type': MIME['.html'] });
        res.end('<!DOCTYPE html><meta charset=utf-8><title>404</title><pre>404</pre>');
        return;
      }
      return fs.readFile(fileOrNull).then((buf) => {
        const ext = path.extname(fileOrNull).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60' });
        res.end(buf);
      });
    })
    .catch(() => {
      res.writeHead(500);
      res.end('Erro servidor');
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error('TV Moraes: http://127.0.0.1:%s/', PORT);
  console.error('Dados: %s', DATA_FILE);
});
