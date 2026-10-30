/**
 * One process reading the intake catalog projection, for the cross-process tests in
 * test/sda-read-index.test.mjs. Its verifier counts each call in a file, so a test can tell how
 * many authority observations several processes made. Not a test file: spawning it runs nothing else.
 *
 * Usage: node sda-index-reader.mjs <root> <observed-file> <counter-file> <delay-ms> [fail-code]
 */
import { appendFile } from 'node:fs/promises';
import { cachedStoryIntakeCatalog, repositoryCheckStatus } from '../../src/repository-check-cache.mjs';
import { SingularityFlowError } from '../../src/util.mjs';

const [root, observed, counter, delay, failCode] = process.argv.slice(2);
const value = await cachedStoryIntakeCatalog(root, { identity: { reader: 'sda' }, files: [observed] }, async () => {
  await appendFile(counter, `${process.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(delay)));
  if (failCode) throw new SingularityFlowError('The remote could not be reached.', { code: failCode });
  return { choicesComplete: true, intake: { storyWorkflows: [] }, unreachable: [], observedBy: process.pid };
});
process.stdout.write(JSON.stringify({ value, status: repositoryCheckStatus(root) }));
