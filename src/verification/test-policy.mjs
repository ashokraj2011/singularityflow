/**
 * The Story test policy, sealed when the Story is created [E2G-019, E2G-020 intake side, D12, D13].
 *
 * One record, written with the Story and never rewritten: how much of the suite runs (the affected
 * modules, or every configured test with the Story test policy pilot), what happens to failures the
 * base already has (repaired in this Story, accepted as pre-existing through the pilot's reviewed
 * baseline, or resolved outside this Story before it may start), that a functional criterion is
 * verified by an automated test unless its contract says otherwise, the risk categories and the
 * longest risk acceptance, the failures no decision can waive, and the repository's test capability
 * at the base. A base whose failures must be resolved outside the Story refuses creation and names
 * them (D13); when no confirmed readiness probe has observed the base, it asks for one (D12).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { MAX_RISK_DAYS, RISK_CATEGORIES } from '../evidence/risk-decisions.mjs';
import { loadRepositoryReadinessReceipt, loadRepositoryTestBaseline } from '../initialization/runtime-readiness.mjs';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { resolveDeliveryQualityCommands } from '../delivery-evidence.mjs';
import { ASSURANCE } from '../evidence/vocabulary.mjs';
import { normalizeExternalCommand } from '../external-command-policy.mjs';
import { commandCovering } from './adapters.mjs';
import { capabilityLines, launcherPresent, repositoryTestCapability } from './capability.mjs';
import { effectiveContract } from './contracts.mjs';
import { profileCeiling, profileForCommand } from './profiles.mjs';

export const BASELINE_FAILURE_DISPOSITIONS = Object.freeze(['repair-in-story', 'accept-pre-existing', 'resolve-outside']);
export const TEST_POLICY_PATH = 'context/test-policy.json';
const NON_WAIVABLE = Object.freeze([
  'tampered-or-forged-evidence', 'unknown-candidate-or-test-identity', 'unauthorized-decision',
  'broken-evidence-authenticity', 'stale-evidence'
]);
const MAX_LISTED = 20;

async function assertBaseFailuresResolved(root, baseCommit) {
  const at = baseCommit ? { commit: baseCommit } : {};
  const failing = await loadRepositoryTestBaseline(root, { ...at, scope: 'dependency-test' })
    ?? await loadRepositoryTestBaseline(root, { ...at, scope: 'full' });
  if (failing) {
    const identities = [...new Set(failing.baseline.testObservations.flatMap((entry) =>
      (entry.failingCases ?? []).map((item) => item.fullName ?? item.name)).filter(Boolean))];
    const commands = (failing.baseline.commandResults ?? []).filter((entry) => entry.status !== 'pass').map((entry) => entry.id);
    const listed = identities.length
      ? identities.slice(0, MAX_LISTED).map((name) => `- ${name}`).join('\n') + (identities.length > MAX_LISTED ? `\n- …and ${identities.length - MAX_LISTED} more` : '')
      : `- ${commands.join(', ') || 'a readiness command'} failed without naming its tests`;
    throw new SingularityFlowError(
      `This Story resolves the base's failing tests outside itself, and the base still fails:\n${listed}\nFix them on the base (as their own Bug or setup work), run the readiness probe again, then start. No Story was created.`,
      { code: 'TEST_BASELINE_FAILING', details: { failing: identities, commands, baselineSha256: failing.baseline.baselineSha256 } }
    );
  }
  const passing = await loadRepositoryReadinessReceipt(root, { ...at, scope: 'dependency-test' });
  if (passing?.receipt?.status !== 'pass') {
    throw new SingularityFlowError(
      'This Story resolves the base\'s failing tests outside itself, so its base must be observed first: run singularity-flow precheck --run --scope dependency-test, confirm its plan, then start again. No Story was created.',
      { code: 'TEST_BASELINE_UNKNOWN' }
    );
  }
}

/** The Story's sealed policy, verified against the digest its workflow recorded; null when it has none. */
export async function readSealedStoryTestPolicy(root, config, workflow) {
  if (!workflow?.testPolicy?.path) return null;
  try {
    const file = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, workflow.testPolicy.path);
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (`sha256:${recordSha256(record)}` !== workflow.testPolicy.sha256) return { record: null, error: 'the sealed test policy no longer matches the digest recorded at creation' };
    return { record, path: workflow.testPolicy.path, sha256: workflow.testPolicy.sha256 };
  } catch (error) {
    return { record: null, error: `the sealed test policy is unreadable: ${error.message}` };
  }
}

