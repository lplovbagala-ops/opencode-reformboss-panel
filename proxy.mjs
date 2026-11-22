// Local OpenAI-compatible proxy that spreads requests across several ReformBoss keys.
// Every key keeps its own concurrency budget (the provider allows 4 streams per key),
// and a 429 on one key moves that request to another key instead of failing.
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const MAX_WAIT_MS = 120000;
const MAX_ATTEMPTS = 6;
const DEFAULT_COOLDOWN_MS = 2500;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

function retryDelay(response) {
  const header = Number(response.headers['retry-after']);
  const ms = Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(ms, 500), 30000);
}

export function createPoolProxy({ keys, upstream, perKey = 4, port = 0, log = () => {} }) {
  const target = new URL(upstream);
  const basePath = target.pathname.replace(/\/+$/, '');
  const targetPath = requestPath => {
    const path = requestPath.startsWith('/') ? requestPath : '/' + requestPath;
    return basePath && !path.startsWith(basePath + '/') && path !== basePath ? basePath + path : path;
  };
  const transport = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const states = new Map();

  const state = key => {
    if (!states.has(key)) states.set(key, { active: 0, cooldownUntil: 0, ok: 0, limited: 0, failed: 0 });
    return states.get(key);
  };
  const available = () => keys().filter(key => typeof key === 'string' && key.length >= 16);

  async function acquire(excluded) {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const list = available();
      if (!list.length) return null;
      let best = null;
      let load = Infinity;
      for (const key of list) {
        if (excluded.has(key)) continue;
        const entry = state(key);
        if (entry.active >= perKey || entry.cooldownUntil > Date.now()) continue;
        if (entry.active < load) { best = key; load = entry.active; }
      }
      if (best) return best;
      if (Date.now() > deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  function forward(req, res, body, key) {
    return new Promise(resolve => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      const headers = { ...req.headers, authorization: 'Bearer ' + key };
      delete headers.host;
      delete headers['content-length'];
      if (body.length) headers['content-length'] = String(body.length);
      const upstreamReq = transport({
        method: req.method,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: targetPath(req.url),
        headers,
        signal: undefined,
      }, response => {
        if (response.statusCode === 429 || response.statusCode === 401 || response.statusCode === 403) {
          const entry = state(key);
          entry.limited++;
          // A rate-limited key rests briefly, a rejected key (disabled, quota, gateway protection) rests longer.
          const delay = response.statusCode === 429 ? retryDelay(response) : 300000;
          entry.cooldownUntil = Date.now() + delay;
          response.resume();
          done('retry');
          return;
        }
        state(key).ok++;
        response.on('end', () => done('done'));
        response.on('error', () => done('done'));
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      });
      upstreamReq.on('error', () => { state(key).failed++; done('retry'); });
      req.on('aborted', () => upstreamReq.destroy());
      upstreamReq.end(body);
    });
  }

  const server = createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/v1/health') {
      const list = available();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        keys: list.length,
        perKey,
        models: list.map((key, index) => ({ key: index + 1, ...state(key) })),
      }));
      return;
    }
    let body;
    try { body = await readBody(req); }
    catch { res.writeHead(400).end(); return; }
    const tried = new Set();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const key = await acquire(tried);
      if (!key) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Все ключи заняты или на паузе. Повторите позже.', type: 'pool_busy' } }));
        return;
      }
      tried.add(key);
      const entry = state(key);
      entry.active++;
      let outcome;
      try { outcome = await forward(req, res, body, key); }
      finally { entry.active--; }
      if (outcome !== 'retry') return;
      if (res.headersSent) return;
    }
    if (!res.headersSent) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '429 на всех ключах. Повторите позже.', type: 'pool_limited' } }));
    }
  });

  return {
    port: 0,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      this.port = server.address().port;
      log('info', 'ReformBoss pool proxy listening', { port: this.port, keys: available().length, perKey });
      return this.port;
    },
    async close() {
      await new Promise(resolve => server.close(() => resolve()));
    },
    stats() { return { keys: available().length, perKey, states: [...states.entries()].map(([key, entry]) => ({ ...entry })) }; },
  };
}