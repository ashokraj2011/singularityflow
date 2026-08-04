import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterpriseVisualFixture, VISUAL_REVIEW_CASES } from '../apps/vscode/src/views/visual-fixture.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps', 'vscode', 'test', 'fixtures', 'visual');
await mkdir(output, { recursive: true });
for (const review of VISUAL_REVIEW_CASES) {
  const name = `${review.theme}-${review.width}.html`;
  await writeFile(path.join(output, name), enterpriseVisualFixture(review), 'utf8');
}
process.stdout.write(`Wrote ${VISUAL_REVIEW_CASES.length} offline visual fixtures to ${output}\n`);
