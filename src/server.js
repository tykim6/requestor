#!/usr/bin/env node
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { LinearClient } from './linear.js';
import { createGitHubClient } from './github.js';
import { createPipeline, validateSubmission } from './pipeline.js';
import { createAgentBackend } from './agents/index.js';
import { createReviewLoop } from './review.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const MAX_BODY = 2 * 1024 * 1024;

export function createApp(opts = {}) {
  // Instances can be injected (tests); everything else comes from config with shallow overrides.
  const { db: dbOpt, linear: linearOpt, github: githubOpt, agent: agentOpt, autoDispatch: autoOpt, review: reviewOpts = {}, ...overrides } = opts;
  const cfg = { ...config, ...overrides };
  const db = dbOpt ?? openDb(cfg.dbPath);
  const linear = linearOpt !== undefined ? linearOpt : (cfg.linear.apiKey ? new LinearClient(cfg.linear) : null);
  const github = githubOpt !== undefined ? githubOpt : (cfg.github.token && cfg.github.repo ? createGitHubClient(cfg.github) : null);
  const agent = agentOpt !== undefined ? agentOpt : createAgentBackend(cfg.agent, { linear, github });
  const autoDispatch = autoOpt ?? cfg.agent.autoDispatch;
  const pipeline = createPipeline({ db, linear, agent, autoDispatch, publicBaseUrl: cfg.publicBaseUrl });
  const review = createReviewLoop({
    db, pipeline, github,
    maxRounds: reviewOpts.maxRounds ?? cfg.agent.maxRounds,
    autoCiFeedback: reviewOpts.autoCiFeedback ?? cfg.agent.autoCiFeedback,
    autoApproveCi: reviewOpts.autoApproveCi ?? cfg.github.autoApproveCi,
  });
  const webhookSecret = reviewOpts.webhookSecret ?? cfg.github.webhookSecret;

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

  const readRaw = (req) => new Promise((resolvePromise, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req) => {
    const raw = await readRaw(req);
    try { return raw.length ? JSON.parse(raw) : {}; } catch { throw new Error('invalid JSON'); }
  };

  const authorized = (req) => !cfg.adminToken || req.headers.authorization === `Bearer ${cfg.adminToken}`;

  const validSignature = (raw, header) => {
    if (!header || !header.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', webhookSecret).update(raw).digest('hex'));
    const given = Buffer.from(header.slice('sha256='.length));
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

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
        github: github ? github.repo : 'disabled',
        webhooks: webhookSecret ? 'configured' : 'disabled',
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

    // GitHub webhooks: signature-checked, deduplicated by delivery id, then handed to the review loop.
    if (path === '/api/webhooks/github' && req.method === 'POST') {
      if (!webhookSecret) return send(res, 503, { error: 'GITHUB_WEBHOOK_SECRET not configured' });
      const raw = await readRaw(req);
      if (!validSignature(raw, req.headers['x-hub-signature-256'])) return send(res, 401, { error: 'bad signature' });
      const delivery = req.headers['x-github-delivery'];
      if (delivery && !db.claimDelivery(String(delivery))) return send(res, 200, { ok: true, duplicate: true });
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      try {
        const result = await review.handle(String(req.headers['x-github-event'] || ''), payload);
        return send(res, 200, { ok: true, ...result });
      } catch (err) {
        console.error('[requestor] webhook handling failed', err);
        return send(res, 200, { ok: false, error: err.message }); // 200 so GitHub does not retry a poison payload
      }
    }

    const m = path.match(/^\/api\/bugs(?:\/([\w-]+))?(\/sync|\/dispatch|\/feedback)?$/);
    if (m) {
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' }, cors);
      const [, id, action] = m;
      if (!id && req.method === 'GET') return send(res, 200, { reports: db.listReports(Number(url.searchParams.get('limit')) || 50) }, cors);
      if (id && action && req.method === 'POST') {
        if (!db.getReport(id)) return send(res, 404, { error: 'not found' }, cors);
        if (action === '/sync') return send(res, 200, adminView(await pipeline.retrySync(id)), cors);
        if (action === '/dispatch') return send(res, 200, adminView(await pipeline.dispatchAgent(id)), cors);
        let body;
        try { body = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }, cors); }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return send(res, 400, { error: 'text is required' }, cors);
        try {
          return send(res, 200, adminView(await pipeline.sendFeedback(id, text, { source: 'manual' })), cors);
        } catch (err) {
          return send(res, 502, { error: err.message, ...adminView(db.getReport(id)) }, cors);
        }
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

  return { server, db, pipeline, review, linear, github, agent, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

// What the widget gets back: enough to show the user a confirmation, nothing more.
function publicView(report) {
  return {
    id: report.id,
    status: report.status,
    linear: report.linear_identifier ? { identifier: report.linear_identifier, url: report.linear_url } : null,
  };
}

// Admin actions (sync, dispatch, feedback) also report the agent and review state.
function adminView(report) {
  return {
    ...publicView(report),
    agent: report.agent_backend
      ? { backend: report.agent_backend, status: report.agent_status, ref: report.agent_ref, url: report.agent_url, branch: report.agent_branch, error: report.agent_error }
      : null,
    review: { status: report.review_status, pr: report.pr_number ? { number: report.pr_number, url: report.pr_url } : null, rounds: report.feedback_rounds },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(config.port, () => {
    console.log(`[requestor] listening on http://localhost:${config.port}`);
    console.log(`[requestor] db: ${config.dbPath}`);
    console.log(`[requestor] linear: ${app.linear ? `enabled (team ${config.linear.teamKey || config.linear.teamId || 'auto'})` : 'disabled, log-only mode'}`);
    console.log(`[requestor] agent: ${app.agent ? `${app.agent.name} (${config.agent.autoDispatch ? 'auto-dispatch' : 'manual dispatch via POST /api/bugs/:id/dispatch'})` : 'disabled'}`);
    console.log(`[requestor] github: ${app.github ? `${app.github.repo}, webhooks ${config.github.webhookSecret ? 'on' : 'off'}, auto CI feedback ${config.agent.autoCiFeedback ? `on (max ${config.agent.maxRounds} rounds)` : 'off'}` : 'disabled'}`);
    console.log(`[requestor] demo: http://localhost:${config.port}/demo/`);
  });
}
