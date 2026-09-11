import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { LinearClient } from '../src/linear.js';
import { buildIssueDescription } from '../src/format.js';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://localhost:${server.address().port}`)));

const sample = {
  title: 'Checkout button does nothing',
  description: 'Clicked pay, nothing happened',
  severity: 'high',
  reporter: { email: 'jane@example.com', id: 'u1' },
  context: { plan: 'pro' },
  telemetry: {
    url: 'https://shop.example.com/checkout',
    userAgent: 'TestBrowser/1.0',
    viewport: { width: 1280, height: 720 },
    errors: [{ ts: Date.now(), type: 'error', message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n  at pay (checkout.js:10)' }],
    console: [{ ts: Date.now(), level: 'warn', message: 'slow request' }],
    breadcrumbs: [{ ts: Date.now(), type: 'click', detail: 'button#pay "Pay now"' }],
    network: [{ ts: Date.now(), method: 'POST', url: '/api/pay', status: 500, durationMs: 120 }],
  },
};

// Fake Linear GraphQL endpoint.
function fakeLinear({ fail = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      calls.push({ query, variables, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (fail) return res.end(JSON.stringify({ errors: [{ message: 'boom' }] }));
      if (query.includes('teams')) return res.end(JSON.stringify({ data: { teams: { nodes: [{ id: 'team_1', key: 'ENG', name: 'Engineering' }] } } }));
      if (query.includes('issueLabels')) return res.end(JSON.stringify({ data: { issueLabels: { nodes: [{ id: 'lbl_1', name: 'Bug' }] } } }));
      if (query.includes('issueCreate')) return res.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'ENG-42', url: 'https://linear.app/x/issue/ENG-42' } } } }));
      res.end(JSON.stringify({ errors: [{ message: 'unknown query' }] }));
    });
  });
  return { server, calls };
}

test('stores a report in log-only mode when Linear is not configured', async () => {
  const app = createApp({ db: openDb(':memory:'), linear: null });
  const base = await listen(app.server);
  const res = await fetch(`${base}/api/bugs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sample) });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, 'received');
  assert.equal(body.linear, null);

  const full = await (await fetch(`${base}/api/bugs/${body.id}`)).json();
  assert.equal(full.title, sample.title);
  assert.equal(full.page_url, sample.telemetry.url);
  assert.deepEqual(full.context, { plan: 'pro' });
  assert.deepEqual(full.events.map((e) => e.type), ['received', 'linear.skipped']);

  const list = await (await fetch(`${base}/api/bugs`)).json();
  assert.equal(list.reports.length, 1);
  await app.close();
});

test('rejects a report without a title', async () => {
  const app = createApp({ db: openDb(':memory:'), linear: null });
  const base = await listen(app.server);
  const res = await fetch(`${base}/api/bugs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 400);
  await app.close();
});

test('creates a Linear issue and records identifier', async () => {
  const fake = fakeLinear();
  const linearUrl = await listen(fake.server);
  const linear = new LinearClient({ apiKey: 'lin_api_test', apiUrl: linearUrl, teamKey: 'eng', labels: ['Bug', 'Missing'] });
  const app = createApp({ db: openDb(':memory:'), linear, publicBaseUrl: 'http://rq.local' });
  const base = await listen(app.server);

  const res = await fetch(`${base}/api/bugs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sample) });
  const body = await res.json();
  assert.equal(body.status, 'synced');
  assert.deepEqual(body.linear, { identifier: 'ENG-42', url: 'https://linear.app/x/issue/ENG-42' });

  const create = fake.calls.find((c) => c.query.includes('issueCreate'));
  assert.equal(create.auth, 'lin_api_test');
  assert.equal(create.variables.input.teamId, 'team_1');
  assert.equal(create.variables.input.priority, 2);
  assert.deepEqual(create.variables.input.labelIds, ['lbl_1']);
  assert.equal(create.variables.input.title, '[high] Checkout button does nothing');
  assert.match(create.variables.input.description, /TypeError: x is undefined/);
  assert.match(create.variables.input.description, /http:\/\/rq\.local\/api\/bugs\//);

  const full = await (await fetch(`${base}/api/bugs/${body.id}`)).json();
  assert.equal(full.linear_identifier, 'ENG-42');
  assert.deepEqual(full.events.map((e) => e.type), ['received', 'linear.created']);
  await app.close();
  fake.server.close();
});

test('marks sync_failed on Linear error and can retry', async () => {
  const fake = fakeLinear({ fail: true });
  const linearUrl = await listen(fake.server);
  const linear = new LinearClient({ apiKey: 'lin_api_test', apiUrl: linearUrl, teamKey: 'ENG' });
  const app = createApp({ db: openDb(':memory:'), linear });
  const base = await listen(app.server);

  const body = await (await fetch(`${base}/api/bugs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sample) })).json();
  assert.equal(body.status, 'sync_failed');
  const full = await (await fetch(`${base}/api/bugs/${body.id}`)).json();
  assert.match(full.sync_error, /boom/);

  const retry = await (await fetch(`${base}/api/bugs/${body.id}/sync`, { method: 'POST' })).json();
  assert.equal(retry.status, 'sync_failed');
  const events = (await (await fetch(`${base}/api/bugs/${body.id}`)).json()).events.map((e) => e.type);
  assert.deepEqual(events, ['received', 'linear.failed', 'linear.failed']);
  await app.close();
  fake.server.close();
});

test('read endpoints require admin token when configured', async () => {
  const app = createApp({ db: openDb(':memory:'), linear: null, adminToken: 'secret' });
  const base = await listen(app.server);
  assert.equal((await fetch(`${base}/api/bugs`)).status, 401);
  assert.equal((await fetch(`${base}/api/bugs`, { headers: { Authorization: 'Bearer secret' } })).status, 200);
  await app.close();
});

test('description formatter handles empty telemetry', () => {
  const out = buildIssueDescription({ id: 'r1', title: 't', created_at: '2026-01-01T00:00:00Z' });
  assert.match(out, /No description provided/);
  assert.match(out, /Errors \(0\)/);
});
