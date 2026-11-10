/**
 * Test commands the activated configuration now gives a Story's step that its pinned policy lacks:
 * what `story test-policy amend` would adopt. Recovery reads this on every turn, so it stays apart
 * from test-setup-proposal.mjs, whose saving route reaches the whole CLI.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { WORKFLOW_PATH } from './config.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { canonicalJson } from './records.mjs';
import { hasOwnTestCommand, repositoryTestCommands, selectedRepositoryTests } from './external-command-policy.mjs';

/** Empty when there are none or the authority cannot be read. */
export async function activatedTestCommandsFor(root, workflow, phaseId) {
  try {
    return await withApprovedConfigurationRead(root, async () => {
      const raw = YAML.parse(await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8')) ?? {};
      const step = raw.phases?.[phaseId] ?? {};
      const override = raw.workTypes?.[workflow.workItem?.workType]?.phaseOverrides?.[phaseId] ?? {};
      const own = override.qualityCommands ?? step.qualityCommands ?? [];
      // A step without test commands of its own gets the repository's it chose, as resolution gives them [RTC:REQ-003].
      const commands = hasOwnTestCommand({ qualityCommands: own }) ? own : [...own, ...selectedRepositoryTests({
        testLevels: override.testLevels ?? step.testLevels, testIds: override.testIds ?? step.testIds
      }, repositoryTestCommands(raw.tests))];
      const pinned = (workflow.resolution?.phases?.find((entry) => entry.id === phaseId)?.qualityCommands ?? []).map(canonicalJson);
      return commands.filter((entry) => entry?.kind === 'test' && !pinned.includes(canonicalJson(entry)));
    }, { preferAuthority: true });
  } catch { return []; }
}
