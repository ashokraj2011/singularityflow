/**
 * `visual status`, `visual compare` and `visual record`.
 *
 *   singularity-flow visual status [--json]
 *   singularity-flow visual compare --expected RECORD-OR-PATH --actual RECORD-OR-PATH [--profile ID] [--json]
 *   singularity-flow visual record --phase VISUAL-STEP --profile-id ID --screen-id ID --state-id ID --file PNG
 *     --source simulator|emulator|device --device NAME [--os-version VERSION] [--note TEXT] [--json]
 *
 * `record` keeps a simulator, emulator or device screenshot as a native capture (see
 * src/visual-native-capture.mjs); it never names an MCP server or tool.
 */
import { repoRoot } from '../git.mjs';
import { loadSession } from '../session.mjs';
import { loadConfig } from '../state-stores.mjs';
import { loadStoryAggregate } from '../story-aggregate-read.mjs';
import { workDir } from '../story-paths.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { compareVisualArtifacts, listVisualComparisons } from '../visual-compare.mjs';
import { evaluateVisualCoverage } from '../visual-coverage.mjs';

async function visualRecordCommand(root, config, workflow, options) {
  const session = await loadSession(root);
  if (!session || session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Resume ${workflow.workItem.id} before recording a native capture.`);
  const { recordNativeVisualCapture } = await import('../visual-native-capture.mjs');
  const result = await recordNativeVisualCapture(root, workflow, {
    phase: optionString(options, 'phase'), profileId: optionString(options, 'profile-id'),
    screenId: optionString(options, 'screen-id'), stateId: optionString(options, 'state-id'),
    file: optionString(options, 'file'), source: optionString(options, 'source'), device: optionString(options, 'device'),
    osVersion: optionString(options, 'os-version') ?? null, note: optionString(options, 'note') ?? null,
    actor: session.actor ?? null, agent: session.agent ?? null, itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  const { record } = result;
  console.log(`Recorded native capture ${record.id} for ${record.profileId}: ${record.dimensions.width}×${record.dimensions.height} from ${record.source.kind} ${record.source.device}${record.source.osVersion ? ` (${record.source.osVersion})` : ''}.`);
  console.log(`Record: ${result.file}. Image: ${result.image}. It will be committed by the next normal lifecycle publication.`);
}

export async function visualCommand(positionals, options) {
  const root = repoRoot(), config = await loadConfig(root), workflow = await loadStoryAggregate(root, config);
  const action = positionals[1] ?? 'status';
  if (action === 'record') return visualRecordCommand(root, config, workflow, options);
  if (action === 'status') {
    const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    const comparisons = await listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    const result = { coverage, comparisons };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Visual coverage: ${coverage.status} (${coverage.covered.length}/${coverage.profiles.length} profiles)`);
    for (const entry of coverage.covered.filter((item) => item.method === 'native-capture')) {
      console.log(`Native capture: ${entry.profileId} ${entry.recordId} from ${entry.source?.kind} ${entry.source?.device}`);
    }
    for (const entry of coverage.notApplicable ?? []) {
      console.log(`Not applicable: ${entry.profileId} (${entry.decisionId}, decided by ${entry.actor} through ${entry.authorityGroup}): ${entry.reason}`);
    }
    coverage.warnings.forEach((entry) => console.warn(`Warning: ${entry}`));
    coverage.errors.forEach((entry) => console.error(`Error: ${entry}`));
    for (const comparison of comparisons) console.log(`${comparison.id}\t${comparison.status}\t${comparison.differingPixels} differing pixels`);
    return;
  }
  if (action === 'compare') {
    const result = await compareVisualArtifacts(root, workflow, {
      expected: optionString(options, 'expected'), actual: optionString(options, 'actual'),
      profileId: optionString(options, 'profile'), itemDirectory: workDir(root, config, workflow.workItem.id)
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Visual comparison ${result.id}: ${result.status}; ${result.differingPixels} pixels (${(result.differingPixelRatio * 100).toFixed(3)}%).`);
    console.log(`Summary: ${result.path}${result.diffImage ? `\nDiff: ${result.diffImage.path}` : ''}`);
    if (result.status === 'fail') throw new SingularityFlowError('Visual comparison exceeds enforced thresholds.', { code: 'VISUAL_COMPARISON_FAILED' });
    return;
  }
  throw new SingularityFlowError(`Unknown visual action '${action}'.`);
}
