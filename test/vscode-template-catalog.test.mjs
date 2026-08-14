/**
 * The Configuration view shows what a template *is*, not just where it lives.
 *
 * A list of eleven filenames cannot tell a reader which template the specification phase renders, or
 * whether deleting one breaks four work types. The catalog knows both, so the tree shows the name it
 * was given and what references it.
 *
 * Driven through the real tree builder rather than asserted about its source, because "the field is
 * read" and "the row says the right thing" are different claims.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const treeModule = pathToFileURL(path.join(packageRoot, 'apps/vscode/src/views/tree-model.ts')).href;

function rows(templates) {
  const source = `
    import { buildConfigurationTree } from ${JSON.stringify(treeModule)};
    const nodes = buildConfigurationTree({ templates: ${JSON.stringify(templates)} });
    // The tree is nested under a single 'configuration' root, so the group is found by walking it.
    const find = (list) => {
      for (const node of list ?? []) {
        if (node.id === 'config:templates') return node;
        const nested = find(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const group = find(nodes);
    process.stdout.write(JSON.stringify((group?.children ?? []).map((child) => ({
      label: child.label, description: child.description, tooltip: child.tooltip
    }))));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}




