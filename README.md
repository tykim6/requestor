# Requestor

Bare-bones bug intake: a drop-in bug icon for any website that collects a description plus browser telemetry, logs everything to SQLite, and files an informative Linear issue.

Zero npm dependencies. Requires Node 22.13+ (uses the built-in `node:sqlite`).

## Run

```bash
cp .env.example .env     # fill in LINEAR_API_KEY + LINEAR_TEAM_KEY when ready
npm start                # http://localhost:3100  -> demo site at /demo/
npm test
npm run linear:check     # verifies the key, prints team + labels it will use
```

Without `LINEAR_API_KEY` the server runs in log-only mode: reports are stored and marked `received`, with a `linear.skipped` event. Add the key, restart, and new reports sync. Older ones can be pushed with `POST /api/bugs/:id/sync`.

## Embed on a site

```html
<script src="https://requestor.example.com/requestor.js"></script>
<script>
  Requestor.identify({ id: 'u_42', email: 'jane@example.com', name: 'Jane' }); // optional
  Requestor.setContext({ plan: 'pro', release: '2026.09.10' });                  // optional, anything useful
</script>
```

Script attributes: `data-endpoint` (defaults to the script's origin + `/api/bugs`), `data-position="bottom-left"`, `data-label="Feedback"`, `data-hidden="true"` (no floating button; call `Requestor.open()` from your own UI).

`Requestor.report({ title, description, severity })` files a report programmatically. `Requestor.snapshot()` returns what would be attached.

## What gets captured

From the moment the script loads: uncaught errors and unhandled rejections (with stacks), console output (last 50), failed fetch/XHR requests, and a breadcrumb trail of clicks, form submits, and navigations. At submit time: URL, referrer, user agent, viewport/screen, language, timezone, online state, page load timing, time on page. Users can untick "Include technical details".

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/bugs` | Widget submits here. CORS-enabled per `ALLOWED_ORIGINS`. Returns `{id, status, linear}`. |
| GET | `/api/bugs?limit=50` | Recent reports. Requires `Authorization: Bearer $ADMIN_TOKEN` if set. |
| GET | `/api/bugs/:id` | Full report incl. telemetry and event log. |
| POST | `/api/bugs/:id/sync` | Retry Linear sync. |
| POST | `/api/bugs/:id/dispatch` | Hand the report to the configured coding agent. |
| GET | `/api/health` | Shows whether Linear is configured. |

## Layout

```
widget/requestor.js   drop-in browser script (button, form, telemetry)
src/server.js         HTTP server, routes, static demo
src/pipeline.js       validate -> store -> sync to Linear -> dispatch to agent
src/agents/           one file per agent backend (copilot, claude-routine, linear-delegate)
src/linear.js         Linear GraphQL client
src/format.js         report -> Linear title/description/priority
src/db.js             SQLite: reports + append-only events
demo/index.html       stock site for testing
```

## Coding agent hand-off

After the Linear issue exists, a report can be dispatched to a coding agent that fixes the bug and opens a PR. Pick one backend with `AGENT_BACKEND`:

| Backend | What it calls | Pays with | Needs |
|---|---|---|---|
| `copilot` | GitHub Agent Tasks API (`POST /agents/repos/{owner}/{repo}/tasks`) | Copilot Pro/Pro+/Business premium requests | `GITHUB_TOKEN`, `GITHUB_REPO` |
| `claude-routine` | Claude Code routine fire endpoint | Claude Pro/Max/Team subscription | `CLAUDE_ROUTINE_FIRE_URL`, `CLAUDE_ROUTINE_TOKEN` |
| `linear-delegate` | `issueUpdate(delegateId)` on the Linear issue | Whichever agent you installed in Linear | `LINEAR_DELEGATE_ID` |

Dispatch is manual by default (`POST /api/bugs/:id/dispatch`) so a public widget can't burn agent quota. Set `AGENT_AUTO_DISPATCH=true` to hand off every report right after it syncs. Outcomes land on the report (`agent_status`, `agent_url`) and in the events log (`agent.dispatched` / `agent.failed`).

The prompt the agent receives is the Linear description plus a short job statement (see `buildAgentPrompt` in `src/format.js`). Adding a backend is one file in `src/agents/` plus a case in `src/agents/index.js`. A later stage can listen for the PR (Linear webhook or GitHub webhook) and append `agent.pr_opened`.
