// Turns a stored report into a Linear issue title/description/priority.

const SEVERITY_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4 };
const LIMITS = { errors: 10, console: 30, breadcrumbs: 25, network: 15, description: 30_000 };

const fence = (s, lang = '') => `\`\`\`${lang}\n${s}\n\`\`\``;
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const shortTime = (ts) => (ts ? new Date(ts).toISOString().slice(11, 23) : '');
const last = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);

export function severityToPriority(severity) {
  return SEVERITY_PRIORITY[String(severity || '').toLowerCase()] ?? 0;
}

export function buildIssueTitle(report) {
  const sev = report.severity ? `[${report.severity}] ` : '';
  return `${sev}${report.title}`.trim();
}

export function buildIssueDescription(report, { publicBaseUrl } = {}) {
  const t = report.telemetry || {};
  const who = report.reporter || {};
  const parts = [];

  parts.push('## Report');
  parts.push(report.description?.trim() || '_No description provided._');
  parts.push('');
  parts.push(`- **Severity:** ${report.severity || 'unspecified'}`);
  parts.push(`- **Reporter:** ${[who.name, who.email && `<${who.email}>`, who.id && `(id: ${who.id})`].filter(Boolean).join(' ') || 'anonymous'}`);
  parts.push(`- **Page:** ${report.page_url || t.url || 'unknown'}`);
  parts.push(`- **Filed:** ${report.created_at}`);

  const env = [
    ['Browser', t.userAgent],
    ['Platform', t.platform],
    ['Language', t.language],
    ['Timezone', t.timezone],
    ['Viewport', t.viewport && `${t.viewport.width}x${t.viewport.height}`],
    ['Screen', t.screen && `${t.screen.width}x${t.screen.height} @${t.screen.dpr}x`],
    ['Online', t.online],
    ['Referrer', t.referrer],
    ['Time on page', t.timeOnPageMs != null && `${Math.round(t.timeOnPageMs / 1000)}s`],
    ['Page load', t.performance?.loadMs != null && `${t.performance.loadMs}ms`],
  ].filter(([, v]) => v != null && v !== '' && v !== false);
  if (env.length) {
    parts.push('', '## Environment', '| | |', '|---|---|');
    for (const [k, v] of env) parts.push(`| ${k} | ${esc(v)} |`);
  }

  const errors = last(t.errors, LIMITS.errors);
  parts.push('', `## Errors (${(t.errors || []).length})`);
  if (errors.length) {
    for (const e of errors) {
      parts.push(`**${shortTime(e.ts)}** ${e.type || 'error'}: ${esc(e.message)}`);
      if (e.stack) parts.push(fence(String(e.stack).slice(0, 1500)));
    }
  } else parts.push('_None captured._');

  const network = last(t.network, LIMITS.network);
  if (network.length) {
    parts.push('', `## Failed requests (${(t.network || []).length})`, '| time | method | status | url | ms |', '|---|---|---|---|---|');
    for (const n of network) parts.push(`| ${shortTime(n.ts)} | ${esc(n.method)} | ${esc(n.status ?? n.error)} | ${esc(n.url)} | ${n.durationMs ?? ''} |`);
  }

  const crumbs = last(t.breadcrumbs, LIMITS.breadcrumbs);
  if (crumbs.length) {
    parts.push('', '## Steps before report');
    parts.push(fence(crumbs.map((b) => `${shortTime(b.ts)} ${b.type.padEnd(8)} ${b.detail}`).join('\n')));
  }

  const logs = last(t.console, LIMITS.console);
  if (logs.length) {
    parts.push('', '## Console');
    parts.push(fence(logs.map((l) => `${shortTime(l.ts)} [${l.level}] ${l.message}`).join('\n')));
  }

  if (report.context && Object.keys(report.context).length) {
    parts.push('', '## App context', fence(JSON.stringify(report.context, null, 2), 'json'));
  }

  parts.push('', '---');
  const link = publicBaseUrl ? `[${report.id}](${publicBaseUrl}/api/bugs/${report.id})` : `\`${report.id}\``;
  parts.push(`Filed via Requestor. Full report: ${link}`);

  let out = parts.join('\n');
  if (out.length > LIMITS.description) out = out.slice(0, LIMITS.description - 20) + '\n\n_(truncated)_';
  return out;
}

// What a coding agent receives. The Linear description already carries all the
// evidence, so wrap it with the job and the link back to the issue.
export function buildAgentPrompt(report, { publicBaseUrl } = {}) {
  const head = [
    'You are fixing a bug reported by a user through the Requestor bug-report widget.',
    report.linear_identifier ? `Linear issue: ${report.linear_identifier} (${report.linear_url})` : null,
    '',
    'Goal: find the root cause, fix it, add or update a test where reasonable, and open a pull request.',
    'In the PR description, reference the Linear issue and summarize the cause and the fix.',
    'If the report is not reproducible or not actionable from the code, do not open a PR; explain why instead.',
    '',
    '--- Bug report ---',
    `Title: ${report.title}`,
    '',
  ].filter((l) => l !== null);
  return head.join('\n') + buildIssueDescription(report, { publicBaseUrl });
}
