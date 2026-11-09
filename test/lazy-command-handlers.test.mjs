import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { commandDefinition } from '../src/command-registry.mjs';
import { commandModuleFiles } from './helpers/command-source.mjs';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const parsed = new Map();
async function graph(relative) {
  const files = new Set(), pending = [path.resolve(sourceRoot, relative)];
  let bytes = 0;
  while (pending.length) {
    const file = pending.pop(); if (files.has(file)) continue; files.add(file);
    let entry = parsed.get(file);
    if (!entry) {
      const text = await readFile(file, 'utf8');
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
      const imports = ast.statements.filter(statement => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier))
        .map(statement => statement.moduleSpecifier.text).filter(name => name.startsWith('.'))
        .map(name => path.resolve(path.dirname(file), name));
      entry = { bytes: Buffer.byteLength(text), imports }; parsed.set(file, entry);
    }
    bytes += entry.bytes; pending.push(...entry.imports);
  }
  return { files, bytes };
}

test('frequent lifecycle handlers do not reach the legacy dispatcher and stay under their eager budget', async () => {
  for (const name of ['start', 'session', 'choices', 'inputs', 'prepare', 'review-source', 'submit', 'approve', 'phase']) {
    assert.notEqual(commandDefinition(name).modulePath, './commands/legacy.mjs', name);
  }
  for (const file of ['commands/start.mjs', 'commands/session.mjs', 'commands/choices.mjs', 'commands/inputs.mjs',
    'commands/prepare.mjs', 'commands/review-source.mjs', 'commands/submit.mjs', 'commands/approve.mjs', 'commands/phase-lifecycle.mjs']) {
    const closure = await graph(file);
    assert.equal(closure.files.has(path.join(sourceRoot, 'cli.mjs')), false, `${file} re-imported the monolith`);
    if (['commands/approve.mjs', 'commands/phase-lifecycle.mjs'].includes(file)) {
      assert.equal(closure.files.has(path.join(sourceRoot, 'commands/shared/phase-review.mjs')), false,
        `${file} eagerly loads optional full-document rendering for the compact agent route`);
    }
    // 455: phase-lifecycle.mjs reached 455 with the source-review batching (f79ec1fa, 5a25abe8, d18afdc6): the
    // clarification-paths, phase-input-policy and phase-inspection-generation helpers split out of modules it already
    // loaded, plus the source-review snapshot cache.
    // 456: submit.mjs reached 456 on main 97805fde without a recorded raise: creation-context.mjs (0b0dc559, shared Story
    // creation captures), verification/incremental-verification-graph.mjs (4838febb) and workspace-clone-claim.mjs
    // (6e6824f3) joined its graph while clarification-paths.mjs and grounding.mjs left it.
    // 457: phase-staging-paths.mjs, the one derivation of a step's own staging files that phase entry, source review
    // and the Copilot guard share (docs/SPEC-STAGING-PERMISSIONS-v1.md), joined submit.mjs's graph through clarifications.mjs.
    // 458: submit.mjs reached 458 on main 97054d4b without a recorded raise: workspace-story-location-scope.mjs
    // (858465d6, lightweight intake and direct Story worktrees) joined its graph through capability-start.mjs.
    // 459: story-configuration-objects.mjs (b25d3e72, bounded configuration trees) joined submit.mjs's graph through
    // configuration-branch.mjs on main 810418a6 without a recorded raise.
    // 460: story-presentation.mjs (c8e340ef3, a Story's original creator) joined submit.mjs's graph through
    // story-publication-binding.mjs and story-state-index.mjs on main without a recorded raise.
    // 461: agent-output-folder.mjs, the leaf that keeps agent results in the checkout's Git-excluded .sflow/out,
    // joined submit.mjs's graph through agent-output.mjs and application-paths.mjs.
    // 462: approval-fallback.mjs, who decides for a step with no approval group of its own, joined submit.mjs's
    // graph through evidence/risk-decisions.mjs, plan-row-corrections.mjs and scope/decisions.mjs.
    // 464: SDA M1's two leaves joined submit.mjs's graph: outcome-classes.mjs (no imports; util.mjs gives every
    // error its outcome class) and source-inspection.mjs (through repository-subject-index.mjs and ast-lifecycle.mjs).
    // 465: SDA M3's lease-liveness.mjs, the lease owner proof every subject lock reads.
    // 466: SDA M4's lifecycle authority adapter (sda/story-branch-authority.mjs, sda/lifecycle-authority-contract.mjs, sda/shared-state-contract.mjs), through which recovery and test-recovery reads observe the subject branch; the publication writer it wraps loads only on a transition.
    // 467: SF Guard M3's presence/counted.mjs, the import-free leaf each person-step family reader counts through,
    // joined submit.mjs's graph through evidence/risk-decisions.mjs, scope/decisions.mjs and the other family modules.
    // 468: SPEC-ENVF v2's config-values.mjs and local-config-policy.mjs, both import-light leaves, on the entry that was one under.
    // 469: the runner table (test-runners.mjs), an import-free leaf, which code-delivery-tests.mjs reads a report's language from.
    // 470: person-step-catalog.mjs, one leaf holding what the guard, SF Guard and the review rules read of a person's steps.
    // 471: step-sheet-route.mjs, the leaf that reads a sheet's next step as a route.
    // 473: spec–code sync M1's two import-free leaves (conformance-differences.mjs, departure-acceptance.mjs), which the
    // conformance gap decisions read so approval and the gates decide deviated and unplanned rows without loading the
    // report reader or the departure model [SCS:REQ-010, REQ-013].
    assert.ok(closure.files.size <= 473, `${file} loads ${closure.files.size} local files (budget 473; retired graph 597)`);
    // 9,005,000 (next 5,000 boundary): phase-lifecycle.mjs grew from 8,993,692 (main 4a8e6c42) to 9,004,129 with the
    // capability application block's per-environment arguments and debug validation in capabilities.mjs and the
    // launcher rules it reads (RUN amendment), together with 2ca46d6d's conformance issue ownership; no new file.
    // 9,030,000 (next 5,000 boundary): 2fbfc887 was already 9,020,367, over 9,005,000, before this work (not bisected);
    // environment files (docs/SPEC-ENVIRONMENT-FILES-v1.md) add 6,974 to 9,027,341: the registry policy and the
    // scoped-commit check in git.mjs, document intake's link-aware path check, the exact-path matcher, the operation
    // classes and the gate's file placement call. The engine itself is lazy; no new file.
    // 9,035,000 (next 5,000 boundary): start.mjs was 9,028,819 on main a4aa046f; c2ac5250 (a decision input reuses the
    // value an earlier decision recorded, so branches come back together) added 4,037 bytes to workflow-decisions.mjs,
    // which every Story transition reads, and the build/import-team export actions 257 to command-registry.mjs: 9,033,113.
    // No new file.
    // 9,040,000 (next 5,000 boundary): the workflow-audit leftovers (50d5a5ce: approval's --yes remediation route,
    // the gate's re-check of a human generation's clarification record, the after-start origin in the MCP tool policy)
    // added 765 and verification steps that run the repository's tests (cfcbd295: the repositoryTests setting in
    // config.mjs and state.mjs) 1,871, together 9,035,749. The test runner itself is lazy; no new file.
    // 9,045,000 (next 5,000 boundary): the packaged sample user-defined agent (careful-change) adds its
    // agent, starter template, folder and manifest digests to packaged-asset-history.mjs and its work type
    // and step to packaged-workflow-history.mjs, which every Story start reads: 9,041,169. No new file.
    // 9,050,000 (next 5,000 boundary): start.mjs was 9,044,104 on main 507ade77; the read operations of Jira,
    // Initiative, Epic, knowledge, harness, regression and init --check, so a read-only Copilot turn may run them
    // (command-registry.mjs, +4,101), give 9,048,205. No new file.
    // 9,055,000 (next 5,000 boundary): the office enrollment blocker and its routes (29d5e906, 946f9716) add
    // 12,014 to 9,053,183: transport-intents.mjs +4,923 (a push's reason, retry and missing-checkout helpers),
    // commands/start.mjs +1,069 and configuration-people.mjs +989 (start carries on with a pending enrollment
    // from the main checkout), publication-unit-of-work.mjs +701, state.mjs +632, refusal-remediation.mjs +558,
    // sequence.mjs +501, util.mjs +388 (a missing working folder) and smaller. No new file.
    // 9,060,000 (next 5,000 boundary): both of the above together, merged at main 24466a14 + work-turns: 9,058,321.
    // 9,065,000 (next 5,000 boundary): Nx Playwright inference and the test command proposal add 1,867 to
    // main ed71e5e6's 9,059,694: code-delivery-tests.mjs +1,160 (an Nx project as a module and its lazy loader),
    // narration/messages.mjs +399 and command-registry.mjs +308. nx-test-targets.mjs and test-setup-proposal.mjs
    // load lazily. No new file.
    // 9,070,000 (next 5,000 boundary): the 2026-10-24 round (World Model v5 M4-M5, XPL2 M2-M4, INT P1-P4, SPEC-OUT
    // REQ-014, their review fixes and the free-text option parser) adds 3,729 to main 4a72b80f's 9,063,836:
    // command-registry.mjs +1,958 (wm rules, wm brief --polish, explain --narrate and the gateway command), git.mjs +897
    // (XPL2's lineCommitAt), util.mjs +623 (free-text options, commentary and polish flags), inject.mjs +192. No new file.
    // 9,075,000 (next 5,000 boundary): a Story branch carries only its own workflow's configuration closure, adding
    // 7,737 to main 1ecccc54's 9,065,911: configuration-branch.mjs +5,679 (closure materialization and its re-derived
    // check), commands/start.mjs +1,114 (closure inputs and the whole-copy fallback notice), config.mjs +956 (the
    // pinned initialization status doctor now shares). story-configuration-closure.mjs loads lazily. No new file.
    // 9,080,000 (next 5,000 boundary): SPEC-OAP M0 adds 1,385 to main 445e65b7's 9,073,648: specification-gate.mjs
    // +873 (approvalChecklistPrompt, the checklist articles phase show and the refusal name so Copilot can approve a
    // checklist phase) and state.mjs +512 (APPROVAL_CHECKLIST_INCOMPLETE with the unanswered articles): 9,075,033.
    // No new file.
    // 9,085,000 (next 5,000 boundary): SPEC-OAP M1 adds 8,684 to 9,075,033: state.mjs +7,440 (the approval gate
    // as evaluateApproval's named stages, their shared facts and the record step that reuses them, so the preview
    // and the gate are one code path) and nextsteps.mjs +1,244 (the approval holds take the approval's place):
    // 9,083,717. approval-check.mjs loads lazily. No new file.
    // 9,090,000 (next 5,000 boundary): an amendment's read, decision and acknowledgement name no Copilot skill,
    // adding 2,153 to main 4a4a73e6's 9,083,994: command-skills.mjs +756 (null exact routes and
    // commandLineWithoutSkill), safe-command-guidance.mjs +666 (no-skill guidance and its unavailable status),
    // copilot-guidance.mjs +417, narration/command-result.mjs +169, phase-governance-routing.mjs +86 and
    // shared/print-command-routes.mjs +59: 9,086,147. No new file.
    // 9,095,000 (next 5,000 boundary): SPEC-OAP M2 adds 6,115 to main bdd4049e's 9,087,930, all state.mjs: the
    // REVIEW_EFFECTS registry (one effect per lifecycle event type and decision kind, which the review-history
    // check and Auto's resume read) and the approval stage that holds an undecided amendment: 9,094,045. The
    // amendment verifiers in approval-check.mjs load lazily. No new file.
    // 9,100,000 (next 5,000 boundary): the Story index adds 1,153 to main 951e4122's 9,094,045 for 9,095,198:
    // util.mjs +466 (samePlatformPath, moved from story-worktree.mjs), commands/start.mjs +380 (the one-checkout
    // refusal and the index record after start), schema-migrations.mjs +285 (the story-index family) and
    // command-registry.mjs +22. story-index.mjs loads lazily. No new file.
    // 9,105,000 (next 5,000 boundary): SPEC-OAP M4 adds 3,763 to main a599bf6c's 9,096,920, all choices.mjs: an
    // approval receipt bound to the review it holds rather than a clock or HEAD, the refusal naming what changed,
    // and the cleanup of receipts for other reviews: 9,100,683. approval-decisions.mjs and terminal-review.mjs
    // load with approve and phase show, never with start. No new file.
    // 9,110,000 (next 5,000 boundary): SPEC-TCE (test commands and evidence) adds 7,603 to main 3bd739a8's
    // 9,102,016 for 9,109,619: state.mjs +2,784 (pins, narrowing, cause, clean environment at the gates),
    // external-command-policy.mjs +2,171 (the command `env` key), quality-command-runner.mjs +1,568 (the
    // process-group reaper and the adb device check), verification/join.mjs +955, attempts.mjs +618 and
    // profiles.mjs +599 (Playwright and pytest exact profiles, pins and narrowing on attempts), and smaller
    // shares in repository-test-command-inference, test-recovery-runtime, gradle-manifests,
    // javascript-declarations and test-runtime; code-delivery-tests.mjs is 5,147 smaller (Node inference moved to
    // the lazily loaded test-module-markers.mjs). No new file.
    // 9,115,000 (next 5,000 boundary): 8f25dc4b's three-surface guidance measures 9,111,051, and a person's own
    // terminal steps routing to their command instead of /sf-decide adds 723 for 9,111,774 (decision-list.mjs,
    // decision-list-facts.mjs, nextsteps.mjs, command-skills.mjs). No new file.
    // 9,120,000 (next 5,000 boundary): start.mjs was 9,115,761 on main c8e340ef3 (Story lists sorted by creation
    // with their original creators) without a recorded raise; a Verification intent finding that names its missing
    // methods and both fixes, with the coverage rule in the Specification line, adds 1,021 for 9,116,782
    // (verification/intent.mjs, phase-authoring-contract.mjs, specification-quality.mjs). No new file.
    // 9,125,000 (next 5,000 boundary): main 1d40e1de measures 9,118,376 for start.mjs. Agent results in the
    // checkout's Git-excluded .sflow/out add 5,247 for 9,123,623: the new agent-output-folder.mjs (the folder, its
    // exclude line and the ignored-entry check) and its use in agent-output.mjs, application-paths.mjs,
    // copilot-mutation-guard.mjs, story-worktree.mjs, workspace.mjs and workspace-retention.mjs. One new file.
    // 9,135,000 (next 5,000 boundary): main 4f81044f measures 9,125,824, over 9,125,000 without a recorded raise:
    // a local document's short hard-linked name added 1,673 to document-storage.mjs (from 9,124,151 at 04e37689).
    // The outcome review adds 4,679 for 9,130,503: its terminal view in render-terminal.mjs (2,949), a sign-off's
    // own screenshot as review-safe in state.mjs (1,155), its messages (476), registry entry (72) and skill route
    // (27). The reader and command are lazy; no new file.
    // 9,145,000 (next 5,000 boundary): main 317d51b9 measures 9,133,783 for start.mjs. The blocker audit's dead-end
    // and trap routes add 7,385 for 9,141,168 (refusal-remediation.mjs, state.mjs, story-worktree.mjs, start.mjs,
    // upstream-routes.mjs, document-runtime.mjs, gate-recovery.mjs, lifecycle-worktree.mjs and others). No new file.
    // 9,150,000 (next 5,000 boundary): main 591a797a measures 9,143,575 for start.mjs. A person's own terminal steps
    // routed to no skill and refused in every turn add 3,525 for 9,147,100 (command-skills.mjs,
    // copilot-mutation-guard.mjs, decision-list.mjs, narration/command-result.mjs, commands/decisions.mjs). No new file.
    // 9,155,000 (next 5,000 boundary): main cf33907d measures 9,147,422 for start.mjs. A test-generation Story's
    // plan row corrected to test-only, the plan approver's own terminal step for it, an accepted implementation risk
    // at the final gate and an upstream issue raised from /sf-decide add 3,152 for 9,150,574 (plan-row-corrections.mjs,
    // evidence/risk-decisions.mjs, copilot-mutation-guard.mjs, command-skills.mjs, evidence/evaluate.mjs,
    // governance.mjs, commands/plan-correction.mjs, evidence/terminal.mjs). No new file.
    // 9,160,000 (next 5,000 boundary): main 60915c16 measures 9,154,940 for start.mjs. Reopen authorized through the
    // nearest earlier step with approvers when the last step has none, and the validator naming an omitted
    // responsibility's empty group, add 1,029 for 9,155,969 (upstream-routes.mjs, state.mjs, workflow-check.mjs,
    // gate-recovery.mjs). No new file.
    // 9,165,000: main f732f212 measures 9,155,969 for start.mjs. A rewritten Story history named at approval and at
    // the prior code receipt, and acceptance off on a route with no code step, add 5,940 for 9,161,909 (state.mjs,
    // governance.mjs, config.mjs). No new file.
    // 9,175,000 (next 5,000 boundary): main 80f74694 measures 9,163,205 for start.mjs. The batch 4 resets and
    // authority fallback add 8,825 for 9,172,030 (state.mjs, delivery-evidence.mjs, approval-fallback.mjs,
    // lifecycle-transitions.mjs, evidence/terminal.mjs, upstream-routes.mjs, repair-budget.mjs, decision-list.mjs
    // and others). One new file.
    // 9,185,000 (next 5,000 boundary): main fddafbe0 measures 9,172,581 for start.mjs. main's own changes merged
    // onto a Story branch named, not refused, a pull request blocked by commits after closing, and early code taken
    // out of an artifact-only step add 9,016 for 9,181,597 (git.mjs, state.mjs, delivery-evidence.mjs,
    // pull-request.mjs, governance.mjs). No new file.
    // 9,195,000 (next 5,000 boundary): main f8cbcdc3 measures 9,183,252 for start.mjs; batch 7's shapes, two-machine and wording fixes (replace-test and remove-test in plan-row-corrections.mjs, the approval hint for a clone that is behind in sequence.mjs, the cancelled-Story refusal in lifecycle-transitions.mjs, tests owed only where planned in delivery-evidence.mjs, --fetch for the current Story, the evaluator's wording), with resume's
    // waiting-publication and synced-folder lines (commands/shared/start-context.mjs), add 7,016 for 9,190,268. No new file.
    // 9,205,000 (next 5,000 boundary): main c168c2cf measures 9,190,268 for start.mjs. Rule E9 (inputs.mjs,
    // phase-upstream.mjs, phase-retention.mjs, equivalence-rules.mjs), the rejected skill-version pair check
    // (approval-check.mjs) and the witness exception renewal at the final gate (governance.mjs, gate-recovery.mjs,
    // state.mjs) add 11,733 for 9,202,001. No new file.
    // 9,210,000 (next 5,000 boundary): main e97b5bd6 measures 9,203,737 for start.mjs. The step-entry guidance
    // naming the verification contract Witness cell and each method's assurance words, and contract refusals that
    // say what a cell holds, add 1,649 for 9,205,386 (phase-authoring-contract.mjs, verification/contracts.mjs). An
    // office Copilot turn looped on that table for lack of them (2026-10-29). No new file.
    // 9,225,000 (next 5,000 boundary): main 6f0e9741 measures 9,205,386 for start.mjs; the approver refresh (a new
    // accepted snapshot revision kind in workflow-snapshots.mjs, +13,280: its capture, replay and dialect, with its
    // contracts loaded lazily; its review-safe commit in approval-check.mjs, +2,614; its registry, terminal-step,
    // refusal and state entries) adds 15,059 for 9,220,445 (submit.mjs 9,142,110). The contracts load lazily, so no handler gains a file.
    // 9,240,000 (next 5,000 boundary): main 0c7ca31b measures 9,221,738 for start.mjs; refusals that quote the cell or line an author wrote and say what belongs there, publish-time prepublish plans for the draft refusals, and step-entry sentences for the rules never described (draft-diagnostics, specifications, specification-scenarios, verification intent and contracts, conformance, preflight, specification quality, constitution, refusal-remediation, phase-authoring-contract), after agents looped on such refusals in the office, add 14,359 for 9,236,097. No new file.
    // 9,245,000 (next 5,000 boundary): main 024a6dae measures 9,238,284 for start.mjs; a binary step artifact kept byte for byte (artifact-review-read.mjs; state.mjs prepare, publish and reconciliation; projectors.mjs; publication preflight; phase-upstream's authored digest), unique local Epic child Work IDs and an Epic's or Initiative's waiting commit set aside
    // add 5,564 for 9,243,848. No new file.
    // 9,250,000 (next 5,000 boundary): main e3cc278a measures 9,243,848 for start.mjs. A rewritten history named
    // with which recorded commits it still carries as the same change, and a clarification answer sent from the
    // approver's own clone, add 3,966 for 9,247,814 (state.mjs, copilot-mutation-guard.mjs, cli.mjs,
    // narration/messages.mjs, command-registry.mjs, command-skills.mjs, help-text.mjs). The answer and import
    // handlers are lazy; no new eager file.
    // 9,255,000 (next 5,000 boundary): main 4bdc665c measures 9,249,142 for start.mjs. Agents APM deployed
    // marked and bound to steps at discovery, refused at snapshot capture and step entry when changed, and
    // apm attach (agents.mjs, config.mjs, workflow-snapshots.mjs, phase-prompt-composer.mjs, workflow-studio.mjs,
    // editor.mjs, narration/messages.mjs, command-registry.mjs, help-text.mjs) add 5,055 for 9,254,197. The lock
    // reader and the apm normalizer are lazy; no new eager file.
    // 9,260,000 (next 5,000 boundary): main 58e90b56 measures 9,254,197 for start.mjs. A Maven verify that wrote no
    // failsafe-reports reads surefire's, readiness's unit-only run keeps Maven on `test` and leaves out .NET
    // integration projects (code-delivery-tests.mjs, repository-test-command-inference.mjs), adding 1,130 for
    // 9,255,327 (submit.mjs 9,177,155). The Node setup and pnpm rules live in the lazy test-module-markers.mjs.
    // 9,275,000 (next 5,000 boundary): main 2f2069e83 measures 9,255,327 for start.mjs. SDA M1 adds 15,311 for
    // 9,270,638: every error's outcome class (outcome-classes.mjs, util.mjs), the ledger payload digest and its
    // snapshot readers (ledger.mjs; pages stay in the lazy ledger-pages.mjs), push-operation matching
    // (transport-intents.mjs), the source inspection facade (source-inspection.mjs, through
    // repository-subject-index.mjs) and named push leases (git.mjs, publication-unit-of-work.mjs and the
    // recovery callers). Two new eager files: outcome-classes.mjs and source-inspection.mjs.
    // 9,285,000 (next 5,000 boundary): main fa3094b83 measures 9,270,638. SDA M2 adds 9,331 for 9,279,969: each
    // gate problem's canonical finding identity (delivery-evidence.mjs +2,286, implementation-bindings.mjs),
    // the Auto plan's recorded branch (change-flight-plan.mjs +1,664), push intents bound to a repository ID
    // (transport-intents.mjs +1,511), exact-object configuration inspection (configuration-branch.mjs +1,398,
    // approved-configuration-reader.mjs), Initiative identity from ledger records (initiative-state.mjs), the
    // Story binding finding (session discovery and roster) and the index command's registration. The read
    // index's refresh machinery, the finding identity module and the identity readers stay lazy; no new eager file.
    // 9,305,000 (next 5,000 boundary): main bce954290 measures 9,279,969. SDA M3 adds 22,372 for 9,302,341: the lease liveness proof (lease-liveness.mjs: machine identity, owner start time, the shared owner predicate) behind every subject lock and registry lease
    // (+~20 KB with subject-lock.mjs and file-lease.mjs), deferred repositories (workspace.mjs) and
    // transactional drafts. The configuration projection and the lock command stay lazy; one new eager file.
    // 9,310,000 (next 5,000 boundary): main 7b8cad8f1 measures 9,304,020. A Windows 8.3 short name compared as the
    // filesystem spells it (util.mjs) and the person's line endings for the destructive proof's own status reads
    // (source-inspection.mjs, worktree-fingerprint.mjs) add 2,185 for 9,306,205; no new eager file.
    // 9,315,000 (next 5,000 boundary): main 68fb64d51 measures 9,306,985. A Story's specification slice (SPEC-SPA
    // v1.3 S2): its USER-STORY.md section (state.mjs +997), the --spec start steps (start.mjs +876), the coverage and
    // attach operations (command-registry.mjs +568), each sliced clause a scope statement (scope/extract.mjs +529),
    // the spec-usage record family (schema-migrations.mjs +338), the attach own-terminal step (command-skills.mjs),
    // the --allow-partial-dependency flag (util.mjs) and the usage helper's build identity add 3,649 for 9,310,634.
    // The slice and usage modules load only for --spec; no new eager file.
    // 9,315,000 holds: main db46b5458 measures 9,310,634. Copilot's proposals (SPEC-SPA v1.3 S4) add 718 for
    // 9,311,352: accept and reject as own-terminal steps and the /sf-spec-author routes (command-skills.mjs) and the
    // spec-studio turn mode (phase-mutation-contract.mjs); no new eager file.
    // 9,315,000 holds: main f840dc33c measures 9,312,288. A specification split (SPEC-SPA v1.3 S5) adds 1,290 for
    // 9,313,578: its operations, own-terminal step and turn refusal; the split engine stays lazy, no new eager file.
    // 9,320,000 (next 5,000 boundary): main 3fae06ff5 measures 9,314,577. Test commands resolved as they run (test-pin
    // review, 2026-11-01): the affected-module walk the gate and its removed-suite check share (delivery-evidence.mjs
    // +696) and the reporter counting each node --test run (node-test-observation.mjs +571) add 1,279 for 9,315,856.
    // The resolution and the pin checks load only at a gate run; no new eager file.
    // 9,325,000 (next 5,000 boundary): main b91420f57 measures 9,315,856. Test files by Jest's __tests__ rule and
    // .cjs/.cts (code-delivery-tests.mjs +2,098), every root build system's commands with its diagnostics
    // (repository-test-command-inference.mjs +2,458), a command's optional ecosystem (external-command-policy.mjs +887)
    // and the malformed-manifest refusal (test-module-markers.mjs +137) add 5,640 for 9,321,496; no new eager file.
    // 9,330,000 (next 5,000 boundary): main ce4360779 measures 9,323,933. SF Guard M2 (SPEC-PSS-v1): the Story pin
    // at creation and the counting predicate passed to each approval reader (state.mjs +1,477, approval-chain.mjs
    // +856 with its labels, phase-retention.mjs +605, approval-authority.mjs +349) and phase-approval v3
    // (schema-migrations.mjs +675) add 3,962 for 9,327,895. The presence modules stay lazy; no new eager file.
    // 9,335,000 (next 5,000 boundary): main b77a02a1b measures 9,327,895. SF Guard M3 (SPEC-PSS-v1): the import-free
    // counting leaf presence/counted.mjs (+1,804, the one new eager file) and each person-step family's readers
    // counting through it (risk, test command, narrowing, test-run risk, evidence reuse, visual profile, witness, scope,
    // applicability, upstream and forward amendment decisions, plan corrections: +1,652) add 3,456 for 9,331,351.
    // The signer and the verifier stay lazy (presence/person-steps.mjs and person-records.mjs).
    // 9,340,000 (next 5,000 boundary): main 3a9becd53 measures 9,334,543. The optional
    // ledger.configurationHistory setting validated where the ledger is read (ledger-config.mjs +1,156) brings
    // 9,335,699; the automatic history cleanup itself loads only after a publication, no new eager file.
    // 9,340,000 holds: main 4fcc9bcde measures 9,335,699. SF Guard §10.5: an authorship claim read through the
    // counting leaf and withdrawals read by signed decision order (presence/counted.mjs +2,633), the scope,
    // completeness, applicability and slice readers using them (+271) and the --author flag (util.mjs +82) add 2,966
    // for 9,338,665. The claim's signer and verifier stay lazy; no new eager file.
    // 9,340,000 holds: SF Guard §10.6 signs reopen inside its transaction (state.mjs +624) and every live terminal
    // review over its card (action-authorization.mjs +582), adding 1,206 for 9,339,871; the signers stay lazy.
    // 9,345,000 (next 5,000 boundary): main 97966e04f measures 9,339,871. SF Guard §10.7 keeps a live review's
    // signature in its decision record and counts it at the readers: the risk, artifact-risk, dispute and appeal
    // readers and their schemas (phase-quality-risk.mjs +1,931, phase-appeals.mjs +1,574, the two schema files and
    // readers +896), the one-touch option (action-authorization.mjs +224) and the dispute warning (governance.mjs
    // +140) bring 9,343,716 (measured). The signer and verifier stay lazy; no new eager file.
    // 9,350,000 (next 5,000 boundary): main 445e82c5c measures 9,343,716. A completed workspace clone ignores
    // editor-only branch keys (VS Code's vscode-merge-base) and names the fact that changed when it refuses
    // (workspace-clone-claim.mjs +2,421, workspace.mjs +207), bringing 9,346,344 (measured); no new eager file.
    // SF Guard §10.8 (2026-11-02): the Story summaries keep their signature, sealed beside an immutable summary or
    // on a test-recovery entry: the seal lookup and actor-less verdict (person-records.mjs), the review-safe seal
    // rule (approval-check.mjs), the counted selection and risk reads, and the publish/submit hooks (state.mjs)
    // add 2,861: 9,349,205 measured on 67aaccc3e. No new eager file.
    // 9,355,000 (next 5,000 boundary): main 2f5188340 measures 9,349,855. SF Guard §10.9 reads a commit's parents
    // and committer time for a configuration approval's seal (git.mjs commitShape +651) and adds the
    // --state-records flag (util.mjs +17): 9,350,523 measured. The seal reader, signer and state check stay lazy.
    // 9,355,000 holds: a base per repository at Story start. The isolated start reads the launch checkout's own
    // base from the parsed --from-branch selection (start.mjs +1,275) and an interactive start asks per repository
    // when no branch is shared (capability-start.mjs +2,515), adding 3,790. No new eager file.
    // 9,358,000 (measured, not the next boundary): main 7e13deb5 already measures 9,355,282. SF Guard §10.10 keeps
    // each repository store's, adjudication's and intake review's signature with its record: the convergence v4
    // decision block (convergence.mjs +759, one resealing step for every convergence migration in
    // schema-migrations.mjs -323), the repair authorization's and agents lock's in-record touch (fault-repair.mjs
    // +574, agents.mjs +317), the intake review's witness receipt and signed-decision filter
    // (test-recovery-admission.mjs +675, test-recovery-store.mjs +195), the counted readers (convergence-context.mjs
    // +213, capability-context.mjs +81, test-recovery-runtime.mjs +80, counted.mjs +31) and the pin taken before
    // intake (state.mjs +85): 9,357,969 measured. The seals, signer and verifier, the counted convergence view and
    // the intake reviews stay lazy.
    // 9,437,100 (measured): main f2bfd18d measures 9,454,120 on commands/start.mjs, up 96,151 from 4ab1905f's 9,357,969.
    // workflow-task.mjs (17,115, eager through state.mjs since 4f7fe732) now loads only when a commit is classified as
    // a decision, and assertApprovalSubmitted moved out of lifecycle-worktree.mjs, which leaves 77,916 of real growth:
    // repository commit policy (4c79a2b8 +23,659, mostly util.mjs, ledger.mjs and git.mjs), bounded repair and its
    // routes (e3020349 +6,795, bb27049e +15,121, phase-finding-policy.mjs +16,043 in all), opt-in application review
    // and code delivery's hand-off (6843eef5 +11,793, 638b83ce +1,767, code-delivery-policy.mjs +7,561 in all) and
    // smaller. Where each repository's base came from adds 1,181 (capability-branches.mjs +1,034,
    // commands/start.mjs +79, state.mjs +68), for 9,437,066. No new eager file on this entry.
    // 9,442,450 (measured 9,442,399 on main dd541609b): Spec Studio. Its slices, sources and sharing check stay lazy; its 5,304 of
    // real growth is the checks a specification source shares with document input and its pinned originals in the
    // document catalog (documents-read.mjs and documents.mjs, +3,089 net), inherited constraints in USER-STORY.md (state.mjs
    // +734), the shared-draft record families (schema-migrations.mjs +716), a specification's own document owner
    // (document-storage.mjs +347), start.mjs +271, spec author's routes (command-registry.mjs +134) and an option (util.mjs +13). No new eager file.
    // 9,460,900 (measured 9,460,870): SPEC-ENVF v2. The scanner is synchronous and every gate needs its value check, so
    // config-values.mjs (with the link helpers from the lazy share-check.mjs) and local-config-policy.mjs are new eager files.
    // 9,461,200 (measured 9,461,152): a /sf-docs route keeps its topic (copilot-guidance.mjs +282). No new eager file.
    // 9,462,000 (measured 9,461,973): a run asks for the Node its repository names [TCE:REQ-035] (state.mjs +314,
    // runtime-readiness.mjs +267, test-recovery-runtime.mjs +240). The lookup itself is lazy; no new eager file.
    // 9,465,600 (measured 9,465,592): each packaged agent's earlier bytes stay known, so an upgrade can give it a terminal in
    // VS Code (packaged-asset-history.mjs +3619). No new eager file.
    // 9,466,700 (measured 9,466,698): policy.plainChatSecrets (capabilities.mjs +835), the remote a frozen alias stands for
    // (git-remote-diagnostics.mjs +249) and two routed subcommands (command-registry.mjs +22). The guard's reads are lazy; no new eager file.
    // 9,469,650 (measured 9,469,641): values in sentences and SQL (config-values.mjs +1290, secrets.mjs +452), Epic sources get a
    // Story document's check (epic-sources.mjs +1037) and each route says where the bytes go (documents.mjs +164). The check itself stays lazy; no new eager file.
    // 9,484,450 (measured 9,484,368): no rerun on unchanged code (verification/attempts.mjs +7637, state.mjs +5581) and a Story's test scope
    // (code-delivery-policy.mjs +441, narration/messages.mjs +333, code-delivery-tests.mjs +291, test-recovery-intake.mjs +110,
    // command-registry.mjs +168, command-skills.mjs +59). Each gate runs them; the scope command and file selection stay lazy, no new eager file.
    // 9,486,450 (measured 9,486,361 with the Auto Candidate's run standing): auto-candidate.mjs +1443, state.mjs +377,
    // verification/attempts.mjs +173. What runs it (local-test-runs.mjs) stays lazy; no new eager file.
    // 9,486,550 (measured 9,486,530): clarifications.mjs +163, so an agent carries on once `ask_user` returns.
    // 9,492,300 (measured 9,492,217 with the honest approval list's hold words, approval-check.mjs, and the decisions page's refusal in the guard): every suite of a gate's run is recorded and reported (state.mjs +1984), a test file that
    // failed outside its tests and a run with no tests are named (test-execution-diagnostics.mjs +1330), and SwiftPM's empty report and a
    // reactor's modules are read (code-delivery-tests.mjs +1102). The reading and reporting stay lazy; no new eager file.
    // 9,492,350 (measured 9,492,324): a code step's handoff points to its early checks (test-execution-handoff.mjs +630). The checks stay lazy; no new eager file.
    // 9,492,700 (measured 9,492,668): a failed run names `tests base`, and a base run hashes its own worktree (state.mjs +229, command-registry.mjs +8). The run itself stays lazy; no new eager file.
    // 9,492,850 (measured 9,492,843): TypeScript tests under a runner SFlow cannot read hear its name (delivery-evidence.mjs +175). The refusal itself is lazy; no new eager file.
    // 9,497,300 (measured 9,497,262, commands/phase-lifecycle.mjs): plan accounts settling convergence paths, and the test plan's early checks and re-pin words.
    // 9,499,900 (measured 9,499,891, commands/phase-lifecycle.mjs): convergence-record family v6 keeps a replaced answer (convergence.mjs, schema-migrations.mjs, story reads none of it eagerly).
    // 9,500,250 (measured 9,500,246, commands/phase-lifecycle.mjs): a plan amendment holds the hash it accounted for (plan-amendments.mjs, plan-accounts.mjs). The reading stays lazy; no new eager file.
    // 9,524,400 (measured 9,524,302, commands/phase-lifecycle.mjs): the runner table's eager data, accepted for now (test-runners.mjs), with the decisions and fixes above.
    // 9,526,350 (measured 9,526,318, commands/phase-lifecycle.mjs): the Node-version failure offers one choice: its item (decision-list.mjs +1641), the refusal's first step (refusal-remediation.mjs +921, state.mjs +760), recovery's lead (recovery-plan.mjs +665). What reads and records it stays lazy (node-pin.mjs).
    // 9,527,700 (measured 9,527,624, commands/phase-lifecycle.mjs): a publish after a publish says so (phase-lifecycle.mjs +1120, phase-publish-if-ready's route stays lazy; the check itself is lazy, phase-publication-unchanged.mjs).
    // 9,541,650 (measured 9,541,593, commands/phase-lifecycle.mjs): one catalog of a person's steps (person-step-catalog.mjs, less what moved out of command-skills.mjs, copilot-mutation-guard.mjs, copilot-answer-binding.mjs, presence/person-steps.mjs and state.mjs). A row per decision, read on every hook, so not lazy.
    // 9,544,300 (measured 9,544,261, commands/phase-lifecycle.mjs): a held readiness and `act` give the step sheet's next (step-sheet-route.mjs, now read by agent-output.mjs). The sheet itself stays lazy.
    // 9,544,400 (measured 9,544,375): a held route's reason leads with the list's headline (step-sheet-route.mjs +114).
    // 9,528,000 (measured 9,527,964, commands/phase-lifecycle.mjs): a decision with nobody's word behind it names the person's route (copilot-mutation-guard.mjs +264).
    // 9,529,700 (measured 9,529,648, commands/phase-lifecycle.mjs): a run reused on the same source tree keeps its evidence: read from its own record (phase-execution-evidence.mjs +1400, evidence-consistency.mjs +280), and the conformance refusal says what the record reads (upstream-routes.mjs, decision-list.mjs). The outlook itself stays lazy (evidence/clause-outlook.mjs).
    // 9,530,250 (measured 9,530,227, commands/phase-lifecycle.mjs): a failed test's first route is its repair, with the runtime question a command answers (refusal-remediation.mjs, state.mjs), and a gate under another Node on PATH says so (copilot-mutation-guard.mjs).
    // 9,546,700 (measured 9,546,659, commands/phase-lifecycle.mjs): the catalog and step sheet with the routes above, on one branch.
    // 9,547,900 (measured 9,547,846, commands/phase-lifecycle.mjs): a dirty checkout, an appeal and a chain each name the route that clears them (refusal-remediation.mjs, copilot-mutation-guard.mjs, lifecycle-worktree.mjs).
    // 9,548,000 (measured 9,547,962): a witness names its page and a not-yet one names no command (guard, decision-list, step-sheet).
    // 9,548,300 (measured 9,548,249): a .nvmrc naming a Node not installed here offers the change (test-plan, decision-list, state, recovery-plan).
    // 9,548,400 (measured 9,548,359): the printed review names a flaky command (print-phase-review.mjs); finding one stays lazy (verification/flaky-runs.mjs) [CQF:REQ-013].
    // 9,549,500 (measured 9,549,468): a non-code step's runs are bound into its packet and read by their counts (state.mjs +756, story-lineage.mjs +280,
    // evidence-consistency.mjs +167); running and binding them stays lazy (verification/repository-tests.mjs) [CQF:REQ-010, REQ-012].
    // 9,552,400 (measured 9,552,346): documentation is hashed apart from the code a run's reuse and binding compare (state.mjs sourceTreeDigests,
    // delivery-evidence.mjs, phase-execution-evidence.mjs, attempts.mjs, story-lineage.mjs, code-delivery-tests.mjs) [CQF:REQ-011]. The gates themselves read it, so not lazy.
    // 9,553,000 (measured 9,552,936): a Story on only its new tests runs, at its last step that runs tests, the existing tests that import a changed module
    // (state.mjs, attempts.mjs); finding them stays lazy (verification/test-scope-selection.mjs) [CQF:REQ-017].
    // 9,555,300 (measured 9,555,270, commands/phase-lifecycle.mjs): a lint, static-analysis or security command names its finding reader,
    // gate and SonarQube project (external-command-policy.mjs +5270), codeDelivery.staticAnalysis (code-delivery-policy.mjs +1205) and
    // policy.staticAnalysis (capabilities.mjs +546) [CQF M4]. Configuration is read synchronously everywhere; no new eager file.
    // 9,558,400 (measured 9,558,348, commands/phase-lifecycle.mjs): a code step runs its finding commands in the publish check, reads
    // their reports there and at submit (state.mjs +2697), and its publication says what the loop let through (phase-lifecycle.mjs +381).
    // The loop, its readers and its records stay lazy (findings/code-step.mjs); no new eager file.
    // 9,559,100 (measured 9,559,071, commands/phase-lifecycle.mjs): decision finding-risk is a person's step (person-step-catalog.mjs +454,
    // narration/messages.mjs +253, command-registry.mjs +16). The command itself stays lazy; no new eager file.
    // 9,559,600 (measured 9,559,566, commands/phase-lifecycle.mjs): codeDelivery.staticAnalysis.codeql (code-delivery-policy.mjs +294)
    // and submission reading CodeQL's alerts with no scanner of its own (state.mjs +201). The SonarQube and GitHub reads stay lazy
    // (findings/servers.mjs); no new eager file.
    // 9,559,800 (measured 9,559,794, commands/phase-lifecycle.mjs): the findings refusals name their catalog entry (finding-catalog.mjs +228).
    // 9,560,350 (measured 9,560,305, commands/phase-lifecycle.mjs): the findings loop loads only for a step with a scanner or CodeQL
    // (state.mjs +511), so every other step's publication and submission imports none of it.
    // 9,560,700 (measured 9,560,664, commands/phase-lifecycle.mjs): a later step reads CodeQL's alerts too (state.mjs +359). The read stays lazy.
    // 9,560,850 (measured 9,560,832, commands/phase-lifecycle.mjs): the findings loop loads from the CLI source, out of the VS Code
    // gateway bundle, which it had grown by 28 modules (state.mjs +168).
    // 9,556,250 (measured 9,556,218, commands/phase-lifecycle.mjs): a code step's departures [CQF M2]: their files in the candidate and in coverage
    // (plan-amendments.mjs, candidate-scope.mjs, specifications.mjs), a rejected one's refusal (delivery-evidence.mjs), the approval's stage and hold
    // words (state.mjs, approval-check.mjs, decision-list.mjs), prepublish and publication recording them (phase-lifecycle.mjs), the catalog row and the
    // command (person-step-catalog.mjs, command-registry.mjs, command-skills.mjs, messages.mjs). The records and their reads stay lazy (departures.mjs, departure-records.mjs).
    // 9,573,550 (measured 9,573,488, commands/phase-lifecycle.mjs): test results carry forward, departures and the findings loop merged; each one's growth is above.
    // 9,562,800 (measured 9,562,771, commands/phase-lifecycle.mjs): the dependency audits' readers and a report the tool prints
    // (external-command-policy.mjs +1564, state.mjs +375) [CQF:REQ-050]. The readers and manifest comparison stay lazy (findings/).
    // 9,563,550 (measured 9,563,521, commands/phase-lifecycle.mjs): the approval waits on a vulnerable package the Story added
    // (state.mjs +750) [CQF:REQ-052]. The hold loads from the CLI source only when a gate recorded one; no new eager file.
    // 9,564,700 (measured 9,564,651, commands/phase-lifecycle.mjs): a plain lint, static-analysis or security command whose program
    // is not here is recorded as unavailable, not failed (state.mjs +1130) [CQF:REQ-054]; one refusal fewer (refusal-remediation.mjs -44).
    // 9,565,550 (measured 9,565,535, commands/phase-lifecycle.mjs): an advisory scanner that reads no findings and reported problems
    // is warned, not failed (state.mjs +662, lifecycle-evidence-policy.mjs +222) [CQF decision 6]. Import's readers stay lazy.
    // 9,565,850 (measured 9,565,815, commands/phase-lifecycle.mjs): the review text shows the findings and the required checks
    // (print-phase-review.mjs +280) [CQF:REQ-055]. Their reads stay lazy (findings/required-checks.mjs).
    // 9,566,000 (measured 9,565,950, commands/phase-lifecycle.mjs): the vulnerable new dependency hold names its catalog entry
    // (finding-catalog.mjs +135) [CQF:REQ-052].
    // 9,578,650 (measured 9,578,606, commands/phase-lifecycle.mjs): security checks merged too; their growth is above.
    // 9,556,800 (measured 9,556,715, commands/phase-lifecycle.mjs): a test command names its coverage report and its attempt keeps it beside
    // the test report (external-command-policy.mjs, state.mjs, attempts.mjs, node-test-observation.mjs); reading and keeping one stays lazy
    // (verification/coverage-reports.mjs) [CQF:REQ-030].
    // 9,558,300 (measured 9,558,278): its changed lines are shown in the printed review and an enforced minimum refuses publication
    // (code-delivery-policy.mjs, print-phase-review.mjs, phase-review.mjs, state.mjs); the read model stays lazy (verification/changed-line-coverage.mjs) [CQF:REQ-031].
    // 9,558,950 (measured 9,558,916): both coverage modules load from the CLI source, out of the VS Code gateway bundle, which they had
    // grown past its module ceiling (state.mjs, attempts.mjs, phase-review.mjs).
    // 9,560,350 (measured 9,560,306): the assertion and edge-case check runs at publication in warn mode, and the review shows it
    // (delivery-evidence.mjs, state.mjs, phase-review.mjs, print-phase-review.mjs); the check stays lazy (verification/corner-case-obligations.mjs) [CQF:REQ-032].
    // 9,560,500 (measured 9,560,457): the review says how many tests prove each criterion and whether each asserts
    // (phase-review.mjs, print-phase-review.mjs); the proof stays lazy (verification/criterion-proof.mjs) [CQF:REQ-033].
    // 9,586,200 (measured 9,586,127, commands/phase-lifecycle.mjs): test adequacy merged too; its growth is above.
    // 9,556,350 (measured 9,556,345): the departure reads load from the CLI source, outside the VS Code gateway bundle (state.mjs, delivery-evidence.mjs).
    // 9,586,300 (measured 9,586,254, commands/phase-lifecycle.mjs): the departure modules load from the CLI source, out of the VS Code gateway bundle.
    // 9,563,900 (measured 9,563,852, commands/phase-lifecycle.mjs): the findings command and its import preview classify in
    // command-registry.mjs (+1,227), map to /sf-findings (command-skills.mjs +29) and take --all-repositories (util.mjs +70); a
    // Story's picked findings are clauses of its source (scope/extract.mjs, state.mjs findingsSection); the release registries
    // know the findings-remediation workflow (packaged-asset-history.mjs, packaged-workflow-history.mjs +631). The command, its
    // workbook reader and its register stay lazy.
    // 9,589,300 (measured 9,589,274, commands/phase-lifecycle.mjs): the security and TLM findings register merged too; its growth is above.
    // 9,587,450 (measured 9,587,396, commands/phase-lifecycle.mjs): a code step's composed context names a departure for what the approved
    // documents lack, not an upstream issue (phase-authoring-contract.mjs, phase-prompt-composer.mjs) [CQF:REQ-020].
    // 9,590,450 (measured 9,590,416, commands/phase-lifecycle.mjs): the paid run's two fixes merged too.
    // 9,606,400 (measured 9,606,339, commands/phase-lifecycle.mjs): spec–code sync M1 decides deviated and unplanned
    // conformance rows (upstream-routes.mjs, conformance-verdicts.mjs, conformance-readiness.mjs, decision-list.mjs, the
    // pinned spec.conformanceDifferences in specifications.mjs and the two leaves above), +15,905 on every entry [SCS:REQ-010].
    // 9,592,050 (measured 9,592,001, commands/phase-lifecycle.mjs): what the person asked for, copied at prepublish and publication
    // (phase-lifecycle.mjs +1097) and policy.typedFocus (capabilities.mjs +470) [SCS:REQ-041]. The records and the hook's local
    // record stay lazy (asked-for-records.mjs, asked-for.mjs); no new eager file.
    // 9,592,800 (measured 9,592,777, commands/phase-lifecycle.mjs): an instruction left unaccounted holds the code step's approval
    // [SCS:REQ-042]: the approval's stage and hold words (state.mjs +422, approval-check.mjs +165), the list's item for it
    // (decision-list.mjs, step-sheet.mjs), `departure account` (command-registry.mjs +155, messages.mjs +199). The command and the
    // records stay lazy (commands/departure.mjs, asked-for-records.mjs); no new eager file.
    // 9,606,600 (measured 9,606,573, commands/phase-lifecycle.mjs): a decisions record that only drafted an amendment says
    // nothing was recorded (narration/messages.mjs), and an amendment's changedClauses settle a row (upstream-routes.mjs) [SCS:REQ-020, REQ-023].
    // 9,606,900 (measured 9,606,853, commands/phase-lifecycle.mjs): an environment's checks mapping knows the phase's commands a
    // call does not run, such as the SonarQube scan only submit runs (state.mjs effectiveEnvironmentQualityCommandCatalog), and
    // a finding on no file keeps its reader's verdict (findings/model.mjs markNewCode) [CQF:REQ-048].
    // 9,609,500 (measured 9,609,463, commands/phase-lifecycle.mjs): spec–code sync M1, M2 and M4 with the SonarQube fix above, each one's growth above,
    // and main's corrected comment on the unstated-difference check (conformance-readiness.mjs +33).
    // 9,616,300 (measured 9,616,278, commands/phase-lifecycle.mjs): an amendment from "Update the spec" lists revalidation rows instead of
    // reopening (state.mjs +4544 with its approval's records, forward-amendments.mjs +625, source-review-policy.mjs +153, upstream-routes.mjs
    // +124, person-step-catalog.mjs +34) and scope staleness takes the carriers it is given (scope/revisions.mjs +1335) [SCS:REQ-022]. Which
    // "still holds" carries evidence stays lazy (scope/carried-evidence.mjs); no new eager file.
    // 9,612,150 (measured 9,612,125, commands/phase-lifecycle.mjs): a command a runner stopped is reported once nothing of its
    // process group is left, at the quality runner's, Git's and the other group runners' close, and platform-process.mjs says
    // which child is a real one (+2,662); the sweep itself stays lazy (git-child-groups.mjs endStoppedProcessGroup) [TCE:REQ-034].
    // 9,618,950 (measured 9,618,904, commands/phase-lifecycle.mjs): both of the above together, each one's growth as measured.
    // 9,617,000 (measured 9,616,931, commands/phase-lifecycle.mjs): a "still holds" answer keeps the person's name beside the
    // actor key (state.mjs +263, scope/revisions.mjs +37) in its new record family (schema-migrations.mjs +346) [SCS:REQ-022].
    // 9,619,600 (measured 9,619,550, commands/phase-lifecycle.mjs): both of the above together, each one's growth as measured.
    // 9,620,750 (measured 9,620,721, commands/phase-lifecycle.mjs): policy.plainChatEdits folds one way across three values
    // (capabilities.mjs +987) [PCR:REQ-013], the prompts command classifies and routes to /sf-prompt-log (command-registry.mjs
    // +147, command-skills.mjs +30) and the redactor's token shapes are exported for a prompt's secret check
    // (git-remote-diagnostics.mjs +7) [PCR:REQ-002, REQ-003]. The plain-chat
    // guard, the prompt log and the command stay lazy (copilot-plain-chat.mjs, plain-chat-prompts.mjs, commands/prompts.mjs).
    // 9,621,100 (measured 9,621,059, commands/phase-lifecycle.mjs): init and bootstrap write an application checkout's Copilot
    // hooks (config.mjs +251, bootstrap.mjs +27) and doctor --repair-hooks is a flag (util.mjs +60) [PCR:REQ-030]. The hooks
    // module stays lazy (repository-hooks.mjs).
    // 9,622,000 (measured 9,621,911, commands/phase-lifecycle.mjs): a requirement may borrow only the visual proof of an AC
    // that is also tested, and an AC called non-test while its own contract has a test slot is told so
    // (verification/intent.mjs +852).
    // 9,623,400 (measured 9,623,356, commands/phase-lifecycle.mjs): a verification step whose repository tests fail at
    // approval names the code step's return (state.mjs +1445) [PHR:REQ-003]. The plan that leads with it stays lazy
    // (refusal-remediation.mjs); no new eager file.
    // 9,625,300 (measured 9,625,286, commands/phase-lifecycle.mjs): planning prepublish routes missing clauses to the step
    // that defines them (phase-prepublish.mjs +1394, state.mjs +191), and a finding naming an earlier step's output is
    // that step's to correct (phase-resolution.mjs +345) [PHR:REQ-001]. No new eager file.
    // 9,633,450 (measured 9,633,437, commands/phase-lifecycle.mjs): code submission and approval apply publication's upstream
    // routes, a decided upstream issue settles the clause it names, and the plan's own corrections are named
    // (spec-coverage-preview.mjs +3789, upstream-routes.mjs +1461, state.mjs +1432, phase-resolution.mjs +912,
    // recovery-plan.mjs +557) [PHR:REQ-003]. No new eager file.
    // 9,633,650 (measured 9,633,634, commands/phase-lifecycle.mjs): the revalidation route is a placeholder the route filter
    // admits (forward-amendments.mjs +197); the stale-evidence routes stay lazy (evidence/terminal.mjs) [PHR:REQ-003].
    // 9,633,750 (measured 9,633,719, commands/phase-lifecycle.mjs): the ending reads every step as earlier for a decided
    // upstream issue (upstream-routes.mjs +85); the settlement itself stays lazy (evidence/evaluate.mjs) [PHR:REQ-003].
    // 9,638,400 (measured 9,638,359, commands/phase-lifecycle.mjs): a planning review finding about the approved
    // specification names that step and is raised there (source-grounded-review.mjs +1649, source-review-continuation.mjs
    // +1575, source-review-lifecycle.mjs +652, state.mjs +508, source-review-contract.mjs +256) [PHR:REQ-003]. No new eager file.
    // 9,645,250 (measured 9,645,218, commands/phase-lifecycle.mjs): a plan that falls short of the approved intent names the
    // clause's defining step and its correction (upstream-routes.mjs +2692, phase-prepublish.mjs +2402, phase-resolution.mjs
    // +910, verification/intent.mjs +411, specifications.mjs +267, state.mjs +177) [PHR:REQ-001]. No new eager file.
    // 9,647,900 (measured 9,647,872, commands/phase-lifecycle.mjs): a required after-step delivery holds only the Story's
    // ending; later steps are told (step-action-receipts.mjs +1424, step-actions.mjs +534, state.mjs +428,
    // phase-publication-readiness.mjs +210, submission-readiness.mjs +58) [PHR:REQ-003]. No new eager file.
    // 9,648,050 (measured 9,648,023, commands/phase-lifecycle.mjs): only an accepted risk settles a later obligation; why a
    // dismissal does not is said where the settlement is read (upstream-routes.mjs +151) [PHR:REQ-003]. No new eager file.
    // 9,649,950 (measured 9,649,923, commands/phase-lifecycle.mjs): a Story pins the owner-step checks at start, and the step
    // that defines the scope last holds its approval for each statement nobody dispositioned (phase-roles.mjs +860,
    // owed-decisions.mjs +548, state.mjs +492, approval-check.mjs +235); the check itself stays lazy (scope/authoring.mjs)
    // [PHR:REQ-002]. No new eager file.
    // 9,650,600 (measured 9,650,558, commands/phase-lifecycle.mjs): a code step's approval holds a criterion its own tests did
    // not verify (state.mjs +635); the judgment stays lazy (owner-step-evidence.mjs) [PHR:REQ-002].
    // No new eager file.
    // 9,651,100 (measured 9,651,050, commands/phase-lifecycle.mjs): readiness says a code step's approval waits for the
    // inspections of its own criteria (owed-decisions.mjs +492); the hold itself stays lazy (owner-step-evidence.mjs)
    // [PHR:REQ-002]. No new eager file.
    // 9,653,400 (measured 9,653,382, commands/phase-lifecycle.mjs): under recorded coverage the last code step's approval
    // refuses what the qualified ending would, with its routes (state.mjs +2332) [PHR:REQ-002]. No new eager file.
    assert.ok(closure.bytes <= 9_653_400, `${file} exceeds the 9 MB eager-source budget (${closure.bytes} bytes)`);
    assert.equal(closure.files.has(path.join(sourceRoot, 'workflow-task.mjs')), false, `${file} eagerly loads the workflow task record`);
  }
});