/** Build the sealed policy for a Story about to be created; refuses (D13) before anything is written. */
export async function sealStoryTestPolicy(root, {
  workId, baseCommit = null, phases = [], baselineFailures = null, trpChoices = null,
  executionMode = 'changed-and-affected', baselineChoice = 'reuse', baselinePending = false, testRuntime = {},
  env = process.env, platform = process.platform, arch = process.arch
} = {}) {
  const disposition = baselineFailures
    ?? (trpChoices?.baselineDisposition === 'accept-known-failures' ? 'accept-pre-existing' : 'repair-in-story');
  if (!BASELINE_FAILURE_DISPOSITIONS.includes(disposition)) {
    throw new SingularityFlowError(`--baseline-failures must be repair-in-story or resolve-outside; got ${disposition}.`, { code: 'TEST_POLICY_INVALID' });
  }
  if (disposition === 'accept-pre-existing' && trpChoices?.baselineDisposition !== 'accept-known-failures') {
    throw new SingularityFlowError('Accepting pre-existing failures goes through the Story test policy pilot: start with --test-baseline-disposition accept-known-failures and its reviewed terms.', { code: 'TEST_POLICY_INVALID' });
  }
  if (disposition === 'resolve-outside') await assertBaseFailuresResolved(root, baseCommit);
  const configuredCommands = phases.filter((phase) => phaseRequiresCodeDelivery(phase)).flatMap((phase) => phase.qualityCommands ?? []);
  const capability = await repositoryTestCapability(root, { configuredCommands, env, platform });
  const record = {
    schemaVersion: 1, kind: 'story-test-policy', workId, baseCommit, host: { platform, arch },
    executionScope: (trpChoices?.executionMode ?? executionMode) === 'all-configured' ? 'full' : 'affected',
    baselineChoice, baselineObservation: baselineChoice === 'defer' ? 'deferred-not-verified'
      : baselinePending ? 'pending-not-verified' : 'receipt-only',
    testRuntime,
    baselineFailures: disposition,
    witnessDefault: 'automated-test',
    riskCategories: [...RISK_CATEGORIES], maximumRiskDays: MAX_RISK_DAYS,
    nonWaivable: [...NON_WAIVABLE],
    capability
  };
  return { record, relativePath: TEST_POLICY_PATH, sha256: `sha256:${recordSha256(record)}`, lines: capabilityLines(capability) };
}

/**
 * Disclose missing test setup during planning without preventing authoring. Each
 * code step's planned test slots are resolved with the same function publication uses, so a module
 * with no supported runner, two build systems, or no command covering a planned test is named at
 * planning instead of first appearing at publication. A test slot that requires more assurance than its runner can
 * reach is refused too; a missing launcher is disclosed as a warning, since it can be installed.
 */
export async function assertPlannedTestsRunnable(root, workflow, { subject, codeSteps = [], claims = {}, contracts = new Map(), warn = console.warn } = {}) {
  const problems = [];
  const pending = [];
  for (const step of codeSteps) {
    const phase = workflow.phases?.[step];
    if (!phase) continue;
    const slots = Object.entries(claims)
      .filter(([, claim]) => !(claim.steps ?? []).length || claim.steps.includes(step))
      .flatMap(([id, claim]) => (effectiveContract(id, contracts, claim)?.slots ?? [])
        .filter((slot) => slot.method === 'test' && slot.role === 'primary')
        .flatMap((slot) => (slot.witness.path ? [slot.witness.path] : slot.witness.paths ?? []).map((testPath) => ({ id, slot, testPath }))));
    if (!slots.length) continue;
    let commands;
    try {
      commands = (await resolveDeliveryQualityCommands(root, {
        ...phase, deliveryEvidence: { ...(phase.deliveryEvidence ?? {}), sourcePaths: [], testPaths: [...new Set(slots.map((entry) => entry.testPath))] }
      }, { executionMode: workflow.resolution?.testExecutionMode })).flatMap((command, index) => {
        try { return [normalizeExternalCommand(command, index)]; } catch { return []; }
      }).filter((command) => command.kind === 'test');
    } catch (error) {
      const setupMissing = ['CODE_TEST_RESULT_REQUIRED', 'RUST_TEST_ADAPTER_REQUIRED',
        'GRADLE_TEST_TARGET_REQUIRED', 'TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS'].includes(error?.code);
      (setupMissing ? pending : problems).push(`${step}: ${error.message}`);
      continue;
    }
    const reported = new Set();
    for (const { id, slot, testPath } of slots) {
      const command = commandCovering(commands, testPath);
      if (!command) { pending.push(`${id}: no test command of ${step} can run ${testPath}`); continue; }
      const ceiling = profileCeiling(profileForCommand(command));
      if (slot.requiredAssurance && ASSURANCE.indexOf(slot.requiredAssurance) > ASSURANCE.indexOf(ceiling)) {
        problems.push(`${id}: ${testPath} runs under ${command.id}, which reaches ${ceiling}, but its contract requires ${slot.requiredAssurance}`);
      }
      const launcher = String(command.argv?.[0] ?? '');
      if (!reported.has(command.id) && !(await launcherPresent(launcher, { cwd: path.join(root, command.workingDirectory ?? '.') }))) {
        reported.add(command.id);
        warn(`Warning: test command ${command.id} needs '${launcher}', which is not installed here; install it before publishing ${step}.`);
      }
    }
  }
  if (pending.length) warn(`Test configuration pending:\n- ${pending.join('\n- ')}\n`
    + 'Continue authoring; configure the required test command before code publication. '
    + 'Use Configuration Center, then story test-policy amend for an active pinned code phase. No tests are marked passed.');
  if (problems.length) {
    throw new SingularityFlowError(
      `${subject} because some planned tests cannot run in this repository:\n- ${problems.join('\n- ')}\n`
      + 'Before any code is written: configure a supported test command for the module, plan the test in a module whose runner is supported, or verify the criterion another way in the plan\'s Verification contracts.',
      { code: 'TEST_CAPABILITY_UNSUPPORTED', details: { problems } }
    );
  }
  return { status: pending.length ? 'configuration-pending' : 'ready', pending };
}
