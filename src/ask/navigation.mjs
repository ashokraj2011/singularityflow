/** Installed navigation metadata. Surface adapters map these IDs to their own bindings. */
export const ASK_DESTINATIONS = Object.freeze([
  { id: 'home', label: 'My Work', detail: 'Current work, progress and next steps', topic: 'developer-home', aliases: ['overview', 'home', 'current work'] },
  { id: 'specs', label: 'Spec Studio', detail: 'Write and find specifications', topic: 'specification-quality', aliases: ['specification', 'specifications', 'write a specification', 'requirements', 'spec studio'] },
  { id: 'stories', label: 'Stories', detail: 'Find and inspect a Story', topic: 'starting-work', aliases: ['story list', 'find stories', 'story history'] },
  { id: 'workflows', label: 'Workflow Studio', detail: 'Browse and design workflows', topic: 'workflow-authoring', aliases: ['workflows', 'workflow designer', 'workflow rules'] },
  { id: 'agents', label: 'Agents', detail: 'Find configured agents', topic: 'agents-and-routing', aliases: ['agent', 'agent catalog'] },
  { id: 'skills', label: 'Skills', detail: 'Browse installed workflow skills', topic: 'copilot-and-surfaces', aliases: ['skill catalog', 'copilot skills'] },
  { id: 'instructions', label: 'Instructions', detail: 'Browse workflow instructions', topic: 'workflow-authoring', aliases: ['instructions library', 'prompt instructions'] },
  { id: 'code', label: 'Code Explainer', detail: 'Explore code and changes', topic: 'code-explanation', aliases: ['explain code', 'code map', 'review changes'] },
  { id: 'run', label: 'Run & Test', detail: 'Find application and test commands', topic: 'run-and-test', aliases: ['run tests', 'start app', 'workspace run test', 'run application'] },
  { id: 'decisions', label: 'Decisions', detail: 'See decisions and reviews', topic: 'workflow-decisions', aliases: ['reviews', 'approvals', 'decision list', 'review queue'] },
  { id: 'help', label: 'Help Center', detail: 'Read SFlow product guidance', topic: 'help-and-docs', aliases: ['documentation', 'manual', 'how to', 'help'] },
  { id: 'workspaces', label: 'Workspaces', detail: 'Find workspace and repository settings', topic: 'workspaces-and-sessions', aliases: ['workspace list', 'manage workspace'] },
  { id: 'configuration', label: 'Configuration', detail: 'Inspect workspace configuration', topic: 'configuration', aliases: ['workspace configuration', 'repository settings'] },
  { id: 'analytics', label: 'Story Analytics', detail: 'See Story progress and workflow results', topic: 'telemetry-and-cost', aliases: ['story analytics', 'story dashboard'] },
  { id: 'activity', label: 'Activity & logs', detail: 'Inspect local activity and diagnostic logs', topic: 'activity-and-prompt-audit', aliases: ['activity log', 'workspace logs', 'operation history'] },
  { id: 'about', label: 'About', detail: 'See SFlow version and build information', topic: 'installation-and-upgrades', aliases: ['version', 'build date', 'installation version'] }
].map(entry => Object.freeze({ ...entry, aliases: Object.freeze(entry.aliases) })));

export const ASK_HINT = 'Find a screen, check work, open a specification, or compare revisions';

const normalize = text => text.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
const stopWords = new Set(['a', 'an', 'and', 'can', 'do', 'find', 'for', 'i', 'in', 'is', 'me', 'open',
  'sflow', 'show', 'the', 'to', 'want', 'where', 'with']);

function nearby(left, right) {
  if (left.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const differences = [...left].map((letter, index) => letter === right[index] ? -1 : index).filter(index => index >= 0);
    return differences.length === 1 || differences.length === 2 && differences[1] === differences[0] + 1
      && left[differences[0]] === right[differences[1]] && left[differences[1]] === right[differences[0]];
  }
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left];
  const at = [...shorter].findIndex((letter, index) => letter !== longer[index]);
  return at === -1 || longer.slice(at + 1) === shorter.slice(at);
}

const searchable = ASK_DESTINATIONS.map(entry => {
  const ids = [entry.id, entry.label, ...entry.aliases].map(normalize);
  return { entry, ids, words: new Set([...ids, normalize(entry.detail)].flatMap(value => value.split(' '))) };
});

/** Pure, bounded type-ahead. Reuse the same index in the browser, editor and CLI. */
export function askSuggestions(query, enabled = null) {
  if (typeof query !== 'string' || query.length > 2000) return [];
  const exact = normalize(query);
  const tokens = [...new Set(exact.split(' ').filter(word => word && !stopWords.has(word)))].slice(0, 12);
  if (!exact) return searchable.filter(({ entry }) => !enabled || enabled.has(entry.id)).slice(0, 4).map(({ entry }) => entry);
  return searchable.filter(({ entry }) => !enabled || enabled.has(entry.id))
    .map(({ entry, ids, words }) => {
      if (ids.includes(exact)) return { entry, score: 1000 };
      let score = ids.some(value => value.startsWith(exact)) ? 40 : 0;
      let matched = 0;
      for (const token of tokens) {
        if (words.has(token)) { score += 12; matched += 1; }
        else if ([...words].some(word => token.length > 1 && word.startsWith(token))) { score += 6; matched += 1; }
        else if ([...words].some(word => nearby(token, word))) { score += 3; matched += 1; }
      }
      return { entry, score: matched || score ? score + (matched === tokens.length ? 20 : 0) : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8).map(({ entry }) => entry);
}
