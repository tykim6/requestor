// GitHub Copilot cloud agent via the Agent Tasks REST API (public preview).
// Dispatch: POST /agents/repos/{owner}/{repo}/tasks -> agent works in GitHub's sandbox and opens a PR.
// Feedback: the API has no follow-up endpoint, so we comment on the PR mentioning @copilot,
// which starts a new session on the same branch.

import { createGitHubClient } from '../github.js';

export function createCopilotBackend({ github, token, repo, apiUrl, baseRef = 'main', model } = {}) {
  const gh = github ?? createGitHubClient({ token, repo, apiUrl });
  return {
    name: 'copilot',

    async dispatch({ prompt }) {
      const body = { prompt, base_ref: baseRef, create_pull_request: true };
      if (model) body.model = model;
      const data = await gh.createAgentTask(body);
      const branch = data.artifacts?.find((a) => a.type === 'branch')?.data?.head_ref ?? null;
      return { ref: String(data.id), url: data.html_url, branch, raw: data };
    },

    async feedback({ report, text }) {
      let prNumber = report.pr_number;
      if (!prNumber && report.agent_branch) prNumber = (await gh.findPullRequestByBranch(report.agent_branch))?.number ?? null;
      if (!prNumber) throw new Error('no pull request is linked to this report yet');
      const comment = await gh.commentOnIssue(prNumber, `@copilot ${text}\n\n<!-- requestor -->`);
      return { ref: String(comment.id), url: comment.html_url, prNumber };
    },
  };
}
