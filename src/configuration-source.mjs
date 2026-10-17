/** A secured request-local source observation, never a validated execution definition. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { configurationReadRoot, configurationReadAuthority } from './configuration-read-scope.mjs';
import { scopedRead } from './read-scope.mjs';
import { parseYamlText } from './yaml-parse-cache.mjs';
import { secureRepositoryPath } from './util.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';

export function configurationSourceBinding(root, source) {
  return Object.freeze({ sha256: createHash('sha256').update(source.workflowText).digest('hex'),
    commit: configurationReadAuthority(root)?.commit ?? null });
}

export function readConfigurationSource(root) {
  const definitionRoot = configurationReadRoot(root);
  return scopedRead(`config.source:${root}:${definitionRoot}`, async () => {
    const workflow = await measureCommandSpan('configuration.source-path', () => secureRepositoryPath(root,
      'singularity/workflow.yml', { label: 'Workflow configuration', type: 'file' }));
    if (!workflow.exists) return { workflow };
    incrementCommandCounter('configuration.source-read');
    const workflowText = await measureCommandSpan('configuration.source-io', () => readFile(workflow.absolute, 'utf8'));
    incrementCommandCounter('configuration.yaml-parse');
    try {
      const parsed = await measureCommandSpan('configuration.source-parse', () => parseYamlText(workflowText));
      return { workflow, workflowText, parsed };
    } catch (error) { return { workflow, workflowText, error }; }
  });
}
