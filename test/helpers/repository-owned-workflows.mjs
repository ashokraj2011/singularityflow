import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { renderPreservingFormatting } from '../../src/yaml-formatting.mjs';

/** Editing fixtures exercise repository-owned profiles, not protected framework seeds. */
export async function repositoryOwnedWorkflows(root) {
  for (const [file, catalog] of [['workflow.yml', 'workTypes'], ['portfolio.yml', 'initiativeProfiles']]) {
    const target = path.join(root, 'singularity', file);
    const original = await readFile(target, 'utf8');
    const document = YAML.parseDocument(original);
    const profiles = document.toJS()[catalog] ?? {};
    for (const [id, value] of Object.entries(profiles)) {
      document.deleteIn([catalog, id]);
      document.setIn([catalog, `repo-${id}`], document.createNode(value));
    }
    await writeFile(target, renderPreservingFormatting(original, document));
  }
}

/**
 * Workflow builds in these fixtures plan the code step in Requirements, the step just before it, so
 * the repository's Requirements template carries the planned-claims table: `workflow check` judges
 * templates, and a plan step whose template has no table stops every Story at that step.
 */
export async function requirementsTemplatePlansCode(root) {
  const file = path.join(root, 'singularity', 'templates', 'feature', 'requirements.md');
  await writeFile(file, `${await readFile(file, 'utf8')}\n## Planned implementation evidence\n\n`
    + '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |\n|---|---|---|---|---|\n'
    + '| `{{work.id}}:REQ-001` | TODO: `src/example.js` | TODO: `test/example.test.js` | new | TODO |\n');
}
