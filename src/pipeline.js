// The report pipeline. Each stage logs an event so the full history of a
// report is reconstructable from the events table.
//   submit -> store -> syncToLinear -> (auto) dispatchAgent
//   sendFeedback: a further turn to the agent (manual, or from the review loop in review.js)

import { randomUUID } from 'node:crypto';
import { buildAgentPrompt, buildIssueDescription, buildIssueTitle, severityToPriority } from './format.js';

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

export function validateSubmission(body) {
  const title = str(body?.title, 200);
  if (!title) return { error: 'title is required' };
  const severity = str(body?.severity, 20).toLowerCase();
  return {
    value: {
      id: randomUUID(),
      title,
      description: str(body.description, 10_000),
      severity: SEVERITIES.has(severity) ? severity : 'medium',
      pageUrl: str(body.telemetry?.url ?? body.pageUrl, 2000) || null,
      reporter: obj(body.reporter),
      context: obj(body.context),
      telemetry: obj(body.telemetry),
    },
  };
}

export function createPipeline({ db, linear, agent = null, autoDispatch = false, publicBaseUrl }) {
  async function syncToLinear(reportId) {
    const report = db.getReport(reportId);
    if (!report) throw new Error(`report ${reportId} not found`);
    if (!linear) {
      db.addEvent(reportId, 'linear.skipped', { reason: 'LINEAR_API_KEY not configured' });
      return report;
    }
    const input = {
      title: buildIssueTitle(report),
      description: buildIssueDescription(report, { publicBaseUrl }),
      priority: severityToPriority(report.severity),
    };
    try {
      const issue = await linear.createIssue(input);
      db.markSynced(reportId, issue);
      db.addEvent(reportId, 'linear.created', issue);
    } catch (err) {
      db.markSyncFailed(reportId, err.message);
      db.addEvent(reportId, 'linear.failed', { error: err.message });
      console.error(`[requestor] Linear sync failed for ${reportId}: ${err.message}`);
    }
    return db.getReport(reportId);
  }

  // Best-effort note on the Linear issue so whoever watches it sees where the work went.
  async function noteOnIssue(report, body, eventType = 'linear.commented') {
    if (!linear || !report.linear_issue_id) return;
    try {
      const comment = await linear.createComment(report.linear_issue_id, `${body}\n\n_Posted by Requestor._`);
      db.addEvent(report.id, eventType, { commentId: comment.id, url: comment.url });
    } catch (err) {
      db.addEvent(report.id, 'linear.comment_failed', { error: err.message });
      console.error(`[requestor] Linear comment failed for ${report.id}: ${err.message}`);
    }
  }

  // Hand the report to a coding agent. Explicit (POST /api/bugs/:id/dispatch) unless AGENT_AUTO_DISPATCH=true.
  async function dispatchAgent(reportId) {
    const report = db.getReport(reportId);
    if (!report) throw new Error(`report ${reportId} not found`);
    if (!agent) {
      db.addEvent(reportId, 'agent.skipped', { reason: 'AGENT_BACKEND not configured' });
      return report;
    }
    const prompt = buildAgentPrompt(report, { publicBaseUrl });
    try {
      const result = await agent.dispatch({ report, prompt });
      db.markAgentDispatched(reportId, agent.name, result);
      db.addEvent(reportId, 'agent.dispatched', { backend: agent.name, ref: result.ref, url: result.url, branch: result.branch ?? null, raw: result.raw ?? null });
      if (agent.name !== 'linear-delegate') await noteOnIssue(report, `Handed to coding agent **${agent.name}**${result.url ? `: ${result.url}` : ''}`);
    } catch (err) {
      db.markAgentFailed(reportId, agent.name, err.message);
      db.addEvent(reportId, 'agent.failed', { backend: agent.name, error: err.message });
      console.error(`[requestor] agent dispatch failed for ${reportId}: ${err.message}`);
    }
    return db.getReport(reportId);
  }

  // One more turn for the agent. `source` is 'manual' | 'ci' | 'review'. Throws on failure so callers can surface it.
  async function sendFeedback(reportId, text, { source = 'manual' } = {}) {
    const report = db.getReport(reportId);
    if (!report) throw new Error(`report ${reportId} not found`);
    if (!agent) throw new Error('AGENT_BACKEND not configured');
    if (!agent.feedback) throw new Error(`${agent.name} backend does not support feedback`);
    if (report.agent_status !== 'dispatched') throw new Error('report has not been dispatched to an agent');
    try {
      const result = await agent.feedback({ report, text });
      if (result.prNumber && !report.pr_number) db.setPullRequest(reportId, result.prNumber, report.pr_url);
      const rounds = db.incrementFeedbackRounds(reportId);
      db.addEvent(reportId, 'feedback.sent', { source, backend: agent.name, round: rounds, ref: result.ref, url: result.url, text: text.slice(0, 4000) });
    } catch (err) {
      db.addEvent(reportId, 'feedback.failed', { source, backend: agent.name, error: err.message });
      throw err;
    }
    return db.getReport(reportId);
  }

  return {
    async submit(submission, meta = {}) {
      const report = db.createReport(submission);
      db.addEvent(report.id, 'received', { ip: meta.ip, origin: meta.origin, userAgent: meta.userAgent });
      const synced = await syncToLinear(report.id);
      return autoDispatch && agent ? dispatchAgent(report.id) : synced;
    },
    retrySync: syncToLinear,
    dispatchAgent,
    sendFeedback,
    noteOnIssue,
  };
}