test('root dispatch stays small and orchestration entrypoints load their handlers lazily', async () => {
  const root = await graph('cli-entry.mjs');
  // 39: cli-entry.mjs parses --context-root for every command through execution-context-scope.mjs (f62c3107).
  // 40: creation-context.mjs (0b0dc559, shared Story creation captures) joined root dispatch; main 97805fde was already at 40.
  assert.ok(root.files.size <= 40, `root dispatch loads ${root.files.size} local files`);
  // 770,000 (next 5,000 boundary): 747,457 at 3fd3db0b grew to 768,310 across utility-entry.mjs (7e50d127, decided
  // before repository discovery), execution-context-scope.mjs (f62c3107) and small additions to cli-entry and Git transport.
  // 775,000: 769,967 grew to 772,758 with the source-review batching (f79ec1fa, 5a25abe8, d18afdc6): git-fact-cache.mjs
  // +1,810, util.mjs +713, utility-entry.mjs +268; no new file.
  // 780,000: 774,999 at main 4a8e6c42 grew to 775,081 with the --debug boolean flag (util.mjs) and the app suggest
  // and --application-file registry entries (command-registry.mjs); no new file.
  // 785,000: 779,760 at 2fbfc887 grew to 780,496 with the env files operation classes (command-registry.mjs, read or
  // mutation per action) and the --personal, --from-template and --clear boolean flags (util.mjs); no new file.
  // 790,000: main 97805fde was already 788,225, over 785,000 without a recorded raise. From 780,506 at 322e75e3:
  // creation-context.mjs +3,297 (new, 0b0dc559), git-execution.mjs +808 (8827f9fe, 0b0dc559), work-id.mjs +738,
  // utility-entry.mjs +401 and configuration-assets.mjs +232 (94173271), util.mjs +619 (4838febb), cli-entry.mjs +528,
  // read-scope.mjs +464 (94f42a8c), authoring-skills.mjs +450 (5c6df7fa) and smaller. The per-turn entry rule in
  // copilot-mode.mjs (docs/SPEC-STAGING-PERMISSIONS-v1.md) adds 231 to 788,456.
  // 795,000: main 810418a6 was 790,885, over 790,000 without a recorded raise: creation-context.mjs +875,
  // git-remote-diagnostics.mjs +622 and cli-entry.mjs +56 (b3c8bf7f..810418a6, cold Story creation and configuration
  // reuse); no new file.
  // 800,000: main 507ade77 was 794,526; the read operations of Jira, Initiative, Epic, knowledge, harness, regression
  // and init --check, so a read-only Copilot turn may run them (command-registry.mjs, +4,101), give 798,627. No new file.
  // 800,000: the enrollment blocker fix and its routes (29d5e906, 946f9716) take 795,000 to 795,379:
  // cli-entry.mjs +465 (routes for an unavailable workspace) and util.mjs +388 (Git started in a missing folder
  // names it); no new file. Both together at the merge (main 24466a14 + work-turns): 799,406.
  // 805,000: the 2026-10-24 round takes main 4a72b80f's 799,730 to 802,311: command-registry.mjs +1,958 (the new wm,
  // explain and gateway entries) and util.mjs +623 (free-text options and new flags); no new file.
  // 810,000: main a2719813's 804,965 grows to 805,409 with `sync <INTENT-ID>` (SPEC-OAP M3): util.mjs +220
  // (isTransportIntentId), cli-entry.mjs +193 (its routing exclusion) and command-registry.mjs +31 (the sync
  // module); no new file.
  // 815,000: main b6fd24fae (SDA M5) measures 805,059; lease identity for shared and restored homes (lease-liveness.mjs
  // +4,980: the owner's PID namespace, and the hardware confirmed once before a dead owner is taken over, a synchronous
  // check inside the lease assessment) gives 810,039. No new file.
  // 830,000: main fc7b10482 measures 814,289; the sweep's read index fix (batch 4) gives 825,008: file-lease.mjs
  // +5,568 (a cache lease owner judged by machine identity and process start, and its review and reviewed
  // release by path, A5), git-fact-cache.mjs +3,658 (remotes read from a configuration file as Git reads it,
  // U1) and git-remote-diagnostics.mjs +1,493 (a refresh failure's cause and way out, A3). No new file.
  // 835,000: main 7b8cad8f1 measures 829,463; util.mjs +762 (a Windows 8.3 short name compared as the filesystem
  // spells it, a command-line file from another spelling of the repository, trace frames on Windows) gives 830,225.
  // No new file.
  // 836,000: main 6ad7b77af measures 834,926; SF Guard G2's two guard actions (reconcile, a read, and
  // stamp-agents, a person's step) add command-registry.mjs +107, giving 835,033. No new file.
  // 837,000: main 4fcc9bcde measures 835,305; SF Guard's --author and --github-login flags (util.mjs +82) and the
  // repository person-step gate at dispatch (cli-entry.mjs +924, a command and verb check before any SF Guard module
  // loads, SPEC-PSS-v1 §10.6) give 836,311. No new file.
  // 856,100 (measured): main f2bfd18d measures 856,068, up 19,581 from 4ab1905f's 836,487. Repository commit policy
  // (4c79a2b8, 3d1925e3) is most of it: util.mjs +14,078, because every Git mutation passes its admission check
  // inside the synchronous run(), so it cannot be a lazy import (its writers already are); platform-process.mjs +1,533,
  // git-execution.mjs +665, package-root.mjs +594 replacing git-isolation-paths.mjs -1,808 in the graph. Then
  // schema-migrations.mjs +2,382 and command-registry.mjs +2,052 from the commands and records added since. The file
  // count holds at 39.
  // 856,950 (measured 856,931): Spec Studio's five record families (schema-migrations.mjs +716), spec author's own
  // routes and read actions (command-registry.mjs +134) and one option (util.mjs +13). Neither can load later: every command reads them to dispatch.
  // 856,957 (measured 856,957): the screen read action (command-registry.mjs +12) and --for-person (util.mjs +14), for the same reason.
  // 856,970 (measured 856,969): env files classify in command-registry.mjs, which every command reads to dispatch.
  // 857,250 (measured 857,240): git-remote-diagnostics.mjs +249 and command-registry.mjs +22, as start. Every command reads them to dispatch.
  // 857,450 (measured 857,408): `story test-policy scope` classifies in command-registry.mjs (+168), which every command reads to dispatch.
  // 858,350 (measured 858,295): convergence-record family v5's step and seal (schema-migrations.mjs +870). Every command reads the registry to dispatch.
  // 858,800 (measured 858,796): convergence-record family v6's step and seal (schema-migrations.mjs +501). Every command reads the registry to dispatch.
  // 858,810 (measured 858,804): `tests node` classifies in command-registry.mjs (+8), which every command reads to dispatch.
  // 858,817 measured 2026-11-07: review-source status and check take --for-agent as an output option.
  // 858,851 measured 2026-11-08: tests summary --latest is declared a flag (util.mjs +34) [CQF:REQ-015].
  // 858,850 (measured 858,833): decision finding-risk classifies as a person's mutation (command-registry.mjs +16).
  // 859,700 (measured 859,660): `departure`, `decision departure` and `appeal prepare`, which now records, classify in command-registry.mjs (+843), which every command reads to dispatch.
  // 859,750 (measured 859,710): the same three merged: --latest, decision departure and decision finding-risk.
  // 860,150 (measured 860,120): the findings command, its subcommands and import preview classify in command-registry.mjs (+1,217),
  // and --all-repositories is a flag (util.mjs +70), which every command reads to dispatch.
  // 861,050 (measured 861,007): the security and TLM findings register merged too; its growth is above.
  // 861,200 (measured 861,162): `departure account` is a mutation the code step runs [SCS:REQ-042] (command-registry.mjs +155), which every command reads to dispatch.
  // 861,650 (measured 861,626): a stopped remote Git child's group is swept until it is gone (git-execution.mjs +276), and
  // platform-process.mjs, the process owner, says which child is a real one (+188); every command loads both to dispatch.
  // The sweep itself stays lazy (git-child-groups.mjs) [TCE:REQ-034].
  // 861,550 (measured 861,508): the amendment-revalidation record family (schema-migrations.mjs +346). Every command reads the registry to dispatch.
  // 862,000 (measured 861,972): both of the above together, each one's growth as measured.
  // 862,150 (measured 862,126): the prompts command classifies in command-registry.mjs (+147) and the redactor's token
  // shapes are exported (git-remote-diagnostics.mjs +7) [PCR:REQ-002]; every command reads both to dispatch.
  // 862,200 (measured 862,186): doctor --repair-hooks is a flag (util.mjs +60) [PCR:REQ-030], which every command reads to dispatch.
  assert.ok(root.bytes <= 862_200, `root dispatch loads ${root.bytes} source bytes`);
  assert.equal(root.files.has(path.join(sourceRoot, 'git.mjs')), false);
  assert.equal(root.files.has(path.join(sourceRoot, 'config.mjs')), false);
  // Only the pause-checking entries and Story creation read these; most commands never do.
  for (const file of ['copilot-mode.mjs', 'creation-context.mjs']) {
    assert.equal(root.files.has(path.join(sourceRoot, file)), false, `root dispatch eagerly loads ${file}`);
  }
  for (const entry of ['commands/session-entry.mjs', 'commands/choices-entry.mjs']) {
    assert.equal((await graph(entry)).files.size, 1, `${entry} eagerly imported an implementation`);
  }
});

