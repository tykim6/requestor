# Contributing

Thanks for helping. Requestor is deliberately small: no build step, no npm dependencies, Node's built-in test runner and SQLite.

## Setup

```bash
git clone https://github.com/tykim6/requestor
cd requestor
cp .env.example .env   # optional; everything works in log-only mode without keys
npm start              # http://localhost:3100/demo/
npm test
```

Node 22.13 or newer is required for `node:sqlite`.

## Where things live

| Path | What |
|---|---|
| `widget/requestor.js` | The drop-in browser script. Plain ES5-friendly JS, no bundler. Keep it dependency-free and small. |
| `src/server.js` | HTTP routes and static serving. |
| `src/pipeline.js` | The report lifecycle: validate, store, sync to Linear, dispatch to an agent. Every stage appends to the `events` table. |
| `src/agents/` | One file per coding-agent backend. |
| `src/format.js` | How a report becomes a Linear issue and an agent prompt. |
| `test/` | `node:test` suites. External services are faked with a local HTTP server; tests never hit the network. |

## Adding an agent backend

1. Create `src/agents/<name>.js` exporting a factory that returns `{ name, dispatch({ report, prompt }) }`. `dispatch` resolves to `{ ref, url, raw? }` or throws.
2. Add a case in `src/agents/index.js` and the env vars in `src/config.js` and `.env.example`.
3. Add a test in `test/agents.test.js` using `fakeServer` so the request shape is pinned.
4. Document it in the README table.

## Pull requests

- Keep changes focused. One fix or feature per PR.
- `npm test` must pass. CI runs it on every PR.
- Don't add dependencies without a reason in the PR description.
- Never commit `.env`, tokens, or the `data/` directory.

## Reporting bugs

Open a GitHub issue with steps to reproduce. If it's about the widget, the browser and page URL help.
