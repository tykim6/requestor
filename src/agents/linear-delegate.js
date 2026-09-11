// Delegate the Linear issue to an agent installed in the Linear workspace
// (Copilot, Cursor, Codex, Devin, ...). Linear notifies the agent; it opens a PR
// and reports back on the issue. Feedback is a comment on that issue.

export function createLinearDelegateBackend({ linear, delegateId }) {
  if (!linear) throw new Error('linear-delegate backend requires Linear to be configured');
  if (!delegateId) throw new Error('linear-delegate backend requires LINEAR_DELEGATE_ID (the agent app user id)');
  return {
    name: 'linear-delegate',
    async dispatch({ report }) {
      if (!report.linear_issue_id) throw new Error('report has no Linear issue to delegate');
      const issue = await linear.updateIssue(report.linear_issue_id, { delegateId });
      return { ref: issue.identifier, url: issue.url };
    },
    async feedback({ report, text }) {
      if (!report.linear_issue_id) throw new Error('report has no Linear issue');
      const comment = await linear.createComment(report.linear_issue_id, text);
      return { ref: comment.id, url: comment.url };
    },
  };
}
