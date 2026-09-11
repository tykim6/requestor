// Verifies the Linear API key and shows which team/labels Requestor will use.
//   LINEAR_API_KEY=lin_api_... npm run linear:check
import { config } from '../src/config.js';
import { LinearClient } from '../src/linear.js';

if (!config.linear.apiKey) {
  console.error('LINEAR_API_KEY is not set (put it in .env or the environment).');
  process.exit(1);
}
const client = new LinearClient(config.linear);
try {
  const me = await client.viewer();
  console.log(`Authenticated as ${me.name} <${me.email}>`);
  const teams = await client.listTeams();
  console.log('Teams:', teams.map((t) => `${t.key} (${t.name})`).join(', ') || 'none');
  const team = await client.resolveTeam();
  console.log(`Will file issues in: ${team.key} (${team.name})`);
  const labelIds = await client.resolveLabelIds();
  console.log(`Labels resolved: ${labelIds.length}/${config.linear.labels.length} (${config.linear.labels.join(', ') || 'none configured'})`);
  console.log('OK');
} catch (err) {
  console.error('Check failed:', err.message);
  process.exit(1);
}
