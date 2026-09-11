// The review loop. Turns GitHub webhook events into report events and decides
// when the agent gets another turn. Policy lives here; transport lives in server.js.
//
//   pull_request  -> link PR to report, record pr.* events
//   workflow_run  -> record ci.*; on failure, auto-feedback with logs (bounded by maxRounds)
//   issue_comment / pull_request_review -> record the conversation on the PR
//
// The human stays the merger. Nothing here merges.

import { formatCiFailure } from './format.js';

const REPORT_MARKER = /Requestor-Report:\s*([0-9a-f-]{36})/i;
const LINEAR_ID = /\b([A-Z][A-Z0-9]*-\d+)\b/;
const OWN_COMMENT = '<!-- requestor -->';

export function createReviewLoop({ db, pipeline, github, maxRounds = 2, autoCiFeedback = true, autoApproveCi = false }) {
  // Match a webhook to a report: by PR number, by branch, by the marker line the agent was asked
  // to put in the PR body, then by a Linear identifier in the branch name or text.
  function findReport({ prNumber, branch, text = '' } = {}) {
    if (prNumber) { const r = db.findReportByPr(prNumber); if (r) return r; }
    if (branch) { const r = db.findReportByBranch(branch); if (r) return r; }
    const marker = text.match(REPORT_MARKER);
    if (marker) { const r = db.getReport(marker[1]); if (r) return r; }
    const fromBranch = branch?.match(/([a-z][a-z0-9]*-\d+)/i)?.[1]?.toUpperCase();
    const fromText = text.match(LINEAR_ID)?.[1];
    for (const id of [fromBranch, fromText]) if (id) { const r = db.findReportByLinearIdentifier(id); if (r) return r; }
    return null;
  }

  function link(report, pr) {
    if (!report.pr_number && pr?.number) db.setPullRequest(report.id, pr.number, pr.html_url);
    if (!report.agent_branch && pr?.head?.ref) db.setAgentBranch(report.id, pr.head.ref);
  }

  async function onPullRequest(payload) {
    const pr = payload.pull_request;
    const report = findReport({ prNumber: pr.number, branch: pr.head?.ref, text: `${pr.title}\n${pr.body ?? ''}` });
    if (!report) return null;
    link(report, pr);
    const info = { number: pr.number, url: pr.html_url, title: pr.title, draft: pr.draft, author: pr.user?.login, head: pr.head?.ref };
    const map = { opened: 'pr.opened', reopened: 'pr.reopened', synchronize: 'pr.synchronized', ready_for_review: 'pr.ready', converted_to_draft: 'pr.draft', edited: 'pr.edited' };
    if (payload.action === 'closed') {
      const type = pr.merged ? 'pr.merged' : 'pr.closed';
      db.addEvent(report.id, type, info);
      db.setReviewStatus(report.id, pr.merged ? 'merged' : 'closed');
      if (pr.merged) await pipeline.noteOnIssue(report, `Pull request merged: ${pr.html_url}`);
      return { reportId: report.id, event: type };
    }
    const type = map[payload.action] ?? `pr.${payload.action}`;
    db.addEvent(report.id, type, info);
    if (payload.action === 'opened' || payload.action === 'reopened') {
      db.setReviewStatus(report.id, 'pr_open');
      await pipeline.noteOnIssue(report, `Pull request opened: ${pr.html_url}`);
    }
    return { reportId: report.id, event: type };
  }

  async function onWorkflowRun(payload) {
    const run = payload.workflow_run;
    const pr = run.pull_requests?.[0];
    const report = findReport({ prNumber: pr?.number, branch: run.head_branch });
    if (!report) return null;
    // A CI event can be the first thing we hear about a PR (e.g. reports dispatched before webhooks were on).
    link(report, pr ? { number: pr.number, html_url: `https://github.com/${github?.repo ?? ''}/pull/${pr.number}`, head: { ref: run.head_branch } } : { head: { ref: run.head_branch } });
    const info = { runId: run.id, name: run.name, url: run.html_url, conclusion: run.conclusion, head: run.head_branch };
    if (run.status !== 'completed') return { reportId: report.id, event: 'ignored' };

    if (run.conclusion === 'action_required') {
      db.addEvent(report.id, 'ci.awaiting_approval', info);
      if (!autoApproveCi) return { reportId: report.id, event: 'ci.awaiting_approval' };
      try {
        await github.approveWorkflowRun(run.id);
        db.addEvent(report.id, 'ci.approved', info);
        return { reportId: report.id, event: 'ci.approved' };
      } catch (err) {
        db.addEvent(report.id, 'ci.approve_failed', { ...info, error: err.message });
        return { reportId: report.id, event: 'ci.approve_failed' };
      }
    }

    db.addEvent(report.id, 'ci.completed', info);
    if (run.conclusion === 'success') {
      db.setReviewStatus(report.id, 'ci_passed');
      return { reportId: report.id, event: 'ci.passed' };
    }
    if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') return { reportId: report.id, event: 'ci.completed' };

    db.setReviewStatus(report.id, 'ci_failed');
    if (!autoCiFeedback) return { reportId: report.id, event: 'ci.failed' };
    if (report.feedback_rounds >= maxRounds) {
      db.setReviewStatus(report.id, 'needs_human');
      db.addEvent(report.id, 'review.capped', { rounds: report.feedback_rounds, maxRounds, url: run.html_url });
      await pipeline.noteOnIssue(report, `CI is still failing after ${report.feedback_rounds} agent round(s); needs a human. ${run.html_url}`);
      return { reportId: report.id, event: 'review.capped' };
    }
    const text = await describeFailure(run);
    try {
      await pipeline.sendFeedback(report.id, text, { source: 'ci' });
      return { reportId: report.id, event: 'feedback.sent' };
    } catch (err) {
      return { reportId: report.id, event: 'feedback.failed', error: err.message };
    }
  }

  // Failing jobs, failing steps, and the tail of each failing job's log.
  async function describeFailure(run) {
    let jobs = [];
    try { jobs = await github.listRunJobs(run.id); } catch { /* fall through with what we have */ }
    const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out').slice(0, 3);
    const details = [];
    for (const job of failed) {
      const steps = (job.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
      let log = null;
      try { log = await github.getJobLogs(job.id); } catch { /* logs are optional */ }
      details.push({ name: job.name, url: job.html_url, steps, log });
    }
    return formatCiFailure({ run, jobs: details });
  }

  function onIssueComment(payload) {
    if (!payload.issue?.pull_request) return null; // plain issue, not a PR
    const body = payload.comment?.body ?? '';
    if (body.includes(OWN_COMMENT)) return { event: 'ignored.own' };
    const report = findReport({ prNumber: payload.issue.number, text: body });
    if (!report) return null;
    db.addEvent(report.id, 'pr.comment', { number: payload.issue.number, author: payload.comment?.user?.login, url: payload.comment?.html_url, excerpt: body.slice(0, 500) });
    return { reportId: report.id, event: 'pr.comment' };
  }

  function onPullRequestReview(payload) {
    const pr = payload.pull_request;
    const report = findReport({ prNumber: pr?.number, branch: pr?.head?.ref });
    if (!report) return null;
    db.addEvent(report.id, 'pr.review', { number: pr.number, author: payload.review?.user?.login, state: payload.review?.state, url: payload.review?.html_url, excerpt: (payload.review?.body ?? '').slice(0, 500) });
    return { reportId: report.id, event: 'pr.review' };
  }

  return {
    findReport,
    async handle(event, payload) {
      switch (event) {
        case 'ping': return { event: 'pong' };
        case 'pull_request': return (await onPullRequest(payload)) ?? { event: 'unmatched' };
        case 'workflow_run': return (await onWorkflowRun(payload)) ?? { event: 'unmatched' };
        case 'issue_comment': return onIssueComment(payload) ?? { event: 'unmatched' };
        case 'pull_request_review': return onPullRequestReview(payload) ?? { event: 'unmatched' };
        default: return { event: 'ignored' };
      }
    },
  };
}
