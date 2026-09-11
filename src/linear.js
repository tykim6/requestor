// Minimal Linear GraphQL client. No SDK, just fetch.
// Personal API keys (lin_api_...) go in the Authorization header raw; OAuth tokens use Bearer.

export class LinearClient {
  #cache = { team: null, labels: null };

  constructor({ apiKey, apiUrl, teamKey, teamId, labels = [] }) {
    if (!apiKey) throw new Error('LinearClient requires an apiKey');
    this.apiKey = apiKey;
    this.apiUrl = apiUrl || 'https://api.linear.app/graphql';
    this.teamKey = teamKey;
    this.teamId = teamId;
    this.labelNames = labels;
  }

  async query(query, variables = {}) {
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey.startsWith('lin_api_') ? this.apiKey : `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`Linear returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok || body.errors?.length) {
      const msg = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Linear API error: ${msg}`);
    }
    return body.data;
  }

  async viewer() {
    const data = await this.query('{ viewer { id name email } }');
    return data.viewer;
  }

  async listTeams() {
    const data = await this.query('{ teams { nodes { id key name } } }');
    return data.teams.nodes;
  }

  async resolveTeam() {
    if (this.#cache.team) return this.#cache.team;
    const teams = await this.listTeams();
    let team;
    if (this.teamId) team = teams.find((t) => t.id === this.teamId);
    else if (this.teamKey) team = teams.find((t) => t.key.toLowerCase() === this.teamKey.toLowerCase());
    else if (teams.length === 1) team = teams[0];
    if (!team) {
      throw new Error(`Could not resolve Linear team (have: ${teams.map((t) => t.key).join(', ') || 'none'}). Set LINEAR_TEAM_KEY.`);
    }
    this.#cache.team = team;
    return team;
  }

  async resolveLabelIds() {
    if (this.#cache.labels) return this.#cache.labels;
    if (!this.labelNames.length) return (this.#cache.labels = []);
    const team = await this.resolveTeam();
    // Workspace labels plus team labels are both visible via issueLabels.
    const data = await this.query(
      `query($teamId: ID) { issueLabels(filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }, first: 250) { nodes { id name } } }`,
      { teamId: team.id },
    );
    const byName = new Map(data.issueLabels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
    const ids = [];
    for (const name of this.labelNames) {
      const id = byName.get(name.toLowerCase());
      if (id) ids.push(id);
      else console.warn(`[requestor] Linear label "${name}" not found; skipping`);
    }
    this.#cache.labels = ids;
    return ids;
  }

  /** @returns {Promise<{id:string, identifier:string, url:string}>} */
  async createIssue({ title, description, priority }) {
    const team = await this.resolveTeam();
    const labelIds = await this.resolveLabelIds();
    const input = { teamId: team.id, title: title.slice(0, 255), description };
    if (priority != null) input.priority = priority;
    if (labelIds.length) input.labelIds = labelIds;
    const data = await this.query(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      { input },
    );
    if (!data.issueCreate?.success) throw new Error('Linear issueCreate returned success=false');
    return data.issueCreate.issue;
  }

  async createComment(issueId, body) {
    const data = await this.query(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
      { input: { issueId, body } },
    );
    if (!data.commentCreate?.success) throw new Error('Linear commentCreate returned success=false');
    return data.commentCreate.comment;
  }

  /** e.g. updateIssue(id, { delegateId }) to hand the issue to an installed agent. */
  async updateIssue(id, input) {
    const data = await this.query(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }`,
      { id, input },
    );
    if (!data.issueUpdate?.success) throw new Error('Linear issueUpdate returned success=false');
    return data.issueUpdate.issue;
  }
}
