// Claude Code routine (experimental). Fire a pre-configured routine at claude.ai/code/routines;
// the routine holds the repo + standing prompt, we pass the bug report as `text`.
// Billed against the Claude subscription. No idempotency key: never retry blindly.
// There is no follow-up endpoint either, so feedback = a fresh session that is told about the last one.

const MAX_TEXT = 65_536;

export function createClaudeRoutineBackend({ fireUrl, token }) {
  if (!fireUrl || !token) throw new Error('claude-routine backend requires CLAUDE_ROUTINE_FIRE_URL and CLAUDE_ROUTINE_TOKEN');

  async function fire(text) {
    const res = await fetch(fireUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: text.slice(0, MAX_TEXT) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude routine fire failed (HTTP ${res.status}): ${data.error?.message || 'no message'}`);
    return { ref: data.claude_code_session_id, url: data.claude_code_session_url, raw: data };
  }

  return {
    name: 'claude-routine',
    dispatch: ({ prompt }) => fire(prompt),
    feedback({ report, text }) {
      const context = [
        `Follow-up on a previous session for this bug (${report.agent_url || report.agent_ref || 'unknown session'}).`,
        report.pr_url ? `Pull request: ${report.pr_url}` : null,
        report.agent_branch ? `Work on branch: ${report.agent_branch}` : null,
        '',
        text,
      ].filter((l) => l !== null).join('\n');
      return fire(context);
    },
  };
}
