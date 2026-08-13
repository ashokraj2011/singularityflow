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

test('a catalogued template is listed by its name, and says what uses it', () => {
  const [row] = rows([{
    path: 'singularity/templates/common/intake.md', name: 'common/intake.md', scope: 'repository',
    catalogId: 'intake-standard', catalogLabel: 'Standard intake', catalogKind: 'intake',
    usedBy: ['phase intake', 'workflow feature/intake']
  }]);
  assert.equal(row.label, 'Standard intake', 'the row still shows a filename instead of the template name');
  assert.equal(row.description, 'used by 2');
  assert.match(row.tooltip, /template:intake-standard · intake/, 'the tooltip does not name the reference to write');
  assert.match(row.tooltip, /Used by: phase intake, workflow feature\/intake/);
  assert.match(row.tooltip, /singularity\/templates\/common\/intake\.md/, 'the tooltip lost the path');
});

test('a template nobody references says so, which is the question a reader has', () => {
  const [row] = rows([{
    path: 'singularity/templates/common/orphan.md', name: 'common/orphan.md', scope: 'repository', usedBy: []
  }]);
  assert.equal(row.label, 'common/orphan.md', 'an uncatalogued template invented a name');
  assert.equal(row.description, 'unused');
});

test('a repository without a catalog looks exactly as it did', () => {
  // `usedBy` absent means the engine did not compute it — an older CLI against a newer extension.
  // That must fall back to the previous behaviour rather than claiming the template is unused.
  const [row] = rows([{
    path: 'singularity/templates/common/intake.md', name: 'common/intake.md', scope: 'repository'
  }]);
  assert.equal(row.label, 'common/intake.md');
  assert.equal(row.description, 'repository', 'a template with unknown usage was reported as unused');
});

test('a packaged template still says packaged, because that outranks usage', () => {
  // Whether an edit survives an upgrade matters more than how many phases reference it.
  const [row] = rows([{
    path: 'templates/common/intake.md', name: 'common/intake.md', scope: 'packaged',
    packagePath: 'templates/common/intake.md', usedBy: ['phase intake']
  }]);
  assert.equal(row.description, 'packaged');
});
