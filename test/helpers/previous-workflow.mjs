import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * The workflow.yml SFlow shipped before step intents (version 2; test/fixtures/workflow-v2-before-step-intents.yml),
 * for fixtures that stand for a repository an older release seeded. Its nodes are registered packaged revisions, so
 * an upgrade treats them as SFlow's own. `agentPromptsRoot` is the agents home the repository's own file records.
 */
export function previousShippedWorkflow({ agentPromptsRoot = undefined } = {}) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'workflow-v2-before-step-intents.yml');
  const value = YAML.parse(readFileSync(file, 'utf8'));
  return agentPromptsRoot === undefined ? value : { version: value.version, agentPromptsRoot, ...value };
}
