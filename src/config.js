import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* ignore, fall back to process.env */ }
}

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();

export const config = {
  port: Number(env('PORT', '3100')),
  dbPath: env('DB_PATH', './data/requestor.sqlite'),
  allowedOrigins: env('ALLOWED_ORIGINS', '*').split(',').map((s) => s.trim()).filter(Boolean),
  publicBaseUrl: env('PUBLIC_BASE_URL', '').replace(/\/$/, ''),
  adminToken: env('ADMIN_TOKEN'),
  linear: {
    apiKey: env('LINEAR_API_KEY'),
    apiUrl: env('LINEAR_API_URL', 'https://api.linear.app/graphql'),
    teamKey: env('LINEAR_TEAM_KEY'),
    teamId: env('LINEAR_TEAM_ID'),
    labels: env('LINEAR_LABELS').split(',').map((s) => s.trim()).filter(Boolean),
  },
  agent: {
    backend: env('AGENT_BACKEND', 'none'),
    autoDispatch: env('AGENT_AUTO_DISPATCH', 'false') === 'true',
    copilot: {
      token: env('GITHUB_TOKEN'),
      repo: env('GITHUB_REPO'),
      baseRef: env('GITHUB_BASE_REF', 'main'),
      model: env('COPILOT_MODEL'),
    },
    claudeRoutine: { fireUrl: env('CLAUDE_ROUTINE_FIRE_URL'), token: env('CLAUDE_ROUTINE_TOKEN') },
    linearDelegate: { delegateId: env('LINEAR_DELEGATE_ID') },
  },
};

export const linearEnabled = () => Boolean(config.linear.apiKey);
