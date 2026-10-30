import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import { COMMAND_LOADERS } from '../src/command-loaders.mjs';
import { bundledCliUrl, bundledCopilotHookUrl } from '../src/bundled-cli.mjs';
import { buildCliBundle } from '../scripts/build-cli-bundle.mjs';
import { readPerformanceReport } from '../src/performance-trace-store.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'singularity-flow.mjs');

test('every command module has a literal loader, so the bundle carries it', () => {
  const paths = [...new Set(COMMAND_REGISTRY.map((definition) => definition.modulePath))].sort();
  assert.deepEqual(Object.keys(COMMAND_LOADERS).sort(), paths);
  for (const [modulePath, loader] of Object.entries(COMMAND_LOADERS)) {
    assert.equal(loader.toString(), `() => import('${modulePath}')`, modulePath);
  }
});

test('the bundle runs only for the stamped build it was made for, unless it is forced or switched off', async (t) => {
  const pkg = await mkdtemp(path.join(os.tmpdir(), 'sflow-bundle-select-'));
  t.after(() => rm(pkg, { recursive: true, force: true }));
  await mkdir(path.join(pkg, 'src'));
  await mkdir(path.join(pkg, 'bundle'));
  const buildInfo = 'export const BUILD_INFO = { commit: "abc" };\n';
  await writeFile(path.join(pkg, 'src', 'build-info.mjs'), buildInfo);
  const digest = `sha256:${createHash('sha256').update(buildInfo).digest('hex')}`;
  const manifest = (fields) => writeFile(path.join(pkg, 'bundle', 'manifest.json'),
    JSON.stringify({ format: 1, entries: ['cli.mjs'], stamped: true, buildInfoSha256: digest, ...fields }));
  const expected = pathToFileURL(path.join(pkg, 'bundle', 'cli.mjs')).href;

  assert.equal(bundledCliUrl(pkg, {}), null, 'no manifest: the sources');
  await manifest({});
  assert.equal(bundledCliUrl(pkg, {}), expected, 'the stamped build it was made for');
  assert.equal(bundledCopilotHookUrl(pkg, {}), null, 'older manifests use source hook execution');
  await manifest({ entries: ['cli.mjs', 'copilot-hook-runtime.mjs'] });
  assert.equal(bundledCopilotHookUrl(pkg, {}), pathToFileURL(path.join(pkg, 'bundle', 'copilot-hook-runtime.mjs')).href);
  assert.equal(bundledCopilotHookUrl(pkg, { SINGULARITY_FLOW_BUNDLE: 'off' }), null);
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE: 'off' }), null);
  await manifest({ stamped: false });
  assert.equal(bundledCliUrl(pkg, {}), null, 'a development build is never used on its own');
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), expected, 'unless forced');
  await manifest({ entries: ['cli.mjs', 'copilot-hook-runtime.mjs'] });
  assert.ok(bundledCopilotHookUrl(pkg, {}), 'a matching hook bundle exists before the build moves');
  await writeFile(path.join(pkg, 'src', 'build-info.mjs'), 'export const BUILD_INFO = { commit: null };\n');
  assert.equal(bundledCliUrl(pkg, {}), null, 'restored or edited build information: the sources');
  assert.equal(bundledCopilotHookUrl(pkg, {}), null, 'hook bundles must match the live build stamp too');
  await manifest({ format: 3 });
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null, 'an unknown format is never run');
  await writeFile(path.join(pkg, 'bundle/cli.mjs'), 'export const main = () => {};');
  await writeFile(path.join(pkg, 'bundle/cold-core.mjs'), 'export const identity = {};');
  const coarse = { format: 2, layout: 'coarse-esm', outputs: [{ file: 'cli.mjs' }, { file: 'cold-core.mjs' }] };
  await manifest(coarse);
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), expected);
  await manifest({ ...coarse, outputs: [{ file: '../outside.mjs' }] });
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null);
  await manifest(coarse);
  await rm(path.join(pkg, 'bundle/cold-core.mjs'));
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null, 'partial deployment uses sources');
});

