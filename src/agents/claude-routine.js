// Claude Code routine (experimental). Fire a pre-configured routine at claude.ai/code/routines;
// the routine holds the repo + standing prompt, we pass the bug report as `text`.
// Billed against the Claude subscription. No idempotency key: never retry blindly.

const MAX_TEXT = 65_536;

export function createClaudeRoutineBackend({ fireUrl, token }) {
  if (!fireUrl || !token) throw new Error('claude-routine backend requires CLAUDE_ROUTINE_FIRE_URL and CLAUDE_ROUTINE_TOKEN');
  return {
    name: 'claude-routine',
    async dispatch({ prompt }) {
      const res = await fetch(fireUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: prompt.slice(0, MAX_TEXT) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Claude routine fire failed (HTTP ${res.status}): ${data.error?.message || 'no message'}`);
      return { ref: data.claude_code_session_id, url: data.claude_code_session_url, raw: data };
    },
  };
}
