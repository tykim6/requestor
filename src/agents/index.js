// Agent backends share one interface:
//   { name: string, dispatch({ report, prompt }) => Promise<{ ref, url, raw? }> }
// Pick one with AGENT_BACKEND. Adding a backend = one file + one case here.

import { createCopilotBackend } from './copilot.js';
import { createClaudeRoutineBackend } from './claude-routine.js';
import { createLinearDelegateBackend } from './linear-delegate.js';

export function createAgentBackend(cfg, { linear } = {}) {
  switch (cfg.backend) {
    case '':
    case 'none': return null;
    case 'copilot': return createCopilotBackend(cfg.copilot);
    case 'claude-routine': return createClaudeRoutineBackend(cfg.claudeRoutine);
    case 'linear-delegate': return createLinearDelegateBackend({ linear, ...cfg.linearDelegate });
    default: throw new Error(`unknown AGENT_BACKEND "${cfg.backend}" (use none | copilot | claude-routine | linear-delegate)`);
  }
}
