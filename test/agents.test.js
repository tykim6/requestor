import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { LinearClient } from '../src/linear.js';
import { createCopilotBackend } from '../src/agents/copilot.js';
import { createClaudeRoutineBackend } from '../src/agents/claude-routine.js';
import { createLinearDelegateBackend } from '../src/agents/linear-delegate.js';
import { buildAgentPrompt } from '../src/format.js';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://localhost:${server.address().port}`)));
const json = (res) => res.json();
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const sample = { title: 'Checkout button does nothing', description: 'Clicked pay, nothing happened', severity: 'high', telemetry: { url: 'https://shop.example.com/checkout' } };

// Generic fake JSON endpoint that records requests.
function fakeServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      calls.push(call);
      const [status, payload] = handler(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return { server, calls };
}

test('copilot backend creates an agent task and records it on manual dispatch', async () => {
  const gh = fakeServer(() => [201, { id: 'task_123', html_url: 'https://github.com/acme/shop/agents/task_123', state: 'queued' }]);
  const ghUrl = await listen(gh.server);
  const agent = createCopilotBackend({ token: 'ghp_test', repo: 'acme/shop', baseRef: 'main', apiUrl: ghUrl });
  const app = createApp({ db: openDb(':memory:'), linear: null, agent, autoDispatch: false });
  const base = await listen(app.server);

  const created = await json(await post(`${base}/api/bugs`, sample));
  let full = await json(await fetch(`${base}/api/bugs/${created.id}`));
  assert.equal(full.agent_status, null, 'no dispatch until asked');

  const out = await json(await post(`${base}/api/bugs/${created.id}/dispatch`));
  assert.equal(out.agent.backend, 'copilot');
  assert.equal(out.agent.status, 'dispatched');
  assert.equal(out.agent.url, 'https://github.com/acme/shop/agents/task_123');

  const call = gh.calls[0];
  assert.equal(call.url, '/agents/repos/acme/shop/tasks');
  assert.equal(call.headers.authorization, 'Bearer ghp_test');
  assert.equal(call.body.base_ref, 'main');
  assert.equal(call.body.create_pull_request, true);
  assert.match(call.body.prompt, /Checkout button does nothing/);
  assert.match(call.body.prompt, /open a pull request/);

  full = await json(await fetch(`${base}/api/bugs/${created.id}`));
  assert.deepEqual(full.events.map((e) => e.type), ['received', 'linear.skipped', 'agent.dispatched']);
  await app.close(); gh.server.close();
});

test('auto-dispatch runs after Linear sync on submit', async () => {
  const gh = fakeServer(() => [201, { id: 't1', html_url: 'https://github.com/x/y/agents/t1' }]);
  const agent = createCopilotBackend({ token: 't', repo: 'x/y', apiUrl: await listen(gh.server) });
  const app = createApp({ db: openDb(':memory:'), linear: null, agent, autoDispatch: true });
  const base = await listen(app.server);
  const created = await json(await post(`${base}/api/bugs`, sample));
  const full = await json(await fetch(`${base}/api/bugs/${created.id}`));
  assert.equal(full.agent_status, 'dispatched');
  assert.deepEqual(full.events.map((e) => e.type), ['received', 'linear.skipped', 'agent.dispatched']);
  await app.close(); gh.server.close();
});

test('agent failure is recorded, not thrown', async () => {
  const gh = fakeServer(() => [403, { message: 'Resource not accessible by personal access token' }]);
  const agent = createCopilotBackend({ token: 't', repo: 'x/y', apiUrl: await listen(gh.server) });
  const app = createApp({ db: openDb(':memory:'), linear: null, agent });
  const base = await listen(app.server);
  const created = await json(await post(`${base}/api/bugs`, sample));
  const out = await json(await post(`${base}/api/bugs/${created.id}/dispatch`));
  assert.equal(out.agent.status, 'failed');
  assert.match(out.agent.error, /403.*not accessible/);
  await app.close(); gh.server.close();
});

