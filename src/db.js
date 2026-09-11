import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT,
  page_url TEXT,
  reporter TEXT,      -- JSON: who filed it (from Requestor.identify + form email)
  context TEXT,       -- JSON: host-app supplied context (Requestor.setContext)
  telemetry TEXT,     -- JSON: auto-captured browser telemetry
  status TEXT NOT NULL, -- received | synced | sync_failed
  linear_issue_id TEXT,
  linear_identifier TEXT,
  linear_url TEXT,
  sync_error TEXT
);
CREATE INDEX IF NOT EXISTS reports_created_at ON reports(created_at);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status);

-- Append-only log of everything that happens to a report. Every pipeline stage
-- (intake, Linear, agent dispatch, PR/CI/feedback rounds) appends here.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS events_report_id ON events(report_id);

-- Webhook delivery ids we have already processed (GitHub redelivers).
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

// Columns added after the initial schema. Applied idempotently so existing DBs upgrade in place.
const ADDED_COLUMNS = [
  // coding-agent hand-off
  ['agent_backend', 'TEXT'], ['agent_status', 'TEXT'], ['agent_ref', 'TEXT'], ['agent_url', 'TEXT'], ['agent_error', 'TEXT'],
  // review loop: the PR the agent opened, CI outcome, feedback rounds spent
  ['agent_branch', 'TEXT'], ['pr_number', 'INTEGER'], ['pr_url', 'TEXT'],
  ['review_status', 'TEXT'], // pr_open | ci_awaiting_approval | ci_failed | ci_passed | merged | closed | needs_human
  ['feedback_rounds', 'INTEGER NOT NULL DEFAULT 0'],
];
function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) if (!have.has(name)) db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
}

const now = () => new Date().toISOString();
const toJson = (v) => (v == null ? null : JSON.stringify(v));
const fromJson = (s) => (s == null ? null : JSON.parse(s));

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);

  const stmts = {
    insert: db.prepare(`INSERT INTO reports
      (id, created_at, updated_at, title, description, severity, page_url, reporter, context, telemetry, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`),
    get: db.prepare('SELECT * FROM reports WHERE id = ?'),
    byBranch: db.prepare('SELECT * FROM reports WHERE agent_branch = ? ORDER BY created_at DESC LIMIT 1'),
    byPr: db.prepare('SELECT * FROM reports WHERE pr_number = ? ORDER BY created_at DESC LIMIT 1'),
    byLinear: db.prepare('SELECT * FROM reports WHERE linear_identifier = ? ORDER BY created_at DESC LIMIT 1'),
    list: db.prepare(`SELECT id, created_at, updated_at, title, severity, page_url, status,
      linear_identifier, linear_url, sync_error, agent_backend, agent_status, agent_url,
      pr_number, pr_url, review_status, feedback_rounds FROM reports ORDER BY created_at DESC LIMIT ?`),
    markSynced: db.prepare(`UPDATE reports SET status = 'synced', updated_at = ?, sync_error = NULL,
      linear_issue_id = ?, linear_identifier = ?, linear_url = ? WHERE id = ?`),
    markFailed: db.prepare(`UPDATE reports SET status = 'sync_failed', updated_at = ?, sync_error = ? WHERE id = ?`),
    markAgentDispatched: db.prepare(`UPDATE reports SET updated_at = ?, agent_backend = ?, agent_status = 'dispatched',
      agent_ref = ?, agent_url = ?, agent_branch = COALESCE(?, agent_branch), agent_error = NULL WHERE id = ?`),
    markAgentFailed: db.prepare(`UPDATE reports SET updated_at = ?, agent_backend = ?, agent_status = 'failed', agent_error = ? WHERE id = ?`),
    setBranch: db.prepare('UPDATE reports SET updated_at = ?, agent_branch = ? WHERE id = ?'),
    setPr: db.prepare('UPDATE reports SET updated_at = ?, pr_number = ?, pr_url = ? WHERE id = ?'),
    setReview: db.prepare('UPDATE reports SET updated_at = ?, review_status = ? WHERE id = ?'),
    bumpRounds: db.prepare('UPDATE reports SET updated_at = ?, feedback_rounds = feedback_rounds + 1 WHERE id = ?'),
    addEvent: db.prepare('INSERT INTO events (report_id, created_at, type, payload) VALUES (?, ?, ?, ?)'),
    events: db.prepare('SELECT * FROM events WHERE report_id = ? ORDER BY id ASC'),
    claimDelivery: db.prepare('INSERT OR IGNORE INTO deliveries (id, created_at) VALUES (?, ?)'),
  };

  const hydrate = (row) => row && {
    ...row,
    reporter: fromJson(row.reporter),
    context: fromJson(row.context),
    telemetry: fromJson(row.telemetry),
  };

  return {
    raw: db,
    createReport(r) {
      const ts = now();
      stmts.insert.run(r.id, ts, ts, r.title, r.description ?? null, r.severity ?? null, r.pageUrl ?? null,
        toJson(r.reporter), toJson(r.context), toJson(r.telemetry));
      return this.getReport(r.id);
    },
    getReport: (id) => hydrate(stmts.get.get(id)),
    findReportByBranch: (branch) => hydrate(stmts.byBranch.get(branch)),
    findReportByPr: (number) => hydrate(stmts.byPr.get(number)),
    findReportByLinearIdentifier: (identifier) => hydrate(stmts.byLinear.get(identifier)),
    listReports: (limit = 50) => stmts.list.all(limit),
    markSynced(id, issue) { stmts.markSynced.run(now(), issue.id, issue.identifier, issue.url, id); },
    markSyncFailed(id, error) { stmts.markFailed.run(now(), String(error).slice(0, 2000), id); },
    markAgentDispatched(id, backend, result) {
      stmts.markAgentDispatched.run(now(), backend, result.ref ?? null, result.url ?? null, result.branch ?? null, id);
    },
    markAgentFailed(id, backend, error) { stmts.markAgentFailed.run(now(), backend, String(error).slice(0, 2000), id); },
    setAgentBranch(id, branch) { stmts.setBranch.run(now(), branch, id); },
    setPullRequest(id, number, url) { stmts.setPr.run(now(), number, url, id); },
    setReviewStatus(id, status) { stmts.setReview.run(now(), status, id); },
    incrementFeedbackRounds(id) { stmts.bumpRounds.run(now(), id); return stmts.get.get(id).feedback_rounds; },
    addEvent(reportId, type, payload) { stmts.addEvent.run(reportId, now(), type, toJson(payload)); },
    getEvents: (reportId) => stmts.events.all(reportId).map((e) => ({ ...e, payload: fromJson(e.payload) })),
    /** true the first time a delivery id is seen, false on redelivery */
    claimDelivery: (id) => stmts.claimDelivery.run(id, now()).changes > 0,
    close: () => db.close(),
  };
}
