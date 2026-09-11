import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createGitHubClient } from '../src/github.js';
import { createCopilotBackend } from '../src/agents/copilot.js';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://localhost:${server.address().port}`)));
const json = (res) => res.json();
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const SECRET = 'whsec_test';
const sample = { title: 'Checkout button does nothing', severity: 'high', telemetry: { url: 'https://shop.example.com/checkout' } };

// Fake GitHub: agent tasks, PR lookup, comments, jobs, logs, approvals.
function fakeGitHub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const call = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      calls.push(call);
      const reply = (status, payload, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
      if (req.url.startsWith('/agents/repos/') && req.method === 'POST') return reply(201, { id: 'task_1', html_url: 'https://github.com/x/y/tasks/task_1', artifacts: [{ type: 'branch', data: { head_ref: 'copilot/fix-checkout' } }] });
      if (req.url.startsWith('/repos/x/y/pulls?head=')) return reply(200, [{ number: 7, html_url: 'https://github.com/x/y/pull/7' }]);
      if (/\/issues\/\d+\/comments$/.test(req.url)) return reply(201, { id: 9001, html_url: 'https://github.com/x/y/pull/7#issuecomment-9001' });
      if (/\/actions\/runs\/\d+\/jobs/.test(req.url)) return reply(200, { jobs: [{ id: 501, name: 'test (22)', conclusion: 'failure', html_url: 'https://github.com/x/y/actions/runs/77/job/501', steps: [{ name: 'Run npm test', conclusion: 'failure' }] }, { id: 502, name: 'test (24)', conclusion: 'success', steps: [] }] });
      if (/\/actions\/jobs\/501\/logs/.test(req.url)) return reply(200, '2026-09-11T01:00:00.000Z line one\n2026-09-11T01:00:01.000Z ✖ demo add-to-cart increments once per click\n2026-09-11T01:00:02.000Z Error: ENOENT: no such file\n', 'text/plain');
      if (/\/actions\/runs\/\d+\/approve/.test(req.url)) return reply(201, {});
      reply(404, { message: `unhandled ${req.method} ${req.url}` });
    });
  });
  return { server, calls };
}

