/**
 * Dev local: serve HTML e persiste planos/clientes/banners em data/tv-database.json (GET|PUT /api/data).
 * Produção Netlify: use netlify/functions/tv-data.mjs + Blobs na mesma rota /api/data.
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

  const sendJson = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-store',
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
    enqueueWrite(() => loadDbRaw())
      .then((doc) => {
        sendJson(200, doc);
      })
      .catch(() => fail(500, 'Erro ao ler banco'));
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/data') {
    readBodyLimited(req, MAX_PUT_BYTES)
      .then((buf) => {
        let doc;
        try {
          doc = JSON.parse(buf.toString('utf8'));
        } catch (_) {
          fail(400, 'JSON inválido');
          return;
        }
        return enqueueWrite(() => saveDbAtomic(doc)).then(() => {
          sendJson(200, normalizeDb(doc));
        });
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
