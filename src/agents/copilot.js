// GitHub Copilot cloud agent via the Agent Tasks REST API (public preview).
// POST /agents/repos/{owner}/{repo}/tasks -> the agent works in GitHub's sandbox and opens a PR.
// Needs a user token (fine-grained PAT or OAuth) with "Agent tasks" read/write on the repo.

export function createCopilotBackend({ token, repo, baseRef = 'main', model, apiUrl = 'https://api.github.com' }) {
  if (!token || !repo) throw new Error('copilot backend requires GITHUB_TOKEN and GITHUB_REPO (owner/name)');
  return {
    name: 'copilot',
    async dispatch({ prompt }) {
      const body = { prompt, base_ref: baseRef, create_pull_request: true };
      if (model) body.model = model;
      const res = await fetch(`${apiUrl}/agents/repos/${repo}/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Copilot agent task failed (HTTP ${res.status}): ${data.message || 'no message'}`);
      return { ref: String(data.id), url: data.html_url, raw: data };
    },
  };
}