test('the bundled CLI answers exactly like the sources while opening a handful of files', slowLane({ timeout: 300_000 }), async (t) => {
  const outdir = path.join(root, `.bundle-test-${process.pid}`);
  t.after(() => rm(outdir, { recursive: true, force: true }));
  const { manifest } = await buildCliBundle({ outdir });
  assert.equal(manifest.format, 2);
  assert.ok(manifest.outputs.length <= 21, 'bounded coarse chunks, including one narrow publication writer');
  const closure = file => {
    const found = new Set();
    const visit = name => { if (found.has(name)) return; found.add(name);
      for (const dependency of manifest.outputs.find(item => item.file === name)?.imports ?? []) visit(dependency); };
    visit(file);
    return manifest.outputs.filter(item => found.has(item.file));
  };
  const cliStartup = closure('cli.mjs').reduce((sum, item) => sum + item.bytes, 0);
  const hookStartup = closure('copilot-hook-runtime.mjs').reduce((sum, item) => sum + item.bytes, 0);
  assert.deepEqual(manifest.entries, ['cli.mjs', 'copilot-hook-runtime.mjs', 'history-index-worker.mjs', 'configuration-read-worker.mjs', 'read-worker.mjs', 'configuration-proposal-sync-worker.mjs']);
  const hookOutput = manifest.outputs.find(output => output.file === 'copilot-hook-runtime.mjs');
  assert.ok(hookOutput.bytes <= 8 * 1024 * 1024, `hook bundle: ${hookOutput.bytes} bytes`);
  assert.ok(hookOutput.modules <= 650, `hook bundle: ${hookOutput.modules} modules`);
  assert.ok(cliStartup < 3 * 1024 * 1024, `CLI cold parse: ${cliStartup}`);
  assert.ok(hookStartup < 3 * 1024 * 1024, `hook cold parse: ${hookStartup}`);
  const catalogClosure = closure('cold-catalogs.mjs');
  const startupCode = await readFile(path.join(outdir, 'cold-core.mjs'), 'utf8');
  assert.match(startupCode, /validateSkillRequest/u, 'early argv validation must not import the catalog chunk');
  assert.match(startupCode, /validateInstructionRequest/u, 'instruction validation must remain in the startup chunk');
  for (const name of ['readCopilotMode', 'withCreationContext']) {
    assert.match(startupCode, new RegExp(`function ${name}\\b`, 'u'), `cli-entry's lazy ${name} must stay in the startup chunk`);
  }
  const statusClosure = closure('cold-status.mjs');
  const statusBytes = statusClosure.reduce((sum, item) => sum + item.bytes, 0);
  assert.ok(statusBytes < 1.5 * 1024 * 1024,
    `ordinary JSON status must not inherit catalog or review closures: ${statusBytes} bytes`);
  const statusCode = (await Promise.all(statusClosure.map(item => readFile(path.join(outdir, item.file), 'utf8')))).join('\n');
  assert.doesNotMatch(statusCode, /function (?:emitCommandResult|attachContinuation|workflowNextSteps)\b/u,
    'the root error lookup must not pull the output boundary or workflow planner into ordinary status');
  for (const name of ['cold-catalogs.mjs', 'cold-hook-context.mjs', 'cold-narrow-reads.mjs', 'cold-compatibility.mjs']) {
    assert.ok(!statusClosure.some(item => item.file === name), `status must not statically reach ${name}`);
  }
  const presentationClosure = closure('cold-worker-protocol.mjs');
  assert.ok(presentationClosure.reduce((sum, item) => sum + item.bytes, 0) < 2 * 1024 * 1024,
    'small output helpers must not shift policy loading into every agent response');
  for (const name of ['cold-catalogs.mjs', 'cold-hook-context.mjs', 'cold-narrow-reads.mjs', 'cold-compatibility.mjs']) {
    assert.ok(!presentationClosure.some(item => item.file === name), `output must not statically reach ${name}`);
  }
  // 4,460,000 (next 5,000 boundary; it was 4.25 MiB, 4,456,448): main 317d51b9 measures 4,456,138. The blocker
  // audit's dead-end and trap routes add cold-core +1,952, cold-narrow-reads +1,216 and cold-worker-protocol +62
  // for 4,459,368. No new file.
  // 4,465,000: main 16677122 measures 4,459,467. The edit guard turns back any file read longer than one
  // view (Copilot 1.0.100 shows about 8 KB) with its exact ranges: cold-hooks +2,263, cold-core +85 and
  // cold-worker-protocol -191 (the range builder moved beside the output folder) for 4,461,624. No new file.
  // 4,470,000: main 12aa30f4 measures 4,464,943. A refused route keeps its marked step, and the session
  // entry says when this build is older than main (its check is lazy): cold-core +209 and
  // cold-narrow-reads +99 for 4,465,251. No new file in this closure.
  // 4,475,000: main d01be67d measures 4,469,889; the route-closure fixes (a person's own step and raw commands handed to the person in agent-output.mjs, exact routes so no mutating command reaches a read-only skill in command-skills.mjs, person-only denials with their own terminal line and expired turns keeping only reads in copilot-mutation-guard.mjs, the decision list kept past the plan cap and live-terminal refusals in refusal-remediation.mjs, canonical routes kept in phase-resolution.mjs and collaboration.mjs) add 2,298 for 4,472,187. No new file.
  // 4,480,000: main 80f74694 measures 4,472,187; the batch 4 resets and authority fallback (one complete reset on
  // skill adoption and intent amendment, roll-forward refused over newer decisions, cancel by Git identity, a
  // decision's rounds reset with its step, authority from the nearest step with approvers in the new
  // approval-fallback.mjs, the inspection witness kept at submission, an unchanged code step revalidated after an
  // earlier return, return listed only where it runs) add 2,888 for 4,475,075. One new file.
  // 4,485,000: main ef81e85b measures 4,479,374; a person's own terminal decisions (live-terminal reviews in
  // command-skills.mjs and their refusal in copilot-mutation-guard.mjs), the empty-group route in
  // refusal-remediation.mjs and cancel while a decision waits add cold-core +1,770 and cold-hooks +601 for
  // 4,481,745. No new file.
  // 4,490,000: main f8cbcdc3 measures 4,481,745; batch 7's shapes, two-machine and wording fixes (replace-test and remove-test in plan-row-corrections.mjs, the approval hint for a clone that is behind in sequence.mjs, the cancelled-Story refusal in lifecycle-transitions.mjs, tests owed only where planned in delivery-evidence.mjs, --fetch for the current Story, the evaluator's wording) add 3,583 for 4,485,328. No new file.
  // 4,500,000: main 6f0e9741 measures 4,487,197; the approver refresh (a new accepted snapshot revision kind in workflow-snapshots.mjs, +13,280: its capture, replay and dialect, with its contracts loaded lazily; its review-safe commit in approval-check.mjs, +2,614; its registry, terminal-step, refusal and state entries) adds 12,258 (cold-narrow-reads and cold-core,
  // with its two record families in schema-migrations.mjs) for 4,499,455. No new file in the closure.
  // 4,505,000: main 8180c46e measures 4,499,455; the approver refresh's three result messages (registered at last: every refresh ended in COMMAND_RESULT_INVALID) and approve --confirm-evidence as the approver's own terminal step add cold-core +744 and cold-hooks +680 for 4,500,879. No new file.
  // 4,515,000: main 0c7ca31b measures 4,500,879; refusals that quote the cell or line an author wrote and say what belongs there, publish-time prepublish plans for the draft refusals, and step-entry sentences for the rules never described (draft-diagnostics, specifications, specification-scenarios, verification intent and contracts, conformance, preflight, specification quality, constitution, refusal-remediation, phase-authoring-contract), after agents looped on such refusals in the office, add 10,178 for 4,511,057. No new file.
  // 4,520,000: main 58b20746 measures 4,511,057; refusals that name their own way out (rewritten history, approver refresh, roll-forward, a publish in flight, set-aside reasons, witness exceptions), help as a read, routed corrections and counted unchanged rechecks in agent-output.mjs, and the set-aside preview as a read add 6,131 for 4,517,188. No new file.
  // 4,525,000: main e3cc278a measures 4,519,481; a clarification answer from the approver's own clone (its own
  // terminal step and refusal in command-skills.mjs and copilot-mutation-guard.mjs, its routes) and a rewritten
  // history's matching commits add 1,370 for 4,520,851 (cold-hooks, cold-core). No new file in this closure.
  // 4,535,000: SDA M1 measures 4,530,211 against 4,525,000. This chunk now carries every error's outcome class
  // (outcome-classes.mjs, util.mjs), the ledger payload digest (ledger.mjs; pages stay out, in
  // ledger-pages.mjs), push-operation matching (transport-intents.mjs), the source inspection facade and named
  // push leases.
  // 4,540,000: SDA M2 measures 4,537,465. Last-known Story lists and catalogs with their freshness
  // (repository-check-cache.mjs; the refresh lease and replay stay in the lazy projection-refresh.mjs),
  // canonical finding identities (delivery-evidence.mjs) and push intents bound to a repository ID.
  // 4,555,000: SDA M3 measures 4,552,616: the lease liveness proof (lease-liveness.mjs: machine identity, owner start time, the shared owner predicate) behind every subject lock and registry lease, deferred repositories and transactional drafts.
  const narrowReads = closure('cold-narrow-reads.mjs').reduce((sum, item) => sum + item.bytes, 0);
  // 4,560,000: SDA M4 measures 4,557,115: SDA M4's lifecycle authority adapter (sda/story-branch-authority.mjs, sda/lifecycle-authority-contract.mjs, sda/shared-state-contract.mjs), through which recovery and test-recovery reads observe the subject branch; the publication writer it wraps loads only on a transition.
  // 4,565,000: main 38b61ada9 measures 4,557,454; SDA B1 lease identity (lease-liveness.mjs: PID namespace, the hardware check on
  // a dead same-machine owner), B5's consistency readers and status's pending-publication check add 6,379 for 4,563,833.
  // 4,570,000: main 6a0d0a650 (SDA M6) measures 4,564,864; the approved-configuration read's copy is told from a checkout
  // (configuration-read-scope.mjs isConfigurationReadCopy), so a draft save asks it no Git, adding 234 for 4,565,098.
  // 4,580,000: main 6585b9b0b measures 4,565,098; locks only a person can end (sweep batch 1: each owner record's hardware
  // digest in lease-liveness.mjs, the lock's read and reviewed release in every refusal and its plan in subject-lock.mjs,
  // file-lease.mjs and refusal-remediation.mjs, the own-terminal refusals in copilot-mutation-guard.mjs, `lock` outside
  // the mutation lease in cli-entry.mjs) add 8,898 for 4,573,996. No new file.
  assert.ok(narrowReads < 4_580_000,
    `strict next-step reads must not inherit the broad phase-review closure (${narrowReads} bytes)`);
  const publicationClosure = closure('cold-publication.mjs');
  assert.ok(publicationClosure.length && publicationClosure.reduce((sum, item) => sum + item.bytes, 0) < 6 * 1024 * 1024,
    'first publication must use a bounded writer closure');
  for (const name of ['cold-compatibility.mjs', 'cold-phases.mjs', 'cold-hook-context.mjs', 'cold-intake.mjs', 'cold-models.mjs']) {
    assert.ok(!publicationClosure.some(item => item.file === name), `publication must not statically reach ${name}`);
  }
  const reviewCode = await readFile(path.join(outdir, 'cold-narrow-reads.mjs'), 'utf8');
  assert.match(reviewCode, /source-review-agent-context/u,
    'source review context must use the narrow reader slot, not the publication chunk');
  for (const name of ['cold-compatibility.mjs', 'cold-phases.mjs', 'cold-hook-context.mjs', 'cold-intake.mjs']) {
    assert.ok(!closure('cold-narrow-reads.mjs').some(item => item.file === name),
      `source review reads must not statically reach ${name}`);
  }
  // 7,348,470 bytes on 2026-10-23 after the enrollment, push-refusal and turn-gap fixes (7 MiB before).
  // 7,355,000 (next 5,000 boundary): 7,352,651 on 2026-10-24 after the missing-runner routes, the
  // Story-only test command decisions and Nx unit targets (7,349,935 on main 47c15469): the runner
  // refusal's routes, recovery's planned-runner check and adoption/request actions, the resolver's
  // Story-only commands and provenance, and the decision's narration line.
  // 7,380,000 (next 5,000 boundary): 7,375,185 after the 2026-10-24 round (main 4a72b80f: 7,352,651): cold-catalogs
  // +11,131 (INT's typed Git reads in git-access.mjs, kept with the lazily loaded planners), cold-worker-protocol
  // +4,918, cold-core +2,586, cold-hooks +1,915 (the guard's host-only and canonical-name rules), cold-narrow-reads
  // +1,825 and cold-hook-context +159.
  // 7,385,000 (next 5,000 boundary): 7,383,460 after a Story branch carries only its own workflow's configuration
  // closure (main 1ecccc54: 7,379,841): cold-catalogs +3,148, cold-narrow-reads +442 and cold-hook-context +29, from
  // the closure materialization and its re-derived check in configuration-branch.mjs and the shared pinned
  // initialization status in config.mjs. story-configuration-closure.mjs stays out of these reads.
  // 7,395,000 (next 5,000 boundary): 7,391,822 after SPEC-OAP M0 and M1, which crossed it unrun in the slow lane.
  // M0's approval defect fixes (merge 8b257b5c; 445e65b7 before it: 7,383,460): cold-core +1,372, cold-narrow-reads
  // +773 and cold-hook-context +731. M1's one approval check (merge a1b1709c; 7,386,336 before it): cold-hook-context
  // +4,097 and cold-narrow-reads +1,389. The explain state answer adds nothing here: its modules stay in the lazily
  // loaded gateway.
  // 7,400,000 (next 5,000 boundary): 7,398,878 after SPEC-OAP M2 (main bdd4049e: 7,394,862): cold-hook-context
  // +3,433 and cold-core +583, from the REVIEW_EFFECTS registry in state.mjs and the approval stage that holds
  // an undecided intent amendment.
  // 7,405,000 (next 5,000 boundary): main 951e4122 measures 7,398,878. The Story index adds 4,750 for 7,403,628:
  // cold-core +4,756 (1,303,081 to 1,307,837) and the other chunks -6. In cold-core: cli-entry.mjs +1,423 (Work ID
  // routing, its command list and the index refresh after a mutation), help-pages.mjs +772 and help-text.mjs +260
  // (workspace stories), refusal-remediation.mjs +753 (the storyCheckout projection), util.mjs +466 (samePlatformPath,
  // moved from story-worktree.mjs so the index stays light), cli-json-output.mjs +447 (storyRoute),
  // schema-migrations.mjs +285 (the story-index family), workspace.mjs +203 and command-registry.mjs +22.
  // story-index.mjs and story-routing.mjs live in cold-light, outside these reads.
  // 7,410,000 (next 5,000 boundary): 7,408,083 after SPEC-OAP M3 (main 9b13d66f: 7,404,171): cold-core +1,243,
  // cold-narrow-reads +1,166, cold-hook-context +1,142, cold-worker-protocol +372, cold-hooks +7 and cold-catalogs
  // -18. By module: submission-readiness.mjs +857 (the pending list summary and its lines), commands/nextsteps.mjs
  // +552 and nextsteps.mjs +197 (the list read and its line), narration/messages.mjs +492 (sync's saved-push
  // lines), transport-intents.mjs +296 (the person's retry), command-skills.mjs +117, util.mjs +105
  // (isTransportIntentId), command-loaders.mjs +92, cli-entry.mjs +51, command-registry.mjs +27 and
  // status-details.mjs +15; the other 1,122 are bindings between chunks. decision-list.mjs and
  // decision-list-reads.mjs load lazily, outside these reads.
  // 7,415,000 (next 5,000 boundary): main 9be3b855 measures 7,413,078 (a599bf6c: 7,408,083), first over at 4c06a383
  // (7,411,161). Shipped guard and read work; no module changed family. cold-hooks +4,098 from copilot-mutation-guard.mjs
  // (790ebe42 +968, bfbfa964 +244, 4c06a383 +1,680) and copilot-repository-boundary.mjs (9be3b855 +1,206),
  // cold-narrow-reads +348 and cold-status +100 (1bb260f9, story-state-read.mjs readProgress for the gateway),
  // cold-core +263 (9be3b855, copilot-mode.mjs) and cold-hook-context +186 (790ebe42, commands/phase-show.mjs).
  // The pending list's move into cold-phases measures 7,412,957 (-121 in bindings).
  // 7,420,000 (next 5,000 boundary): batch B adds 3,532 for 7,416,489: cold-worker-protocol +2,498, cold-core +975 and
  // cold-hooks +59, from agent-output.mjs +4,029 (a result that cannot be written is shown, never refused; cleanup
  // removes whole results past a day), code-page-safe-json.mjs +980, cli-json-output.mjs +566, cli-failure.mjs +377
  // and copilot-repository-boundary.mjs +144.
  // 7,425,000 (next 5,000 boundary): SPEC-TCE (test commands and evidence) adds 4,364 to main 3bd739a8's 7,418,002
  // for 7,422,366: cold-hook-context +3,075 (state.mjs +2,753: pins, narrowing, run causes and the clean test
  // environment at the gates; verification/attempts.mjs +672, test-recovery-runtime.mjs +426, Android readiness in
  // initialization/detectors.mjs +311, candidate-isolation.mjs +277), cold-narrow-reads +625 (external-command-policy.mjs
  // +2,086 for the command `env` key, quality-command-runner.mjs +1,616 for the process-group reaper and the adb device
  // check, verification/join.mjs +955 and profiles.mjs +599 for the Playwright and pytest exact profiles,
  // repository-test-command-inference.mjs +611, gradle-manifests.mjs +522, javascript-declarations.mjs +504;
  // code-delivery-tests.mjs -5,001 as Node inference moved to the lazily loaded test-module-markers.mjs), cold-core +614
  // (refusal-remediation.mjs +595 for the new refusal details, environment-declaration.mjs +220) and cold-hooks +50
  // (copilot-mutation-guard.mjs, the person-only decisions).
  // 7,430,000: main 327175e4 measures 7,424,875; a shell that cannot set its cwd (a VS Code agent-host chat) adds
  // cold-hooks +476 for 7,425,351: `env -C <bound root>` scoping, a tool-form refusal that names its fix instead of
  // a lifecycle route, and the turn rule that a non-Git folder runs commands as is (copilot-mutation-guard.mjs,
  // phase-mutation-contract.mjs).
  // 7,435,000: main c8e340ef3 (Story lists sorted by creation with their original creators) measures 7,430,250
  // without a recorded raise (cold-narrow-reads +1,004, cold-publication +413, cold-hook-context +2); the
  // Verification intent finding that names its fixes adds cold-narrow-reads +638 for 7,430,888.
  // 7,440,000 (next 5,000 boundary): main 34868ccab measures 7,432,228. Agent results move to the checkout's
  // Git-excluded .sflow/out under short names: cold-hooks +2,915 (the new agent-output-folder.mjs, shared by
  // agent-output.mjs, application-paths.mjs and the edit guard, and the guard's correction of misread result
  // paths), cold-catalogs +63 and cold-worker-protocol -10 for 7,435,196.
  // 7,445,000: main 00854b18 measures 7,439,597; the add-your-own-agent refusal's own recovery step
  // (refusal-remediation.mjs USER_AGENT_MAIN_INVALID) adds cold-core +470 for 7,440,067.
  // 7,450,000 (next 5,000 boundary): main e5dd29cf measures 7,442,689. The 2026-10-27 blocker audit's fixes:
  // recovery plans for a coverage gap an upstream issue names and for an approval nobody can give
  // (refusal-remediation.mjs), cold-core +5,200; the agent view that routes a finding the author cannot fix,
  // cold-worker-protocol +1,044; the coverage check naming its upstream issues, cold-narrow-reads +676 and
  // cold-phases +681; cold-hook-context +10, for 7,449,619.
  // 7,455,000: main d62754fe measures 7,449,619; the document-step fixes (an escalation's real instruction and
  // route, a stray file routed to recovery, constitution citations at prepublish with a coded refusal) add
  // cold-narrow-reads +838, cold-core +578, cold-worker-protocol +326, cold-publication +118 and
  // cold-hook-context +110 for 7,451,589.
  // 7,460,000: main 317d51b9 measures 7,451,589; the dead-end and trap routes (an upstream issue raised where it
  // can be decided, restore or return at approval, the stale start checkout's own commit, a skill-amended code
  // step prepared again, detach for a lost document, the Git commands for unsent commits, the decision list for an
  // open Story's ending, the model-off cause) add cold-hook-context +2,251, cold-core +1,952, cold-narrow-reads
  // +1,216, cold-publication +362 and cold-worker-protocol +62 for 7,457,432.
  // 7,465,000: main db439e3c measures 7,459,688 (the long-read ranges in 21d69817 took 2,157). An untracked
  // Playwright result folder no longer holds a decision, and the coverage preview selects changes as
  // publication does: cold-hooks +476 and cold-hook-context +81 for 7,460,245. No new file.
  // Main 591a797a measures 7,460,362; a person's own terminal steps routed to no skill and refused in every turn
  // (OWN_TERMINAL_STEPS in command-skills.mjs, the sign-off refusal in copilot-mutation-guard.mjs, the decision
  // list's terminal-only choices) add cold-core +2,092, cold-hooks +596, cold-phases +104 and cold-compatibility
  // +76 for 7,463,050, inside it.
  // 7,470,000: main 775a37b9 measures 7,463,396; approving with --confirm-evidence, which records the step's
  // planned screenshots and inspections as witnessed in the approval itself (the approve wiring, the confirmation
  // list and the terminal route), adds cold-hook-context +3,803 and cold-core +445 for 7,467,644. No new file.
  // 7,475,000: main cf33907d measures 7,467,644; a test-generation Story's plan row corrected to test-only
  // (decision plan --set-fulfillment, now the plan approver's own terminal step), an accepted implementation risk
  // honoured by the final gate, and an upstream issue raised from /sf-decide add cold-hooks +812, cold-narrow-reads
  // +756, cold-hook-context +755 and cold-core +400 for 7,470,367. No new file.
  // 7,480,000: main f732f212 measures 7,473,911; the rewritten-history check at approval and at the prior code
  // receipt (state.mjs) and acceptance off on a route with no code step add cold-hook-context +3,631 and
  // cold-narrow-reads +11 for 7,477,553. No new file.
  // 7,485,000: main d01be67d measures 7,477,553; the route-closure fixes (agent-output.mjs, command-skills.mjs,
  // copilot-mutation-guard.mjs, refusal-remediation.mjs, phase-resolution.mjs, collaboration.mjs) add 2,524 for
  // 7,480,077. No new file.
  // 7,490,000: main 3662923e measures 7,480,656; the batch 4 resets and authority fallback (approval-fallback.mjs
  // and its callers, the complete reopen reset, the roll-forward refusal, return listed only where it runs, the
  // budget reset route only from a submitted step) add 4,902 for 7,485,558. One new file.
  // 7,495,000: main fddafbe0 measures 7,485,558; main's own changes merged onto a Story branch named, not refused
  // (git.mjs mergedBaseChanges, delivery-evidence.mjs, governance.mjs, state.mjs), a pull request blocked by commits
  // after closing (git.mjs pathsChangedAfterMarker, pull-request.mjs) and early code taken out of an artifact-only
  // step (git.mjs commitsTouchingSince, state.mjs) add 6,010 for 7,491,568. No new file.
  // 7,500,000: main f8cbcdc3 measures 7,494,199; batch 7's shapes, two-machine and wording fixes (replace-test and remove-test in plan-row-corrections.mjs, the approval hint for a clone that is behind in sequence.mjs, the cancelled-Story refusal in lifecycle-transitions.mjs, tests owed only where planned in delivery-evidence.mjs, --fetch for the current Story, the evaluator's wording) add 3,682 for 7,497,881. No new file.
  // 7,510,000: main c168c2cf measures 7,497,881; keeping readers of a step approved again with the same authored text
  // (rule E9: authored producer digests in phase-upstream.mjs, retention bindings in inputs.mjs, phase-retention.mjs),
  // a rejected skill-version pair as review-safe (approval-check.mjs) and a lapsed witness exception's renewal at the
  // final gate (governance.mjs, gate-recovery.mjs) add 7,558 for 7,505,439. No new eager file: the renewal command,
  // its record and the publish drift warning are lazy.
  // 7,520,000: main 6f0e9741 measures 7,507,332; the approver refresh (a new accepted snapshot revision kind in workflow-snapshots.mjs, +13,280: its capture, replay and dialect, with its contracts loaded lazily; its review-safe commit in approval-check.mjs, +2,614; its registry, terminal-step, refusal and state entries) adds 12,564 (cold-narrow-reads, cold-core and
  // cold-hook-context, with its two record families) for 7,519,896. No new file in the closure.
  // 7,525,000: main 8180c46e measures 7,519,896; the approver refresh's three result messages (registered at last: every refresh ended in COMMAND_RESULT_INVALID) and approve --confirm-evidence as the approver's own terminal step add cold-core +744 and cold-hooks +680 for 7,521,320. No new file.
  // 7,535,000: main 0c7ca31b measures 7,521,320; the same message and contract text adds 11,517 for 7,532,837. No new file.
  // 7,540,000: main 58b20746 measures 7,532,837; refusals that name their own way out (rewritten history, approver refresh, roll-forward, a publish in flight, set-aside reasons, witness exceptions), help as a read, routed corrections and counted unchanged rechecks in agent-output.mjs, and the set-aside preview as a read add 6,316 for 7,539,153. No new file.
  // 7,545,000: main 024a6dae measures 7,539,475; a binary step artifact kept byte for byte (artifact-review-read.mjs; state.mjs prepare, publish and reconciliation; projectors.mjs; publication preflight; phase-upstream's authored digest), unique local Epic child Work IDs and an Epic's or Initiative's waiting commit set aside (its preview a read, its refusals naming its own branch) add cold-hook-context +1,752, cold-core +1,914 and
  // cold-hooks +57 for 7,543,198. No new file.
  // 7,550,000: main e3cc278a measures 7,543,198; the same clarification-answer route and rewritten-history
  // diagnosis add 3,438 for 7,546,636 (cold-hook-context, cold-hooks, cold-core). No new file in this closure.
  // 7,555,000: main 4bdc665c measures 7,547,596; agents APM deployed marked and bound to steps at discovery
  // (agents.mjs, cold-catalogs +2,773), workflow.yml `apm` read at configuration load (config.mjs,
  // cold-narrow-reads +629) and the apm attach registration (cold-core +524) add 3,926 for 7,551,522. The
  // lock reader and normalizer load only where apm.lock.yaml exists (cold-phases); no new file here.
  // 7,560,000: SDA M1 measures 7,559,288 against 7,555,000. Its additions in the chunks this closure shares: every
  // error's outcome class (outcome-classes.mjs, loaded by util.mjs), the ledger payload digest (ledger.mjs; pages
  // stay in ledger-pages.mjs), push-operation matching (transport-intents.mjs), the source inspection facade and
  // named push leases.
  // 7,570,000: SDA M2 measures 7,568,920. Its additions in the chunks this closure shares: last-known Story lists
  // and catalogs with their freshness (repository-check-cache.mjs; the refresh lease and replay stay in the lazy
  // projection-refresh.mjs), canonical finding identities (delivery-evidence.mjs), push intents bound to a
  // repository ID (transport-intents.mjs) and the Story binding finding (session discovery).
  // 7,605,000: SDA M3 measures 7,600,938: the lease liveness proof behind every subject lock and registry lease
  // (lease-liveness.mjs, subject-lock.mjs, file-lease.mjs), capability proposals replayed value by value with no
  // textual merge (capability-value-replay.mjs, git-configuration-objects.mjs, organisation.mjs), deferred
  // repositories (workspace.mjs) and transactional drafts (configuration-drafts.mjs).
  // 7,610,000: SDA M4 measures 7,605,711: SDA M4's lifecycle authority adapter (sda/story-branch-authority.mjs,
  // sda/lifecycle-authority-contract.mjs, sda/shared-state-contract.mjs); the publication writer it wraps loads
  // only on a transition.
  const hookContext = closure('cold-hook-context.mjs').reduce((sum, item) => sum + item.bytes, 0);
  // 7,615,000: main 38b61ada9 measures 7,605,407; the same SDA B1, B4 and B5 code in the hook closures adds 8,902 for 7,614,309.
  // 7,620,000: SDA B6b measures 7,616,401 against 7,614,309: configuration reads that take the object pool in place
  // (organisation.mjs, workspace.mjs, the pool itself loading lazily) and the editor's one-batch baseline (editor.mjs).
  // 7,630,000: main 6585b9b0b measures 7,618,395; the same sweep batch 1 lock-release code adds 8,651 for 7,627,046.
  // 7,650,000: sweep batches 1 and 2 together measure 7,642,199. Batch 2 adds each draft's standing against the approved
  // configuration, proposals that hold their drafts (upload pending, merged or closed on the host) and batches a stale
  // draft no longer blocks (configuration-drafts.mjs, +15,153 alone). No new file.
  assert.ok(hookContext < 7_650_000,
    `phase-review reads retain their existing byte ceiling after moving families (${hookContext} bytes)`);
  assert.match(await readFile(path.join(outdir, 'cold-light.mjs'), 'utf8'), /function enterPhase\b/u,
    'phase binding must not fall through to the compatibility/admin bundle');
  const phaseCode = await readFile(path.join(outdir, 'cold-phases.mjs'), 'utf8');
  assert.match(phaseCode, /function completePhaseEntry\b/u);
  assert.match(phaseCode, /function composePhasePrompt\b/u,
    'passive composition belongs in the existing prepared phase family, not the model/admin dispatcher');
  for (const name of ['readPendingList', 'pendingSummary', 'approvalAdvisories']) {
    assert.match(phaseCode, new RegExp(`function ${name}\\b`, 'u'), `nextsteps' ${name} must not fall through to the compatibility/admin bundle`);
  }
  // 5,245,000 (next 5,000 boundary over 5 MiB): main 3bd739a8 measures 5,241,916. A test command's literal `env`
  // (SPEC-TCE M6) adds 1,741 for 5,243,657, because every configuration read validates its commands:
  // cold-narrow-reads +1,593 (external-command-policy.mjs: the env check in normalizeExternalCommand 1,031 and
  // withCommandLiteralEnvironment 283, the env field and the receipt digest's env) and cold-core +148
  // (environment-declaration.mjs looksSecretName, which secret-looking.mjs now re-exports). The instruction
  // extractor and completer load lazily, outside these reads.
  // 5,250,000: a turn names its step's author (`Step author: /sf-phase.`) so no turn guesses /sf-code,
  // cold-hooks +216 (phase-mutation-contract.mjs, copilot-mutation-guard.mjs) for 5,245,199.
  // 5,255,000: main bc773c14 measures 5,249,833. A requirement whose criterion lacks one of its methods is
  // told which and both fixes, a clause-extraction failure is reported once instead of as every coverage row,
  // and the Specification line states that coverage rule: cold-narrow-reads +638 (verification/intent.mjs,
  // specification-quality.mjs, specification-scenarios.mjs, phase-prepublish.mjs, phase-authoring-contract.mjs)
  // for 5,250,471.
  // 5,260,000 (next 5,000 boundary): main 1d40e1de measures 5,252,527. Agent results move to the checkout's
  // Git-excluded .sflow/out under short names: cold-hooks +2,915 (the new agent-output-folder.mjs, shared by
  // agent-output.mjs, application-paths.mjs and the edit guard, and the guard's correction of misread result
  // paths), cold-catalogs +63 and cold-worker-protocol -10 for 5,255,495.
  // 5,265,000 (next 5,000 boundary): main 48d03fc8 measures 5,259,933. An agent folder of several agents is
  // named a workflow, with the recovery step that builds one from it (USER_AGENT_FOLDER_IS_WORKFLOW), and
  // call add and team import share one table of office documents, images and PDFs: cold-core +1,069 for
  // 5,261,002.
  // 5,270,000 (next 5,000 boundary): main e5dd29cf measures 5,262,555; the blocker audit's recovery plans and
  // agent view add cold-core +5,200, cold-worker-protocol +1,044 and cold-narrow-reads +676 for 5,269,475.
  // 5,275,000: main d62754fe measures 5,269,475; the document-step fixes add 1,742 for 5,271,217.
  // 5,280,000: main 16677122 measures 5,274,546; the edit guard's long-read ranges add cold-hooks +2,263,
  // cold-core +85 and cold-worker-protocol -191 for 5,276,703.
  // 5,285,000: main 591a797a measures 5,279,984 (Playwright results 828898f3 and convergence items 591a797a
  // took the rest); the scope include route's accepted placeholder adds cold-core +22 and cold-narrow-reads
  // +16 for 5,280,022. No new file.
  // 5,290,000: main d01be67d measures 5,284,968; the route-closure fixes add 2,298 for 5,287,266. No new file.
  // 5,295,000: main 80f74694 measures 5,287,266; the batch 4 resets and authority fallback add 2,888 for
  // 5,290,154. One new file (approval-fallback.mjs).
  // 5,300,000: main ef81e85b measures 5,294,453; the same person's own terminal decisions add cold-core +1,770 and
  // cold-hooks +601 for 5,296,824. No new file.
  // 5,305,000: main f8cbcdc3 measures 5,296,824; batch 7's shapes, two-machine and wording fixes (replace-test and remove-test in plan-row-corrections.mjs, the approval hint for a clone that is behind in sequence.mjs, the cancelled-Story refusal in lifecycle-transitions.mjs, tests owed only where planned in delivery-evidence.mjs, --fetch for the current Story, the evaluator's wording) add 3,583 for 5,300,407. No new file.
  // 5,315,000: main 6f0e9741 measures 5,302,276; the approver refresh (a new accepted snapshot revision kind in workflow-snapshots.mjs, +13,280: its capture, replay and dialect, with its contracts loaded lazily; its review-safe commit in approval-check.mjs, +2,614; its registry, terminal-step, refusal and state entries) adds 12,258 for 5,314,534. No new file in the closure.
  // 5,320,000: main 8180c46e measures 5,314,534; the approver refresh's three result messages (registered at last: every refresh ended in COMMAND_RESULT_INVALID) and approve --confirm-evidence as the approver's own terminal step add cold-core +744 and cold-hooks +680 for 5,315,958. No new file.
  // 5,330,000: main 0c7ca31b measures 5,315,958; the same message and contract text adds 10,178 for 5,326,136. No new file.
  // 5,335,000: main 58b20746 measures 5,326,136; refusals that name their own way out (rewritten history, approver refresh, roll-forward, a publish in flight, set-aside reasons, witness exceptions), help as a read, routed corrections and counted unchanged rechecks in agent-output.mjs, and the set-aside preview as a read add 6,131 for 5,332,267. No new file.
  // 5,340,000: main e3cc278a measures 5,334,560; the same clarification-answer route and rewritten-history
  // diagnosis add 1,370 for 5,335,930 (cold-hooks, cold-core). No new file.
  // 5,345,000: main 4bdc665c measures 5,336,890; the same APM agent discovery, configuration read and
  // registration add 3,926 for 5,340,816. No new file.
  // 5,350,000: SDA M1 measures 5,348,118 against 5,345,000, from the same additions in the shared chunks.
  // 5,360,000: SDA M2 measures 5,356,118, from the same last-known listings, finding identities, repository-bound
  // push intents and Story binding finding in the shared chunks. No new file.
  // 5,390,000: SDA M3 measures 5,388,142, from the same lease liveness proof, value-level capability
  // replay, deferred repositories and transactional drafts in the shared chunks.
  // 5,395,000: SDA M4 measures 5,392,641: the lifecycle authority adapter and its contract in the shared chunks.
  const catalogBytes = catalogClosure.reduce((sum, item) => sum + item.bytes, 0);
  // 5,405,000: main 38b61ada9 measures 5,392,337; SDA B1, B4 and B5 add 7,918 for 5,400,255.
  // 5,415,000: main 6585b9b0b measures 5,403,968; the same sweep batch 1 lock-release code adds 8,898 for 5,412,866.
  // 5,435,000: sweep batches 1 and 2 together measure 5,428,019: the same draft standings and proposal recovery in
  // configuration-drafts.mjs (batch 2, +15,153 alone).
  assert.ok(catalogBytes < 5_435_000,
    `catalog parsing stays bounded instead of pulling in the entire administration bundle (${catalogBytes} bytes)`);
  for (const name of ['cold-compatibility.mjs', 'cold-models.mjs', 'cold-intake.mjs', 'cold-phases.mjs', 'cold-hook-context.mjs']) {
    assert.ok(!catalogClosure.some(item => item.file === name), `catalogs must not statically reach ${name}`);
  }
  const text = (await Promise.all(closure('cli.mjs').map(item => readFile(path.join(outdir, item.file), 'utf8')))).join('\n');
  assert.doesNotMatch(text, /node_modules\/(?:typescript|pyright|sql\.js|@agentclientprotocol)\//u, 'large or file-based packages stay external');
  assert.match(text, /\.\.\/src\/build-info\.mjs/u, 'the install stamp is read live from src/');

  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bundle-run-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_GIT_FACT_STORE: 'off', HOME: path.join(base, 'home'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Bundle Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'bundle@example.invalid' };
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, '--no-model', 'init'], { cwd: repo, env }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: repo, env }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'initialized fixture'],
    { cwd: repo, env }).status, 0);
  // Count every module file the process loads, from the loader thread, synchronously.
  const hook = path.join(base, 'count.mjs');
  await writeFile(hook, `import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:')) appendFileSync(process.env.MODULE_LOG, url + '\\\\n');
  return result;
}\`));
`);
  const runWith = async (args, bundle) => {
    const log = path.join(base, `modules-${bundle ? 'bundle' : 'source'}.log`);
    await rm(log, { force: true });
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, ...args], {
      cwd: repo, encoding: 'utf8', env: { ...env, MODULE_LOG: log, ...(bundle ? { SINGULARITY_FLOW_BUNDLE_DIR: outdir } : { SINGULARITY_FLOW_BUNDLE: 'off' }) }
    });
    const modules = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { status: result.status, stdout: result.stdout, modules };
  };
  for (const args of [['--version'], ['help'], ['snapshot', '--include', 'repository', '--json'], ['status', 'MISSING', '--json'], ['nextsteps', '--json'],
    ['home', '--json'], ['inbox', '--json'],
    ['agents', 'list', '--json'], ['agents', 'mappings', '--json'], ['agents', 'status', '--json'],
    ['phase', 'show', 'intake', '--json'], ['report', 'MISSING', '--format', 'json'],
    ['workflow', 'list', '--json'], ['skill', 'list', '--json'], ['instruction', 'list', '--json'],
    ['start', 'BUNDLE-NEW-STORY', '--json'],
    ['workflow', 'intent', 'preflight', '--source', 'installed', '--json'],
    ['workflow', 'markup', 'example', '--json']]) {
    const source = await runWith(args, false);
    const bundled = await runWith(args, true);
    assert.equal(bundled.status, source.status, args.join(' '));
    if (['home', 'inbox'].includes(args[0])) {
      // These issue read timestamps (and Home one-use selection handles). Every binding, action,
      // outcome and effect still compares exactly; only these deliberately fresh values differ.
      const stable = text => JSON.parse(text, (key, value) => {
        if (key === 'handle' && /^sel_[a-f0-9]+$/u.test(value)) return '<one-use-selection>';
        if (['asOf', 'generatedAt'].includes(key) && typeof value === 'string' && Number.isFinite(Date.parse(value))) return '<time-of-read>';
        return value;
      });
      assert.deepEqual(stable(bundled.stdout), stable(source.stdout), `${args[0]} preserves its result apart from fresh read values`);
    } else assert.equal(bundled.stdout, source.stdout, `${args.join(' ')} prints the same`);
    assert.ok(bundled.modules.length <= 28, `${args.join(' ')} opened ${bundled.modules.length} module files: ${bundled.modules.join(', ')}`);
    if (args[0] === '--version') assert.ok(bundled.modules.length <= 8, 'version only loads core');
    if (['snapshot', 'nextsteps', 'home', 'inbox'].includes(args[0])) assert.ok(!bundled.modules.some(url => url.endsWith('/cold-compatibility.mjs')),
      `${args[0]} must not load the general compatibility handler`);
    if (['agents', 'workflow', 'skill', 'instruction'].includes(args[0]) && ['list', 'mappings', 'status'].includes(args[1])) {
      for (const name of ['cold-compatibility.mjs', 'cold-models.mjs', 'cold-intake.mjs', 'cold-phases.mjs']) {
        assert.ok(!bundled.modules.some(url => url.endsWith('/' + name)), `${args.join(' ')} must not load ${name}`);
      }
    }
    if (args[0] === 'report' || args[0] === 'phase' && args[1] === 'show') {
      for (const file of ['cold-compatibility.mjs', 'cold-phases.mjs', 'cold-models.mjs']) {
        assert.ok(!bundled.modules.some(url => url.endsWith('/' + file)), `${args.join(' ')} must not load ${file}`);
      }
    }
    if (args[0] !== '--version') assert.ok(source.modules.length > 35, `${args.join(' ')} from the sources opened ${source.modules.length}`);
  }

  // Classified capture must share the timer through the coarse lazy chunks, not just source ESM.
  const traceAction = randomUUID();
  for (const bundled of [false, true]) {
    const result = spawnSync(process.execPath, [cli, 'logs', 'path'], { cwd: repo, encoding: 'utf8', timeout: childTimeout(30_000),
      env: { ...env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '0', SINGULARITY_FLOW_PERF_TRACE: '1',
        SINGULARITY_FLOW_PERF_ACTION_ID: traceAction,
        ...(bundled ? { SINGULARITY_FLOW_BUNDLE_DIR: outdir } : { SINGULARITY_FLOW_BUNDLE: 'off' }) } });
    assert.equal(result.status, 0, result.stderr);
  }
  const traced = await readPerformanceReport(path.join(repo, '.git', 'singularity-flow', 'dx'),
    { actionId: traceAction, includeTimeline: true });
  assert.equal(traced.traces.length, 2);
  for (const trace of traced.traces) assert.ok(trace.timeline.some(span => span.category === 'git-local'));
  const counts = trace => Object.fromEntries(Object.entries(trace.counters).filter(([key]) => !key.includes('service-ms')));
  assert.deepEqual(counts(traced.traces[0]), counts(traced.traces[1]), 'physical requests match; observed durations legitimately differ');

  // The launcher must actually select the dedicated bundle, not just a manifest URL. Real turn
  // capture and edit denials replay identically, while the bundled entry opens only a few files.
  const beforeWarm = spawnSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' }).stdout;
  const warmed = await runWith(['--warm-runtime'], true);
  assert.equal(warmed.status, 0);
  const preparation = JSON.parse(warmed.stdout);
  if (preparation.prepared) {
    assert.equal(preparation.commandsExecuted, 0); assert.equal(preparation.modelsInvoked, 0);
    assert.ok(preparation.files.every(file => file.startsWith('cold-') && !file.includes('worker')));
    assert.ok(preparation.files.includes('cold-catalogs.mjs'), 'prepares catalog definitions');
    assert.ok(preparation.files.includes('cold-phases.mjs'), 'prepares phase definitions');
    assert.ok(preparation.files.includes('cold-reads.mjs'), 'prepares narrow phase-document/report definitions too');
    assert.ok(preparation.files.includes('cold-narrow-reads.mjs'), 'prepares the isolated read family');
    assert.ok(!warmed.modules.some(url => /\/(?:cold-compatibility|cold-models|read-worker|history-index-worker)\.mjs$/u.test(url)),
      'warming definitions cannot start a worker or import the compatibility/model domain');
  } else assert.equal(preparation.reason, 'cache-or-bundle-unavailable', 'Node 20/disabled cache is optional');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' }).stdout, beforeWarm);
  for (const [action, payload] of [
    ['boundary-guard', {}],
    ['agent-start', { agentName: 'product-owner', cwd: repo }],
    ['boundary-turn', { sessionId: 'bundled-hook', cwd: repo, prompt: '/sf-code' }],
    ['boundary-guard', { sessionId: 'bundled-hook', cwd: repo, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } }],
    ['boundary-after', { sessionId: 'bundled-hook', cwd: repo }],
    ['boundary-end', { sessionId: 'bundled-hook', cwd: repo }]
  ]) {
    const results = [];
    for (const bundled of [false, true]) {
      const log = path.join(base, `hook-modules-${bundled}.log`);
      await rm(log, { force: true });
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href,
        path.join(root, 'plugin/hook-launcher.mjs'), action, cli], {
        cwd: repo, encoding: 'utf8', input: JSON.stringify(payload), timeout: childTimeout(30000),
        env: { ...env, MODULE_LOG: log, SINGULARITY_FLOW_HOOK_RUNTIME: 'dedicated',
          SINGULARITY_FLOW_BUNDLE: bundled ? 'on' : 'off', ...(bundled ? { SINGULARITY_FLOW_BUNDLE_DIR: outdir } : {}) }
      });
      assert.equal(result.status, 0, `${action}: ${result.stderr}`);
      results.push(JSON.parse(result.stdout));
      const modules = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      if (bundled) {
        assert.ok(modules.some(url => url.endsWith('/copilot-hook-runtime.mjs') && !url.includes('/src/')),
          `${action}: the dedicated bundle ran`);
        assert.ok(modules.length <= 16, `${action}: ${modules.length} module files`);
        assert.ok(!modules.some(url => url.endsWith('/cold-compatibility.mjs')), `${action}: no general CLI chunk`);
      }
    }
    assert.deepEqual(results[1], results[0], `${action}: bundled hooks preserve the source decision`);
    if (action === 'boundary-guard' && payload.sessionId) assert.equal(results[1].permissionDecision, 'deny');
  }

  // `secrets protect` writes a hook that runs the CLI it was installed from. Bundled, its module is
  // not in src/commands/, so that path must come from the package root and never from the file.
  const hooks = {};
  for (const bundle of [false, true]) {
    const protect = await runWith(['secrets', 'protect'], bundle);
    assert.equal(protect.status, 0, `secrets protect from the ${bundle ? 'bundle' : 'sources'}`);
    hooks[bundle] = await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
  }
  assert.equal(hooks.true, hooks.false, 'the bundle installs the same hook as the sources');
  assert.ok(hooks.true.includes(JSON.stringify(path.join(root, 'bin', 'singularity-flow.mjs'))), hooks.true);
});
