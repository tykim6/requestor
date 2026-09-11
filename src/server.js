#!/usr/bin/env node
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { LinearClient } from './linear.js';
import { createPipeline, validateSubmission } from './pipeline.js';
import { createAgentBackend } from './agents/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const MAX_BODY = 2 * 1024 * 1024;

export function createApp(opts = {}) {
  const { db: dbOpt, linear: linearOpt, agent: agentOpt, autoDispatch: autoOpt, ...overrides } = opts;
  const cfg = { ...config, ...overrides };
  const db = dbOpt ?? openDb(cfg.dbPath);
  const linear = linearOpt !== undefined ? linearOpt : (cfg.linear.apiKey ? new LinearClient(cfg.linear) : null);
  const agent = agentOpt !== undefined ? agentOpt : createAgentBackend(cfg.agent, { linear });
  const autoDispatch = autoOpt ?? cfg.agent.autoDispatch;
  const pipeline = createPipeline({ db, linear, agent, autoDispatch, publicBaseUrl: cfg.publicBaseUrl });

  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    const allowAll = cfg.allowedOrigins.includes('*');
    const allowed = allowAll ? '*' : (origin && cfg.allowedOrigins.includes(origin) ? origin : null);
    const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
    if (allowed) h['Access-Control-Allow-Origin'] = allowed;
    if (!allowAll) h.Vary = 'Origin';
    return h;
  };

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : headers['Content-Type'] || 'text/plain', ...headers });
    res.end(payload);
  };

  const readJson = (req) => new Promise((resolvePromise, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });

  const authorized = (req) => !cfg.adminToken || req.headers.authorization === `Bearer ${cfg.adminToken}`;

  async function serveStatic(res, baseDir, relPath, extraHeaders = {}) {
    const safe = normalize('/' + relPath).replace(/^\/+/, '');
    let file = join(baseDir, safe);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const data = await readFile(file);
      send(res, 200, data, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', ...extraHeaders });
    } catch {
      send(res, 404, 'not found');
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // Widget script, embeddable from any origin.
    if (path === '/requestor.js') return serveStatic(res, join(ROOT, 'widget'), 'requestor.js', { ...cors, 'Cache-Control': 'no-cache' });

    if (path === '/api/health') {
      return send(res, 200, {
        ok: true,
        linear: linear ? 'configured' : 'disabled',
        teamKey: cfg.linear.teamKey || null,
        agent: agent ? agent.name : 'disabled',
        autoDispatch: Boolean(agent && autoDispatch),
      }, cors);
    }

    if (path === '/api/bugs' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }, cors); }
      const { error, value } = validateSubmission(body);
      if (error) return send(res, 400, { error }, cors);
      const report = await pipeline.submit(value, {
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        origin: req.headers.origin,
        userAgent: req.headers['user-agent'],
      });
      return send(res, 201, publicView(report), cors);
    }

    const m = path.match(/^\/api\/bugs(?:\/([\w-]+))?(\/sync|\/dispatch)?$/);
    if (m) {
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' }, cors);
      const [, id, action] = m;
      if (!id && req.method === 'GET') return send(res, 200, { reports: db.listReports(Number(url.searchParams.get('limit')) || 50) }, cors);
      if (id && action && req.method === 'POST') {
        if (!db.getReport(id)) return send(res, 404, { error: 'not found' }, cors);
        const report = action === '/sync' ? await pipeline.retrySync(id) : await pipeline.dispatchAgent(id);
        return send(res, 200, adminView(report), cors);
      }
      if (id && req.method === 'GET') {
        const report = db.getReport(id);
        if (!report) return send(res, 404, { error: 'not found' }, cors);
        return send(res, 200, { ...report, events: db.getEvents(id) }, cors);
      }
    }

    // Demo site.
    if (path === '/') { res.writeHead(302, { Location: '/demo/' }); return res.end(); }
    if (path.startsWith('/demo/')) return serveStatic(res, join(ROOT, 'demo'), path.slice('/demo/'.length));

    send(res, 404, { error: 'not found' }, cors);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[requestor] unhandled error', err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  return { server, db, pipeline, linear, agent, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

// What the widget gets back: enough to show the user a confirmation, nothing more.
function publicView(report) {
  return {
    id: report.id,
    status: report.status,
    linear: report.linear_identifier ? { identifier: report.linear_identifier, url: report.linear_url } : null,
  };
}

// Admin actions (sync, dispatch) also report the agent outcome.
function adminView(report) {
  return {
    ...publicView(report),
    agent: report.agent_backend
      ? { backend: report.agent_backend, status: report.agent_status, ref: report.agent_ref, url: report.agent_url, error: report.agent_error }
      : null,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(config.port, () => {
    console.log(`[requestor] listening on http://localhost:${config.port}`);
    console.log(`[requestor] db: ${config.dbPath}`);
    console.log(`[requestor] linear: ${app.linear ? `enabled (team ${config.linear.teamKey || config.linear.teamId || 'auto'})` : 'disabled, log-only mode'}`);
    console.log(`[requestor] agent: ${app.agent ? `${app.agent.name} (${config.agent.autoDispatch ? 'auto-dispatch' : 'manual dispatch via POST /api/bugs/:id/dispatch'})` : 'disabled'}`);
    console.log(`[requestor] demo: http://localhost:${config.port}/demo/`);
  });
}
