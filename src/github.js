// Minimal GitHub REST client for the pieces the review loop needs. No SDK.

export function createGitHubClient({ token, repo, apiUrl = 'https://api.github.com' }) {
  if (!token || !repo) throw new Error('GitHub client requires GITHUB_TOKEN and GITHUB_REPO (owner/name)');
  const [owner, name] = repo.split('/');
  const headers = (extra = {}) => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  });

  async function request(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${res.status}): ${data?.message || text.slice(0, 200) || 'no message'}`);
    return data;
  }

  return {
    repo, owner, name,

    /** Copilot cloud agent: POST /agents/repos/{owner}/{repo}/tasks */
    createAgentTask: (input) => request('POST', `/agents/repos/${repo}/tasks`, input),
    getAgentTask: (taskId) => request('GET', `/agents/repos/${repo}/tasks/${taskId}`),

    /** Plain PR-conversation comment (issue comment). Mentioning @copilot here starts a new agent session. */
    commentOnIssue: (number, body) => request('POST', `/repos/${repo}/issues/${number}/comments`, { body }),

    async findPullRequestByBranch(branch) {
      const prs = await request('GET', `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=1`);
      return prs[0] ?? null;
    },

    listRunJobs: async (runId) => (await request('GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=50`)).jobs ?? [],

    /** Raw log text for one job. GitHub redirects to blob storage; fetch follows it. */
    async getJobLogs(jobId) {
      const res = await fetch(`${apiUrl}/repos/${repo}/actions/jobs/${jobId}/logs`, { headers: headers() });
      if (!res.ok) throw new Error(`GitHub job logs failed (HTTP ${res.status})`);
      return res.text();
    },

    /** Runs on PRs from first-time contributors (Copilot included) wait for approval. */
    approveWorkflowRun: (runId) => request('POST', `/repos/${repo}/actions/runs/${runId}/approve`),
  };
}
