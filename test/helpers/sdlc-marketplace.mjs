/**
 * The sample marketplace (test/fixtures/sdlc-marketplace) copied into a folder for a test, and, when asked, with its
 * seeded bad item laid over it (test/fixtures/sdlc-marketplace-seeded) [OMK §11, REQ-080]: one more skill whose
 * lifecycle-state disagrees with its lifecycle.yml, whose record jumps from proposed to ga and is left without code
 * owners, whose owner names an issues address that is not https, and whose SKILL.md holds a hidden character. The
 * character is written here, so no file in the repository holds one.
 */
import { appendFile, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const SAMPLE_MARKETPLACE = path.join(FIXTURES, 'sdlc-marketplace');
export const SEEDED_MARKETPLACE = path.join(FIXTURES, 'sdlc-marketplace-seeded');
/** The name of the seeded bad item. */
export const SEEDED_ITEM = 'legacy-smoke-checks';

export async function copySampleMarketplace(target, { seeded = false } = {}) {
  await cp(SAMPLE_MARKETPLACE, target, { recursive: true });
  if (!seeded) return target;
  await cp(path.join(SEEDED_MARKETPLACE, 'skills'), path.join(target, 'skills'), { recursive: true });
  await appendFile(path.join(target, 'apm.yml'), `\n${await readFile(path.join(SEEDED_MARKETPLACE, 'package.yml'), 'utf8')}`);
  await appendFile(path.join(target, '.github', 'CODEOWNERS'), await readFile(path.join(SEEDED_MARKETPLACE, 'CODEOWNERS.append'), 'utf8'));
  const skill = path.join(target, 'skills', SEEDED_ITEM, 'SKILL.md');
  await writeFile(skill, (await readFile(skill, 'utf8')).replace('{{U+202E}}', '‮'));
  return target;
}