test('claude-routine backend fires the routine with the report as text', async () => {
  const cc = fakeServer(() => [200, { type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' }]);
  const fireUrl = `${await listen(cc.server)}/v1/claude_code/routines/trig_1/fire`;
  const agent = createClaudeRoutineBackend({ fireUrl, token: 'sk-ant-oat01-test' });
  const app = createApp({ db: openDb(':memory:'), linear: null, agent });
  const base = await listen(app.server);
  const created = await json(await post(`${base}/api/bugs`, sample));
  const out = await json(await post(`${base}/api/bugs/${created.id}/dispatch`));
  assert.equal(out.agent.status, 'dispatched');
  assert.equal(out.agent.url, 'https://claude.ai/code/session_1');
  const call = cc.calls[0];
  assert.equal(call.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(call.headers.authorization, 'Bearer sk-ant-oat01-test');
  assert.match(call.body.text, /Checkout button does nothing/);
  await app.close(); cc.server.close();
});

test('linear-delegate backend sets delegateId on the created issue', async () => {
  const lin = fakeServer(({ body }) => {
    if (body.query.includes('teams')) return [200, { data: { teams: { nodes: [{ id: 'team_1', key: 'ENG', name: 'Eng' }] } } }];
    if (body.query.includes('issueCreate')) return [200, { data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'ENG-9', url: 'https://linear.app/x/issue/ENG-9' } } } }];
    if (body.query.includes('issueUpdate')) return [200, { data: { issueUpdate: { success: true, issue: { id: 'iss_1', identifier: 'ENG-9', url: 'https://linear.app/x/issue/ENG-9' } } } }];
    return [200, { errors: [{ message: 'unknown' }] }];
  });
  const linear = new LinearClient({ apiKey: 'lin_api_x', apiUrl: await listen(lin.server), teamKey: 'ENG' });
  const agent = createLinearDelegateBackend({ linear, delegateId: 'app_user_copilot' });
  const app = createApp({ db: openDb(':memory:'), linear, agent, autoDispatch: true });
  const base = await listen(app.server);
  const created = await json(await post(`${base}/api/bugs`, sample));
  assert.deepEqual(created.linear, { identifier: 'ENG-9', url: 'https://linear.app/x/issue/ENG-9' });
  const update = lin.calls.find((c) => c.body.query.includes('issueUpdate'));
  assert.equal(update.body.variables.id, 'iss_1');
  assert.deepEqual(update.body.variables.input, { delegateId: 'app_user_copilot' });
  const full = await json(await fetch(`${base}/api/bugs/${created.id}`));
  assert.equal(full.agent_status, 'dispatched');
  assert.equal(full.agent_ref, 'ENG-9');
  await app.close(); lin.server.close();
});

test('dispatch without a backend records agent.skipped', async () => {
  const app = createApp({ db: openDb(':memory:'), linear: null, agent: null });
  const base = await listen(app.server);
  const created = await json(await post(`${base}/api/bugs`, sample));
  const out = await json(await post(`${base}/api/bugs/${created.id}/dispatch`));
  assert.equal(out.agent, null);
  const full = await json(await fetch(`${base}/api/bugs/${created.id}`));
  assert.deepEqual(full.events.map((e) => e.type), ['received', 'linear.skipped', 'agent.skipped']);
  await app.close();
});

test('existing databases gain the agent columns', () => {
  const path = join(tmpdir(), `requestor-migrate-${process.pid}-${Date.now()}.sqlite`);
  const old = new DatabaseSync(path);
  // The v0.1 schema, before the agent_* columns existed.
  old.exec(`CREATE TABLE reports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, severity TEXT, page_url TEXT, reporter TEXT, context TEXT, telemetry TEXT, status TEXT NOT NULL,
    linear_issue_id TEXT, linear_identifier TEXT, linear_url TEXT, sync_error TEXT)`);
  old.exec("INSERT INTO reports (id, created_at, updated_at, title, status) VALUES ('r1', '2026-01-01', '2026-01-01', 'old row', 'received')");
  old.close();
  const db = openDb(path);
  const cols = db.raw.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
  assert.ok(cols.includes('agent_status') && cols.includes('agent_url'));
  assert.equal(db.getReport('r1').agent_status, null);
  db.close();
  rmSync(path, { force: true });
});

test('agent prompt includes the Linear reference when present', () => {
  const p = buildAgentPrompt({ id: 'r1', title: 'Broken', created_at: '2026-01-01T00:00:00Z', linear_identifier: 'ENG-1', linear_url: 'https://linear.app/x/issue/ENG-1' });
  assert.match(p, /Linear issue: ENG-1/);
  assert.match(p, /Title: Broken/);
});