test('the common session projection does not import attach, state stores or publication writers', async () => {
  const current = await graph('commands/session-current.mjs');
  for (const file of ['commands/session.mjs', 'state-stores.mjs', 'state.mjs', 'workspace.mjs', 'story-publication-service.mjs',
    'phase-finding-policy.mjs', 'lifecycle-worktree.mjs']) {
    assert.equal(current.files.has(path.join(sourceRoot, file)), false, `session current eagerly loads ${file}`);
  }
  assert.ok(current.files.size <= 220, `session current reaches ${current.files.size} files; old session handler reached 429`);
  // 3,905,000: main cf33907d measures 3,898,542; plan corrections as the plan approver's own terminal step and an
  // upstream issue raised from /sf-decide add 1,906 for 3,900,448 (copilot-mutation-guard.mjs, command-skills.mjs).
  // 3,910,000: main 80f74694 measures 3,901,751; who decides for a step with no approval group (approval-fallback.mjs,
  // through scope/decisions.mjs and plan-row-corrections.mjs) and the decide command listing return only where it
  // runs (upstream-routes.mjs, upstream-issues.mjs) add 4,444 for 3,906,195.
  // 3,915,000: main fddafbe0 measures 3,906,195; the merged-base, after-closing and early-code helpers in git.mjs
  // and their use in state.mjs and delivery-evidence.mjs add 6,634 for 3,912,829.
  // 3,920,000: main f8cbcdc3 measures 3,914,102; plan corrections for tests delivered under other names, the approval
  // hint for a clone that is behind and the cancelled-Story refusal add 3,842 for 3,917,944 (plan-row-corrections.mjs,
  // sequence.mjs, lifecycle-transitions.mjs, narration/messages.mjs, command-skills.mjs).
  // 3,935,000: main 6f0e9741 measures 3,919,408; the approver refresh (a new accepted snapshot revision kind in workflow-snapshots.mjs, +13,280: its capture, replay and dialect, with its contracts loaded lazily; its review-safe commit in approval-check.mjs, +2,614; its registry, terminal-step, refusal and state entries) adds 14,512 for 3,933,920, no new file.
  // 3,950,000: main 0c7ca31b measures 3,934,328; the validator refusals that quote what an author wrote and the step-entry
  // contract sentences add 11,124 for 3,945,452 (draft-diagnostics, specifications, verification, phase-authoring-contract).
  // 3,955,000: main 78dd99a3 measures 3,949,562; the apm command's registration (command-registry.mjs,
  // command-skills.mjs) adds 660 for 3,950,222; its reader and command load only when apm runs.
  // 3,965,000: main 2f2069e83 measures 3,950,222; SDA M1's outcome classes (outcome-classes.mjs, util.mjs),
  // push-operation matching (transport-intents.mjs), the source inspection facade (source-inspection.mjs, through
  // repository-subject-index.mjs) and named push leases (git.mjs) add 9,922 for 3,960,144. Two new files.
  // 3,980,000: SDA M3 measures 3,979,930 (the lease liveness proof (lease-liveness.mjs: machine identity, owner start time, the shared owner predicate) behind every subject lock and registry lease).
  // 3,985,000: SDA M4 measures 3,980,217: SDA M4's lifecycle authority adapter (sda/story-branch-authority.mjs, sda/lifecycle-authority-contract.mjs, sda/shared-state-contract.mjs), through which recovery and test-recovery reads observe the subject branch; the publication writer it wraps loads only on a transition.
  // Still 3,985,000: registering apm marketplace init and apm publish as the person's own steps (command-registry.mjs,
  // command-skills.mjs, copilot-mutation-guard.mjs) adds 448 to SDA M4's 3,980,217, for 3,980,665.
  // 3,990,000: main 318c42d82 measures 3,980,854; lease identity for shared and restored homes (lease-liveness.mjs:
  // the owner's PID namespace, and the hardware confirmed once before a dead owner is taken over) adds 4,980 for
  // 3,985,834. No new file.
  // 3,995,000: main 6585b9b0b measures 3,987,796; locks only a person can end (sweep batch 1): each owner record's
  // hardware digest (lease-liveness.mjs, +1,970), the lock's read and its reviewed release in every refusal's details
  // (subject-lock.mjs, +1,365), the selection refusal keeping them (workspace-context.mjs, +321) and lock show-file
  // (command-registry.mjs, +90) add 3,746 for 3,991,542. No new file.
  // 4,000,000: main fc7b10482 measures 3,991,542; the read index fix (sweep batch 4) adds git-fact-cache.mjs +3,658
  // (remotes read from a configuration file as Git reads it, U1) and git-remote-diagnostics.mjs +1,493 (a refresh
  // failure's cause and way out, A3) for 3,996,693. No new file.
  // 4,005,000: main 8dd691421 measures 3,994,852; SDA on native Windows adds 6,647 for 4,001,499: the checkout-form
  // comparison of line endings Git converted (source-inspection.mjs +2,815, worktree-fingerprint.mjs +2,540),
  // canonical path spellings (util.mjs +1,271) and native realpath (git.mjs, environment-declaration.mjs +21). No new file.
  // 4,010,000: main a1aebf125 measures 4,002,119; the specification library (SPEC-SPA v1.3 S1) adds 2,962 for
  // 4,005,081: `spec author` in the operation registry (command-registry.mjs), its person-only actions as an
  // own-terminal step and a turn refusal (command-skills.mjs, copilot-mutation-guard.mjs), four boolean flags
  // (util.mjs) and the committed tree listing (git.mjs). Its handler loads only when `spec author` runs.
  // 4,015,000: main 5864f682f measures 4,009,498; a pinned specification slice named settled at the clarification
  // checkpoint (clarifications.mjs, SPEC-SPA v1.3 REQ-018) adds 936 for 4,010,434. No new file.
  // 4,015,000 holds: main f840dc33c measures 4,010,434; a specification split (SPEC-SPA v1.3 S5) adds 1,290 for
  // 4,011,724: its operations (command-registry.mjs), the publication as an own-terminal step (command-skills.mjs) and
  // its turn refusal (copilot-mutation-guard.mjs). Its handler loads only when `spec split` runs.
  // 4,020,000: main b91420f57 measures 4,013,246; the same test-file, root-build, ecosystem and malformed-manifest
  // rules add 5,630 for 4,018,876. No new file.
  // 4,025,000: main e9fd1a04a measures 4,018,876; SF Guard (SPEC-PSS-v1 M1) adds 2,070 for 4,020,946: the `guard`
  // command's operations (command-registry.mjs +801), its person steps as an own-terminal step and its /sf-guard
  // route (command-skills.mjs +590) and the policy file's history read (git.mjs +679). Its handler and the
  // src/presence/ modules load only when `guard` runs.
  // 4,030,000: main b77a02a1b measures 4,020,946; SF Guard M3 adds 4,473 for 4,025,419: the counting leaf
  // presence/counted.mjs (+1,804, the one new file) and the person-step family readers counting through it (+2,669).
  // Signing and verification load only on a Story SF Guard requires.
  // 4,035,000: main 4fcc9bcde measures 4,029,362; an authorship claim read through the counting leaf and
  // withdrawals read by decision order (presence/counted.mjs +2,633, its readers and the --author flag) add 2,966
  // for 4,032,328. The claim's signer loads only where SF Guard applies; no new file.
  // 4,035,000 holds: the live terminal review's signature (action-authorization.mjs +582, SF Guard §10.6) adds 582
  // for 4,032,910. The terminal-review and repository-step signers load only where SF Guard applies; no new file.
  // 4,036,300 (measured): main 7e13deb5 already measures 4,035,253; SF Guard §10.10's convergence v4 decision
  // block (convergence.mjs +759, schema-migrations.mjs -323), the repair authorization's in-record touch
  // (fault-repair.mjs +574) and the exported counting predicate (counted.mjs +31) add 1,041 for 4,036,294.
  // The counted convergence view and every signer load only where SF Guard applies; no new eager file.
  // 4,076,200 (measured): main f2bfd18d measures 4,102,083, up 65,789 from 4ab1905f's 4,036,294. Two modules joined only
  // through one small use each and have left again: phase-finding-policy.mjs (21,180, bb27049e, for the four-line
  // phaseCorrectionTargets, now in approval-fallback.mjs) and lifecycle-worktree.mjs (5,097, f2bfd18d, now imported
  // by the one async route that reads it), for 4,076,144. A dynamically imported module keeps every export in the
  // VS Code bundles, so assertApprovalSubmitted moved to approval-submitted.mjs first: left there, its import of
  // submission-readiness.mjs cost gateway-runtime.cjs 10 modules and 222,023 bytes. The remaining 39,850 is real:
  // util.mjs +14,078 (commit policy admission, see root dispatch), code-delivery-policy.mjs +7,561, config.mjs +3,330,
  // git.mjs +2,731, schema-migrations.mjs +2,382, command-registry.mjs +2,052 and smaller. No new eager file.
  // 4,077,050 (measured 4,077,020): the same schema-migrations.mjs +716, command-registry.mjs +134 and util.mjs +13 as root dispatch.
  // 4,099,600 (measured 4,099,593): SPEC-ENVF v2, the same two eager files as start, the gates in git.mjs and the scanner's value check.
  // 4,099,900 (measured 4,099,875): the same copilot-guidance.mjs +282 as start.
  // 4,103,500 (measured 4,103,494): the same packaged-asset-history.mjs +3619 as start.
  // 4,103,800 (measured 4,103,765): the same git-remote-diagnostics.mjs +249 and command-registry.mjs +22 as root dispatch.
  // 4,105,550 (measured 4,105,507): the same config-values.mjs +1290 and secrets.mjs +452 as start.
  // 4,106,650 (measured 4,106,564): the same code-delivery-policy.mjs +441, code-delivery-tests.mjs +291, test-recovery-intake.mjs +110,
  // command-registry.mjs +168 and command-skills.mjs +59 as start, less delivery-evidence.mjs -12.
  // 4,108,100 (measured 4,108,007): the same auto-candidate.mjs +1443 as start.
  // 4,108,200 (measured 4,108,176): the same clarifications.mjs +163 as start.
  // 4,108,950 (measured 4,108,915): auto-candidate.mjs +529 and git.mjs +210 [TCE:REQ-085]; the copying itself is in a lazy module.
  // 4,109,041 measured 2026-11-06: an approval hold carries the plan's rows, in state.mjs and approval-check.mjs.
  // 4,113,100 (measured 4,113,040 with those hold words and that refusal): the same test-execution-diagnostics.mjs +1330 and code-delivery-tests.mjs +1102 as start.
  // 4,113,250 (measured 4,113,223): the same delivery-evidence.mjs +175 as start.
  // 4,117,100 (measured 4,117,025): the same.
  // 4,119,700 (measured 4,119,654): the same convergence-record family v6 as start.
  // 4,120,050 (measured 4,120,009): the same plan-amendments.mjs and plan-accounts.mjs as start.
  // 4,142,200 (measured 4,142,112): the same runner table and decisions.
  // 4,158,500 (measured 4,158,475): the same person-step-catalog.mjs as start, less what moved out of command-skills.mjs.
  // 4,158,510 (measured 4,158,509): the same --latest flag as root dispatch.
  // 4,159,060 (measured 4,159,053): the one documentation definition exported, and a receipt's code digest (delivery-evidence.mjs, code-delivery-tests.mjs) [CQF:REQ-011].
  // 4,165,000 (measured 4,164,950): the same external-command-policy.mjs +5270 and code-delivery-policy.mjs +1205 as start.
  // 4,165,450 (measured 4,165,420): the same person-step-catalog.mjs +454 and command-registry.mjs +16 as start.
  // 4,165,750 (measured 4,165,714): the same code-delivery-policy.mjs +294 as start.
  // 4,163,200 (measured 4,163,160): the same departures as start; no new file.
  // 4,171,000 (measured 4,170,977): the same three merged.
  // 4,167,300 (measured 4,167,278): the same external-command-policy.mjs +1564 as phase-lifecycle [CQF:REQ-050].
  // 4,172,600 (measured 4,172,541): security checks merged too.
  // 4,161,000 (measured 4,160,916): the same coverage key and lcov reporter rule as start (external-command-policy.mjs, node-test-observation.mjs) [CQF:REQ-030].
  // 4,161,800 (measured 4,161,719): the changed-line coverage setting (code-delivery-policy.mjs) [CQF:REQ-031].
  // 4,162,700 (measured 4,162,646): the same warn-mode check at publication as start (delivery-evidence.mjs) [CQF:REQ-032].
  // 4,176,200 (measured 4,176,134): test adequacy merged too.
  // 4,163,250 (measured 4,163,210): their reads load from the CLI source, outside the VS Code gateway bundle (delivery-evidence.mjs).
  // 4,176,200 (measured 4,176,184): the same source-path loads.
  // 4,167,700 (measured 4,167,661): the same command-registry.mjs +1,217, util.mjs +70 and command-skills.mjs +29 as root
  // dispatch, and the release registries' findings-remediation entries (+631).
  // 4,178,150 (measured 4,178,141): the security and TLM findings register merged too; its growth is above.
  // 4,178,200 (measured 4,178,152): a fix on the way's files are a departure's candidate files (plan-amendments.mjs +11) [CQF:REQ-066].
  // 4,178,900 (measured 4,178,856): the pinned spec.conformanceDifferences in specifications.mjs [SCS:REQ-010].
  // 4,178,350 (measured 4,178,314): the same command-registry.mjs +155 as root dispatch, for `departure account` [SCS:REQ-042].
  // 4,179,050 (measured 4,179,011): spec–code sync M1 and M4 together, each one's growth above.
  // 4,179,200 (measured 4,179,198): an amendment that reset nothing asks for no acknowledgement (source-review-policy.mjs +153), and
  // the revalidation's list option (person-step-catalog.mjs +34) [SCS:REQ-022].
  // 4,182,600 (measured 4,182,554): the same stop-time group sweep at its runners' close as phase-lifecycle (+3,543) [TCE:REQ-034].
  // 4,182,800 (measured 4,182,774): both of the above together, each one's growth as measured.
  // 4,179,600 (measured 4,179,544): the same amendment-revalidation family as root dispatch (schema-migrations.mjs +346).
  // 4,183,150 (measured 4,183,120): both of the above together, each one's growth as measured.
  // 4,183,350 (measured 4,183,304): the same prompts command and exported token shapes as root dispatch (+154), and the
  // command's route to /sf-prompt-log (command-skills.mjs +30) [PCR:REQ-002].
  // 4,183,650 (measured 4,183,615): the same flag (util.mjs +60) and init's hook files (config.mjs +251) [PCR:REQ-030].
  // 4,184,500 (measured 4,184,467): the same borrowed visual proof (verification/intent.mjs +852).
  // 4,185,150 (measured 4,185,145): a plan's unmet intent and its own row errors say whose they are (verification/intent.mjs
  // +411, specifications.mjs +267) [PHR:REQ-001].
  // 4,185,700 (measured 4,185,679): whether a submission ends the Story, for a missing receipt (step-actions.mjs +534) [PHR:REQ-003].
  // 4,186,550 (measured 4,186,539): the owner-step pin and whether the scope step's approval waits for its statements
  // (phase-roles.mjs +860) [PHR:REQ-002].
  assert.ok(current.bytes <= 4_186_550, `session current loads ${current.bytes} source bytes`);
});

