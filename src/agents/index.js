// Agent backends share one interface:
//   { name, dispatch({ report, prompt }) => { ref, url, branch?, raw? },
//           feedback({ report, text })  => { ref, url, prNumber? } }
// Pick one with AGENT_BACKEND. Adding a backend = one file + one case here.

import { createCopilotBackend } from './copilot.js';
import { createClaudeRoutineBackend } from './claude-routine.js';
import { createLinearDelegateBackend } from './linear-delegate.js';

export function createAgentBackend(cfg, { linear, github } = {}) {
  switch (cfg.backend) {
    case '':
    case 'none': return null;
    case 'copilot':
      if (!github) throw new Error('copilot backend requires GITHUB_TOKEN and GITHUB_REPO');
      return createCopilotBackend({ github, ...cfg.copilot });
    case 'claude-routine': return createClaudeRoutineBackend(cfg.claudeRoutine);
    case 'linear-delegate': return createLinearDelegateBackend({ linear, ...cfg.linearDelegate });
    default: throw new Error(`unknown AGENT_BACKEND "${cfg.backend}" (use none | copilot | claude-routine | linear-delegate)`);
  }
}