function sign(body) { return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'); }
async function deliver(base, event, payload, { delivery = `d-${Math.random()}`, secret = true } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`${base}/api/webhooks/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': secret ? sign(body) : 'sha256=deadbeef' },
    body,
  });
}

async function setup(reviewOpts = {}) {
  const gh = fakeGitHub();
  const ghUrl = await listen(gh.server);
  const github = createGitHubClient({ token: 't', repo: 'x/y', apiUrl: ghUrl });
  const agent = createCopilotBackend({ github });
  const app = createApp({ db: openDb(':memory:'), linear: null, github, agent, review: { webhookSecret: SECRET, maxRounds: 2, autoCiFeedback: true, ...reviewOpts } });
  const base = await listen(app.server);
  const created = await json(await post(`${base}/api/bugs`, sample));
  await post(`${base}/api/bugs/${created.id}/dispatch`);
  const get = async () => json(await fetch(`${base}/api/bugs/${created.id}`));
  return { gh, app, base, id: created.id, get, close: async () => { await app.close(); gh.server.close(); } };
}

const prPayload = (id, action = 'opened', extra = {}) => ({
  action,
  pull_request: { number: 7, html_url: 'https://github.com/x/y/pull/7', title: 'Fix checkout', body: `Fixes it.\n\nRequestor-Report: ${id}`, draft: true, user: { login: 'Copilot' }, head: { ref: 'copilot/fix-checkout' }, merged: false, ...extra },
});
const runPayload = (conclusion, status = 'completed') => ({
  action: status === 'completed' ? 'completed' : 'requested',
  workflow_run: { id: 77, name: 'test', html_url: 'https://github.com/x/y/actions/runs/77', status, conclusion, head_branch: 'copilot/fix-checkout', pull_requests: [{ number: 7 }] },
});

test('webhook rejects bad signatures and needs a secret', async () => {
  const t = await setup();
  assert.equal((await deliver(t.base, 'ping', { zen: 'hi' }, { secret: false })).status, 401);
  assert.equal((await deliver(t.base, 'ping', { zen: 'hi' })).status, 200);
  await t.close();
  const app = createApp({ db: openDb(':memory:'), linear: null, github: null, agent: null, review: { webhookSecret: '' } });
  const base = await listen(app.server);
  assert.equal((await deliver(base, 'ping', {})).status, 503);
  await app.close();
});

test('dispatch records the agent branch; PR opened links the PR', async () => {
  const t = await setup();
  let r = await t.get();
  assert.equal(r.agent_branch, 'copilot/fix-checkout');
  const res = await json(await deliver(t.base, 'pull_request', prPayload(t.id)));
  assert.equal(res.event, 'pr.opened');
  r = await t.get();
  assert.equal(r.pr_number, 7);
  assert.equal(r.review_status, 'pr_open');
  await t.close();
});

test('PR is matched by the Requestor-Report marker when branch is unknown', async () => {
  const t = await setup();
  t.app.db.setAgentBranch(t.id, null);
  const res = await json(await deliver(t.base, 'pull_request', { ...prPayload(t.id), pull_request: { ...prPayload(t.id).pull_request, head: { ref: 'something-else' } } }));
  assert.equal(res.event, 'pr.opened');
  assert.equal((await t.get()).pr_number, 7);
  await t.close();
});

test('CI failure posts feedback to the PR with the log tail and counts a round', async () => {
  const t = await setup();
  await deliver(t.base, 'pull_request', prPayload(t.id));
  const res = await json(await deliver(t.base, 'workflow_run', runPayload('failure')));
  assert.equal(res.event, 'feedback.sent');
  const comment = t.gh.calls.find((c) => /\/issues\/7\/comments$/.test(c.url));
  assert.match(comment.body.body, /^@copilot CI failed/);
  assert.match(comment.body.body, /Failed job: test \(22\) \(step: Run npm test\)/);
  assert.match(comment.body.body, /ENOENT: no such file/);
  assert.doesNotMatch(comment.body.body, /2026-09-11T01:00/, 'timestamps stripped from log');
  assert.match(comment.body.body, /<!-- requestor -->/);
  const r = await t.get();
  assert.equal(r.review_status, 'ci_failed');
  assert.equal(r.feedback_rounds, 1);
  assert.deepEqual(r.events.map((e) => e.type), ['received', 'linear.skipped', 'agent.dispatched', 'pr.opened', 'ci.completed', 'feedback.sent']);
  await t.close();
});

test('a CI event links the PR even when no pull_request event was seen', async () => {
  const t = await setup();
  t.app.db.setAgentBranch(t.id, null); // simulate a report dispatched before branch tracking
  const res = await json(await deliver(t.base, 'workflow_run', { ...runPayload('failure'), workflow_run: { ...runPayload('failure').workflow_run, head_branch: 'copilot/eng-1-fix' } }));
  assert.equal(res.event, 'unmatched', 'no Linear identifier on this report, so no match');
  t.app.db.markSynced(t.id, { id: 'iss', identifier: 'ENG-1', url: 'https://linear.app/x/issue/ENG-1' });
  const res2 = await json(await deliver(t.base, 'workflow_run', { ...runPayload('failure'), workflow_run: { ...runPayload('failure').workflow_run, head_branch: 'copilot/eng-1-fix' } }));
  assert.equal(res2.event, 'feedback.sent');
  const r = await t.get();
  assert.equal(r.pr_number, 7);
  assert.equal(r.agent_branch, 'copilot/eng-1-fix');
  await t.close();
});

test('CI success marks ci_passed; cancelled runs are recorded only', async () => {
  const t = await setup();
  await deliver(t.base, 'pull_request', prPayload(t.id));
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload('success')))).event, 'ci.passed');
  assert.equal((await t.get()).review_status, 'ci_passed');
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload('cancelled')))).event, 'ci.completed');
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload(null, 'in_progress')))).event, 'ignored');
  await t.close();
});

test('feedback stops at the round cap and flags for a human', async () => {
  const t = await setup({ maxRounds: 1 });
  await deliver(t.base, 'pull_request', prPayload(t.id));
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload('failure')))).event, 'feedback.sent');
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload('failure')))).event, 'review.capped');
  const r = await t.get();
  assert.equal(r.review_status, 'needs_human');
  assert.equal(r.feedback_rounds, 1);
  assert.equal(t.gh.calls.filter((c) => /\/issues\/7\/comments$/.test(c.url)).length, 1);
  await t.close();
});

test('auto CI feedback can be turned off', async () => {
  const t = await setup({ autoCiFeedback: false });
  await deliver(t.base, 'pull_request', prPayload(t.id));
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload('failure')))).event, 'ci.failed');
  assert.equal((await t.get()).feedback_rounds, 0);
  await t.close();
});

test('runs awaiting approval are approved when enabled', async () => {
  const t = await setup({ autoApproveCi: true });
  await deliver(t.base, 'pull_request', prPayload(t.id));
  assert.equal((await json(await deliver(t.base, 'workflow_run', runPayload('action_required')))).event, 'ci.approved');
  assert.ok(t.gh.calls.some((c) => /\/actions\/runs\/77\/approve/.test(c.url)));
  await t.close();
});

test('duplicate deliveries are ignored', async () => {
  const t = await setup();
  await deliver(t.base, 'pull_request', prPayload(t.id), { delivery: 'same' });
  const dup = await json(await deliver(t.base, 'pull_request', prPayload(t.id), { delivery: 'same' }));
  assert.equal(dup.duplicate, true);
  assert.equal((await t.get()).events.filter((e) => e.type === 'pr.opened').length, 1);
  await t.close();
});

test('PR comments, reviews, and merges are recorded; own comments are skipped', async () => {
  const t = await setup();
  await deliver(t.base, 'pull_request', prPayload(t.id));
  await deliver(t.base, 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { body: 'Looks wrong', user: { login: 'reviewer' }, html_url: 'u' } });
  await deliver(t.base, 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { body: '@copilot fix\n\n<!-- requestor -->', user: { login: 'tykim6' } } });
  await deliver(t.base, 'pull_request_review', { action: 'submitted', pull_request: { number: 7, head: { ref: 'copilot/fix-checkout' } }, review: { state: 'changes_requested', user: { login: 'reviewer' }, body: 'nope' } });
  await deliver(t.base, 'pull_request', prPayload(t.id, 'closed', { merged: true }));
  const r = await t.get();
  assert.deepEqual(r.events.map((e) => e.type).slice(3), ['pr.opened', 'pr.comment', 'pr.review', 'pr.merged']);
  assert.equal(r.review_status, 'merged');
  await t.close();
});

test('manual feedback route posts to the PR', async () => {
  const t = await setup();
  const out = await json(await post(`${t.base}/api/bugs/${t.id}/feedback`, { text: 'Also handle the empty cart case.' }));
  assert.equal(out.review.rounds, 1);
  assert.equal(out.review.pr.number, 7, 'PR resolved from branch when not yet linked');
  const comment = t.gh.calls.find((c) => /\/issues\/7\/comments$/.test(c.url));
  assert.match(comment.body.body, /^@copilot Also handle the empty cart case\./);
  assert.equal((await post(`${t.base}/api/bugs/${t.id}/feedback`, { text: '' })).status, 400);
  await t.close();
});
