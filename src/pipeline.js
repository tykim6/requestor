// The report pipeline. Each stage logs an event so the full history of a
// report is reconstructable from the events table. Adding a stage (e.g. an
// agentic triage/fix step) means appending another step after syncToLinear.

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
      db.addEvent(reportId, 'agent.dispatched', { backend: agent.name, ref: result.ref, url: result.url, raw: result.raw ?? null });
    } catch (err) {
      db.markAgentFailed(reportId, agent.name, err.message);
      db.addEvent(reportId, 'agent.failed', { backend: agent.name, error: err.message });
      console.error(`[requestor] agent dispatch failed for ${reportId}: ${err.message}`);
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
  };
}