test('early phase and grounding-path entries exclude the deferred authoring and review graphs', async () => {
  assert.equal((await graph('phase-entry.mjs')).files.has(path.join(sourceRoot, 'phase-entry-authoring.mjs')), false);
  const leaf = await graph('phase-generation.mjs');
  for (const file of ['grounding.mjs', 'source-review-lifecycle.mjs', 'inputs.mjs', 'worldmodel.mjs']) {
    assert.equal(leaf.files.has(path.join(sourceRoot, file)), false, file);
  }
});

test('a product requirement verdict does not eagerly load the release installer', async () => {
  const closure = await graph('product-requirement.mjs');
  for (const file of ['reinstall.mjs', '../scripts/install-staged-artifacts.mjs']) {
    assert.equal(closure.files.has(path.resolve(sourceRoot, file)), false, file);
  }
});

test('extracted legacy helpers remain part of the development build identity', async () => {
  const identity = await readFile(path.join(sourceRoot, 'build-identity.mjs'), 'utf8');
  const helpers = (await commandModuleFiles()).map(file => file.split(path.sep).join('/'))
    .filter(file => file.startsWith('commands/shared/'));
  assert.ok(helpers.length > 0);
  for (const helper of helpers) {
    assert.ok(identity.includes(`'${helper}'`), `${helper} no longer invalidates a pre-extraction build receipt`);
  }
});

test('moving handlers never leaves unbound command-layer identifiers', async () => {
  const files = ['cli.mjs', ...await commandModuleFiles()].map(file => path.join(sourceRoot, file));
  const program = ts.createProgram(files, { allowJs: true, checkJs: true, noResolve: true,
    types: [], target: ts.ScriptTarget.ESNext });
  // noResolve keeps the check bounded to the command layer. Node globals come from the host;
  // imported names remain declared even when their domain modules are not type-checked here.
  const missing = program.getSemanticDiagnostics().filter(diagnostic => diagnostic.code === 2304
    && !/Cannot find name '(?:process|Buffer|NodeJS)'/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')))
    .map(diagnostic => `${path.relative(sourceRoot, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  assert.deepEqual(missing, [], 'A handler/helper moved without all of its bindings.');
});
