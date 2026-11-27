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
    // 474: automatic-approval-possible.mjs (2026-11-23), the one rule the evidence receipt and the approval chain share for
    // whether a step can be approved without a person; its own module so the session projection loads no approval rules.
    assert.ok(closure.files.size <= 474, `${file} loads ${closure.files.size} local files (budget 474; retired graph 597)`);
    // Step intents' derivation loads only for a workflow.yml that opts in (config.mjs loadStepIntentSettings), never eagerly.
    for (const lazy of ['step-intent-settings.mjs', 'step-intents.mjs', 'workflow-step-settings.mjs']) {
      assert.equal(closure.files.has(path.join(sourceRoot, lazy)), false, `${file} eagerly loads ${lazy}`);
    }
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
    // 9,657,050 (measured 9,657,026, commands/phase-lifecycle.mjs): planning prepublish and publication check the plan's
    // existing and removed rows against the Story's base, and the code refusal names the plan's corrections
    // (delivery-evidence.mjs +1950, state.mjs +916, phase-prepublish.mjs +735, phase-resolution.mjs +43); the base read
    // stays lazy (plan-base-paths.mjs) [PHR:REQ-002]. No new eager file.
    // 9,663,100 (measured 9,663,053, commands/phase-lifecycle.mjs): a separate plan is checked against the amended clauses at
    // the amendment, its approval and an unchanged revalidation, the code step names the plan's corrections, and a row of a
    // removed clause is removed in place (state.mjs +4539, plan-row-corrections.mjs +1050, specifications.mjs +389,
    // phase-resolution.mjs +35, person-step-catalog.mjs +14); the gaps stay lazy (plan-clause-gaps.mjs) [PHR:REQ-002]. No new eager file.
    // 9,664,350 (measured 9,664,301, commands/phase-lifecycle.mjs): a supplemental document's risk accepted at its step's
    // approval also covers the later steps that read it, in the same decision, and a later step's refusal names the step
    // that owns the document (story-test-risk.mjs +1248; the refusal stays lazy, trp-document-runtime.mjs) [PHR:REQ-002]. No new eager file.
    // 9,666,850 (measured 9,666,843, commands/phase-lifecycle.mjs): the plan's approvers may uphold a plan against the
    // approved intent through the existing dispute, for the exact draft and only the rows it names (phase-quality-risk.mjs +725,
    // phase-prepublish.mjs +476, state.mjs +415, phase-resolution.mjs +365, verification/intent.mjs +265,
    // phase-finding-dispute-schema.mjs +244, specifications.mjs +52); the dispute itself stays lazy (phase-finding-dispute.mjs)
    // [PHR:REQ-003]. No new eager file.
    // 9,667,100 (measured 9,667,077, commands/phase-lifecycle.mjs): the quality gate reads the last code step's approval as
    // the approval does (state.mjs +146), and readiness says an inspection holds it (owed-decisions.mjs +88) [PHR:REQ-002].
    // No new eager file.
    // 9,667,450 (measured 9,667,430, commands/phase-lifecycle.mjs): a convergence step after the last code step keeps the
    // coverage gaps it adjudicates (state.mjs +353) [PHR:REQ-002]. No new eager file.
    // 9,668,950 (measured 9,668,901, commands/phase-lifecycle.mjs): a code step's publication and submission name the
    // criterion whose own test failed, exactly attributed, with its repair in that step (state.mjs +1471); the attribution
    // stays lazy (criterion-test-failures.mjs) [PHR:REQ-006]. No new eager file.
    // 9,670,300 (measured 9,670,256, commands/phase-lifecycle.mjs): a person may defer a sign-off to a later step that can
    // perform and repair it, which then holds it (person-step-catalog.mjs +481, owed-decisions.mjs +385, witness-records.mjs
    // +273, state.mjs +199, command-registry.mjs +17); the deferral itself stays lazy (witness-deferrals.mjs) [PHR:REQ-007].
    // No new eager file.
    // 9,673,850 (measured 9,673,806, commands/phase-lifecycle.mjs): an intent amendment carries the rows a separate plan
    // needs, signed by the plan's approvers in their decision on it, and the plan keeps its approval (state.mjs +2285,
    // plan-row-corrections.mjs +1096, phase-retention.mjs +169); proposing, proving and recording them stays lazy
    // (amendment-plan-corrections.mjs) [PHR:REQ-008]. No new eager file.
    // 9,675,100 (measured 9,675,086, commands/phase-lifecycle.mjs): the acceptance and visual findings the ending judges are
    // judged in the steps that own them, with the ending's own evaluation (state.mjs +501, governance.mjs +393 to share
    // it, phase-prepublish.mjs +346, witness-records.mjs +33, owed-decisions.mjs +7); the checks themselves stay lazy
    // (acceptance-owner-check.mjs, owner-step-evidence.mjs) [PHR:REQ-007]. No new eager file.
    // 9,629,500 (measured 9,629,451, commands/phase-lifecycle.mjs): the repository's test commands are checked and given to the
    // steps that run tests at resolution, which is synchronous (external-command-policy.mjs repository tests, level and URL
    // credential check +5,927, config.mjs +1,339) [RTC:REQ-001, REQ-002, REQ-011], and workflow activate joins the
    // own-terminal steps (person-step-catalog.mjs, copilot-mutation-guard.mjs) [RTC decision 6]; no new eager file.
    // 9,655,600 (measured 9,655,563, commands/phase-lifecycle.mjs): phase-responsibility batch 1 merged with repository test
    // commands (the two sets above together); no new eager file.
    // 9,682,650 (measured 9,682,626, commands/phase-lifecycle.mjs): phase-responsibility batch 2 merged with main (batch 1,
    // repository test commands and the 11-10 fixes): the sets above together; no new eager file.
    // 9,684,450 (measured 9,684,417, commands/phase-lifecycle.mjs): a person's accepted risk on a failed visual comparison,
    // read by the visual step's approval and the ending (governance.mjs +641, person-step-catalog.mjs +477, state.mjs +363),
    // held at the visual step for a Story pinned at level 2 (phase-roles.mjs +295); the decision and the check stay lazy
    // (visual-risks.mjs) [PHR:REQ-006]. No new eager file.
    // 9,685,750 (measured 9,685,741, commands/phase-lifecycle.mjs): an amendment that revises a clause carries the plan's
    // row for it, which keeps the plan's evidence of that clause current (plan-row-corrections.mjs +871, scope/revisions.mjs
    // +453) [PHR:REQ-008]. No new eager file.
    // 9,688,800 (measured 9,688,752, commands/phase-lifecycle.mjs): a code step also runs the repository tests the steps
    // after it choose, resolved when the Story starts (config.mjs +2684), and names them at its test runs (state.mjs +327);
    // the words stay lazy (later-step-tests.mjs) [PHR:REQ-007], item 8. No new eager file.
    // 9,691,100 (measured 9,691,089, commands/phase-lifecycle.mjs): a plan an amendment keeps is read as its approval
    // decided over it, and reads the amended scope as its approvers signed it (forward-amendments.mjs +786, state.mjs +869,
    // phase-retention.mjs +682) [PHR:REQ-008]. No new eager file.
    // 9,691,600 (measured 9,691,563, commands/phase-lifecycle.mjs): `phase rollover` sends a published, unchanged code
    // generation to the change the person asks for (phase-lifecycle.mjs +474); that rollover stays lazy
    // (requested-successor.mjs). No new eager file.
    // 9,692,100 (measured 9,692,073, commands/phase-lifecycle.mjs): a code step's publication asks once whether to start
    // the application (phase-lifecycle.mjs +510); the question is built lazily (application-start-offer.mjs). No new eager file.
    // 9,692,700 (measured 9,692,688, commands/phase-lifecycle.mjs): a sign-off is offered only once its evidence exists and its
    // step has published (owed-decisions.mjs signOffReady +588) [PHR:REQ-006]. No new eager file.
    // 9,587,000 (measured 9,586,982, commands/phase-lifecycle.mjs): a reviewer in every step, code included [review
    // level 2]. The review is read only where it gates submission and approval, so state.mjs loads it from the CLI
    // source and the evaluator, its contract and the new document and code checks leave the eager graph
    // (source-review-lifecycle.mjs, source-grounded-review.mjs, source-review-contract.mjs). No new eager file.
    // 9,587,900 (measured 9,587,867, commands/phase-lifecycle.mjs): a plan row short of the approved intent is the plan's own
    // correction first, the earlier step's route after it (phase-finding-policy.mjs planCorrectsFirst, phase-prepublish.mjs,
    // phase-resolution.mjs) [Story cplus, 2026-11-11]. No new eager file.
    // 9,588,500 (measured 9,588,487, commands/phase-lifecycle.mjs): the clarification reply file's exact shape on every
    // route that records replies (phase-staging-paths.mjs, clarifications.mjs, phase-entry-authoring.mjs) [Story anu-bin]. No new eager file.
    // 9,588,900 (measured 9,588,868, commands/phase-lifecycle.mjs): a reviewer started after publication is waited for, not
    // relayed (agent-output.mjs), a mistyped review binding gets its exact values (refusal-remediation.mjs), and a planned
    // file short only of its binding is the author's to bind (phase-finding-policy.mjs) [Story anu-bin]. No new eager file.
    // 9,589,000 (measured 9,588,977, commands/phase-lifecycle.mjs): a child branch keeps the session on the Story's current
    // step, so that step's own review can be retained there (story-lineage.mjs preserveAgent +109). No new eager file.
    // 9,605,500 (measured 9,605,498, commands/phase-lifecycle.mjs): the 2026-11-11 class sweep after the anu-bin and
    // cplus stops, merged: one own-repair-first correction rule (phase-finding-policy.mjs correctionPlan, phase-draft-check.mjs,
    // phase-resolution.mjs), agent-input refusals with the exact fix and copy-slip checks (text-lines.mjs, specifications.mjs,
    // plan-row-corrections.mjs, phase-evidence-amendment.mjs), a passing tagged test establishing its criterion (state.mjs,
    // conformance-readiness.mjs), and the agent-view wording fixes (agent-output.mjs). No new eager file.
    // 9,606,150 (measured 9,606,146, commands/phase-lifecycle.mjs): a Story's source statements are owed to a person only
    // once the scope step has published (owed-decisions.mjs scopeItemsReady) [Story b-bin, 2026-11-11]. No new eager file.
    // 9,609,100 (measured 9,609,085, commands/phase-lifecycle.mjs): test support (mocks, fixtures, setup, helpers) is refused from
    // Planned tests with the move to make and has its own Supporting files class (source-boundary.mjs isTestSupportPath,
    // supporting-changes.mjs, specifications.mjs) [office, 2026-11-11]. No new eager file.
    // 9,642,500 (measured 9,642,434, commands/phase-lifecycle.mjs): the 2026-11-12 after-demo merge. Template guidance is
    // removed at publication and the 95 new packaged template digests are registered (packaged-asset-history.mjs +14.8 KB,
    // markdown-structure.mjs); a file changed after publication is caught at submit and the next draft is offered for any
    // authored step (t2); deployed-URL tests, Windows port holders and the .github/hooks guard (config.mjs,
    // external-command-policy.mjs, governed-roots.mjs); the walk, fix and simplify commands' registry entries; hashes kept
    // out of person text (t1); the hook working folder (t4). No new eager file.
    // 9,649,500 (measured 9,649,466): a confirmation route a person types is a short code, never its digest, in Copilot
    // and in their own terminal (confirm-code.mjs, one new eager file of 5.4 KB that route building loads; the prompt
    // hook and the guard resolve it; model-free-commands.mjs shows the code on the Shell line) [owner, 2026-11-12].
    // 9,649,900 (measured 9,649,886): the step that defines clauses, and the anchor refusals, name the Story's own
    // clause namespace instead of a sample one an agent copied as NS: (phase-authoring-contract.mjs, phase-prepublish.mjs,
    // state.mjs) [office, 2026-11-12].
    // 9,650,700 (measured 9,650,625): scope choices say which is which, "included" (a clause of this Story states it) and
    // "existing" (the product had it before), wherever a person or an agent is offered them (decision-list.mjs,
    // owed-decisions.mjs, scope/extract.mjs, scope/authoring.mjs). No new eager file [office, 2026-11-12].
    // 9,651,700 (measured 9,651,687): the POC workflow's six templates take each Story's Work ID in their clause anchors,
    // and their released bytes stay registered (packaged-asset-history.mjs +1,062) [office, 2026-11-12].
    // 9,653,300 (measured 9,653,223): a responsibility no step of a workflow holds is settled by the workflow's own
    // declared reason, not asked of each Story (evidence/applicability.mjs), and Test run ships (its step, template and
    // QA agent registered in packaged-workflow-history.mjs and packaged-asset-history.mjs) [owner, 2026-11-12].
    // 9,654,700 (measured 9,654,685): every confirmation route a person reads is its short code, which now also stands
    // for a commit or a plan ID (confirm-code.mjs, command-skills.mjs routes, +1,414), and each decision says what it
    // holds (decision-list.mjs, +48) [owner, "fix the remaining hash screens" and the decision map, 2026-11-12]. No new eager file.
    // 9,656,000 (measured 9,655,995): an intent amendment is decided on the decisions card, and the card offers Refresh
    // for a proposal the step moved under, read with the same staleness check its approval makes (state.mjs
    // intentAmendmentStaleness, +1,258, exported through state-stores.mjs, +52) [owner, 2026-11-13]. No new eager file.
    // 9,661,700 (measured 9,661,666, commands/phase-lifecycle.mjs): intent amendments from chat [owner, 2026-11-13]: a step
    // whose amendment waits pauses, refused at begin, prepare, publish and submit with the decisions card as its route
    // (intent-amendment-pause.mjs, the one new eager file, +2,257; phase-governance-routing.mjs +2,320; state.mjs +505;
    // phase-lifecycle.mjs +273), an acknowledgement is a person's own step (person-step-catalog.mjs, source-review-policy.mjs),
    // /sf-reject's propose route and the authoring draft (copilot-guidance.mjs, phase-staging-paths.mjs, upstream-routes.mjs).
    // 9,663,250 (measured 9,663,230, commands/phase-lifecycle.mjs): the three above together, set once at the combined measurement.
    // 9,664,300 (measured 9,664,296): SPEC-CIC stage 7's default and the Decide card's Copilot routes for a person's own
    // steps, measured together where both land (2026-11-15). No new eager file.
    // 9,667,450 (measured 9,667,440): with each person's own GitHub account (git.mjs, session.mjs) and workflow assess
    // also landed, measured together for the stable build (2026-11-15). No new eager file.
    // 9,667,550 (measured 9,667,528, commands/phase-lifecycle.mjs): SPEC-SCF stage 1 on top of the stable build (+88),
    // measured on the merge with main 4ac5c5c40 (2026-11-15). No new eager file.
    // 9,668,500 (measured 9,668,466): outside a Story checkout the approved configuration is found by each configured
    // remote's exact sflow/config ref, not a pattern over every remote (approved-configuration-reader.mjs +846), and the
    // state marker clone keeps its objects (configuration-branch.mjs +92) [SPEC-SCF stage 1, 2026-11-16]. No new eager file.
    // 9,663,650 (measured 9,663,627, commands/phase-lifecycle.mjs): the agents home [SPEC-AGH, owner 2026-11-14] merged with
    // main bd90bcc46 (9,656,050 there): discovery reads the root workflow.yml records (agents.mjs +1,701), the layout and its
    // transport policy (configuration-assets.mjs +1,643), init's layout (config.mjs +1,345, initialization-assets.mjs +1,305),
    // first governance moves SFlow's agents only (configuration-branch.mjs +837), the legacy root governed unless a source
    // records the home (application-paths.mjs +520) and moved agents' package history (packaged-asset-history.mjs +226).
    // The migration stays lazy (agents-home-migration.mjs). No new eager file [2026-11-15].
    // 9,664,150 (measured 9,664,103): every reader of where agents live takes it from the one resolver [AGH:REQ-028, owner
    // 2026-11-15]: its helper and comment (configuration-assets.mjs +173) and one import in each of agents.mjs, clone-strategy.mjs,
    // initialization-assets.mjs, initialization/runtime-readiness.mjs, initialization/source-snapshot.mjs, skp-contract.mjs and
    // specifications.mjs; application-paths.mjs drops its own copy (-103). No new eager file.
    // 9,664,450 (measured 9,664,429): a Story start removes only what the approved configuration's own policy counts as
    // configuration, so the team's .github/agents on main stays [AGH:REQ-029, upgrade review 2026-11-15]
    // (configuration-branch.mjs +326). No new eager file.
    // 9,676,850 (measured 9,676,845): the agents home above (+8,379 in all) merged with main 04a6f2adc and its SPEC-SCF
    // stage 1 (9,668,466 there) [2026-11-16]. No new eager file.
    // 9,669,200 (measured 9,669,194): a reset's Story checkout reads go through registered Git queries (git-query.mjs
    // repository.remote-contains) and the state marker through the source facade (SDA-AC-001, 2026-11-16). No new eager file.
    // 9,677,600 (measured 9,677,573): the agents home (9,676,845) merged with main 27361670a and its registered Git query for
    // a reset's Story checkout reads (+728) [2026-11-16]. No new eager file.
    // 9,678,050 (measured 9,678,048): while a step's next version is open, its next step is to write it and the last
    // version's review is not inspected again (phase-generation-need.mjs, guide.mjs, source-review-lifecycle.mjs) [2026-11-16].
    // 9,679,650 (measured 9,679,625): a step name typed by mistake names the Story's steps and the same command with one
    // (util.mjs unknownStepDetails +880, its callers in phase-lifecycle, submit, prepare and phase-show) [2026-11-16]. No new eager file.
    // 9,688,200 (measured 9,688,174): the 2026-11-16 batch on main 56dfa031e (9,679,625), each as measured on its own
    // branch: a reset's registered worktree list (git-query.mjs repository.worktrees, +520); a review's next step in
    // SFlow's own words and one turn, with `phase rollover` as the step author's route (source-review-continuation.mjs
    // +3,661, code-delivery-policy.mjs +457, copilot-guidance.mjs +466, command-skills.mjs +326, safe-command-guidance.mjs
    // +260, recovery-plan.mjs +267 and smaller, +5,634); a refusal about where the Story stands names the Story's or the
    // Epic's own next step (sequence.mjs storyNextDetails and storyClosedRefusal +1,301, its throw sites in state.mjs,
    // story-lineage.mjs, phase-lifecycle.mjs and initiative-state.mjs, +2,105), which writes an open next version first;
    // and a step the kernel builds routed straight to its generator (commands/nextsteps.mjs, +300). No new eager file.
    // 9,694,550 (measured 9,694,548): SPEC-OSA stage 1 (+6,374): one "being written" test and its uses
    // (phase-generation-need.mjs stepBeingWritten, submission-readiness.mjs, sequence.mjs, guide.mjs, nextsteps.mjs), submit
    // refusing while a next version is open (state.mjs), the edit permission's own next instead of recover
    // (phase-mutation-contract.mjs), the step's work command on its refusals and task routes (generation-boundary.mjs,
    // source-review-lifecycle.mjs, code-delivery-policy.mjs opensCodeVersion, safe-command-guidance.mjs, command-skills.mjs)
    // and no containment beside a refusal that writes the step (refusal-remediation.mjs) [OSA Stage 1]. No new eager file.
    // 9,747,600 (measured 9,747,581 for phase-lifecycle.mjs, +53,047): SPEC-OSA v1.1 Stage 3. Every surface that names a
    // step's next action takes it from the kernel's one decision [OSA:REQ-020], so sequence.mjs, guide.mjs and
    // source-review-continuation.mjs now reach the reducer (kernel/step-state.mjs, 35,067 bytes: 28,961 at Stage 2, +6,106 for the
    // task outcomes, the advisory view of an opening and the no-progress classifier) and its adapter and renderer (step-decision.mjs, 15,138 bytes, moved out of
    // phase-mutation-contract.mjs, which these handlers do not load). Their own deleted branches give a little back. The task
    // outcome reader (workflow-task-outcome.mjs) and the task record stay lazy; next steps and readiness name a code step's own
    // opening and its task's wait (+554 after the journeys). Two new eager files: submit.mjs 473 of 473.
    // 9,751,600 (measured 9,751,587 for phase-lifecycle.mjs, +4,006): SPEC-OSA v1.1 Stage 3 completion. The recovery
    // planner, finding resolution, gate recovery and recover's healthy answer name the step's own route from the kernel
    // (step-decision.mjs stepRoute, recovery-plan.mjs +285, phase-resolution.mjs +574, gate-recovery.mjs +893,
    // collaboration.mjs +339), the kernel's `publication-pending` stage and its render (kernel/step-state.mjs +1,087,
    // step-decision.mjs +607) and readiness naming it (submission-readiness.mjs +223). Their deleted raw reads and recover
    // routes give a little back. The stage's readers (workflow-task-outcome.mjs, the lease and pending-publication reads) and
    // the shared session-opening read stay lazy. No new eager file.
    // 9,696,800 (measured 9,696,783): SPEC-SCF stage 5, movable workspaces and one repository key (+2,235): the registered
    // Git queries `workspace repair` reads (git-query.mjs repository.ref-holds, worktree.staged-paths, git.version and the
    // worktree list's branch, +1,922), its three worktree mutations (git.mjs +1,091), the missing Story checkout's route on
    // the folder-gone refusal (util.mjs +526) and a workspace reference's refusals moved out to workspace-relink.mjs, which
    // stays lazy (workspace-context.mjs +641) [2026-11-16]. No new eager file.
    // 9,696,600 (measured 9,696,563): SPEC-SCF stages 3 and 4 on 9,688,981 (+7,582): registered Git queries for a
    // removed member's history, a restore's sources and a clone's upload refs (git-query.mjs +4,869), the restore and
    // "does not load" routes (configuration-branch.mjs +2,500), the authority check read for doctor and validate
    // (approved-configuration-reader.mjs +860), ancestry proof v2 readers (workflow-snapshots.mjs +580, schema-migrations.mjs
    // +272, test-command-amendment-contracts.mjs +231) and the --rollback and --adopt-without-ancestry flags (util.mjs,
    // command-registry.mjs +51), less the capture moved out of the eager graph (skp-amendment-audit.mjs -1,781) [2026-11-16].
    // No new eager file.
    // 9,766,750 (measured 9,766,714 for phase-lifecycle.mjs): the 11-17 landing, OSA v1.1 Stages 1-3 with SPEC-SCF stages 2-5
    // and the 11-16 small fixes on one tree; the sum of the measured rises above (each stage's own new code). No new eager file.
    // 9,753,750 (measured 9,753,705 for phase-lifecycle.mjs, +6,124): SPEC-OSA v1.1 Stage 4. The one action-to-command map
    // beside its renderer (step-decision.mjs ACTION_COMMANDS, actionSkill, workCommandOf), the work command's two names
    // (command-skills.mjs WORK_COMMANDS, which safe-command-guidance.mjs reads instead of its own literal), a kernel-built
    // step's successor rendered as its preview, and the card's yes narrated (narration/messages.mjs). The alias adapter
    // (writing-aliases.mjs), the review delegation and the card's consent stay lazy. No new eager file.
    // 9,772,850 (measured 9,772,838 for phase-lifecycle.mjs): OSA v1.1 Stage 4 (+6,124 alone: the action-to-command map in
    // step-decision.mjs, the writing aliases' target rule, review delegation's bound handoff) merged into the 11-17 landing
    // above. Files: submit.mjs 473 of 473. No new eager file.
    // 9,740,950 (measured 9,740,923 for submit.mjs, which is now the largest; was 9,772,838 for phase-lifecycle.mjs): SPEC-OSA
    // v1.1 Stage 5 lowers it to what it measures. The reducer and its renderer load lazily behind the planners' refusal
    // and rarely used paths: recovery's kernel route (recovery-plan.mjs, collaboration.mjs), finding resolution
    // (phase-resolution.mjs), gate recovery's reopen check (state.mjs), and prepublish's retained-publication readiness
    // (submission-readiness.mjs, source-review-continuation.mjs). phase-lifecycle.mjs falls by 94,745 to 9,678,093 (452
    // files); submit.mjs rises by 3,685 for the action-to-command map (action-command-map.mjs, which took in
    // submit-route.mjs, so its files stay 473). The reducer stays eager where a command's own narration names the next
    // step (start, submit, approve, prepare, review-source, inputs) and through sequence.mjs's synchronous refusal details.
    // 9,743,200 (measured 9,743,160 for submit.mjs): the owner's decision of 2026-11-17, an approved amendment acknowledged
    // before the version question (+1,967): the kernel's hold leads the opening or publishing it blocks (kernel/step-state.mjs),
    // its route names the acknowledgement (step-decision.mjs) and sequence reads a held submission as that route. The 11-17
    // landing at 051d9096b already measured 9,741,193, 243 over the line above, before this change. No new eager file.
    // 9,744,100 (measured 9,744,073 for submit.mjs, +913): a step SFlow builds is published by its own work command's route
    // in the planners' later steps and refusals, never /sf-publish [OSA:REQ-026, C9]: action-command-map.mjs's
    // builtPublicationRoute (publish-version's prepublish form), sequence.mjs's phasePublicationCommandForMode naming it, and
    // nextsteps.mjs's words. Moving sequence.mjs's soft-gate audit record to a lazy module got under this line, but added a
    // module to the VS Code gateway bundle, which is at its 884; the growth is this fix's own. No new eager file.
    // 9,745,200 (measured 9,745,151 for submit.mjs, +1,078): a published step's next version opens only on the person's yes
    // [D3, OSA:REQ-030]: action-command-map.mjs's versionQuestionRoute (the open-version preview) for visual coverage's
    // waiting captures and state.mjs's two submit refusals that said to publish again, and preparation and `phase publish`
    // refusing a published document's next draft no yes opened (prepared-document-successor.mjs's test and refusal).
    // visual-coverage.mjs lost its republish command. The refusal stays in that eager module: reached through
    // commands/phase-opening.mjs, it put that module and eight of its imports into the VS Code gateway bundle, at its 884
    // modules. No new eager file.
    // 9,744,700 (measured 9,744,672 for submit.mjs, +1,512): the daily run of 2026-11-17, a change the person types after a
    // step is published asks its version question everywhere: the kernel's own branch for it (kernel/step-state.mjs +652), the
    // record adapter's fact and the route's words (step-decision.mjs +276), and the entry asking it as a review's corrections are
    // asked (phase-authoring-summary.mjs +468, phase-authoring-entry.mjs +116). Comments trimmed first. No new eager file.
    // 9,746,100 (measured 9,746,084 for submit.mjs, +1,412): the person's views ask the same version question (owner): the
    // kernel's decision for a view reads the typed change from the step's task fact (step-decision.mjs +148), next steps lead
    // with it (guide.mjs +367) and so does submission readiness, with phase show through it, keeping /sf-submit's own
    // submission of the version as it is (submission-readiness.mjs +897). The reader itself stays lazy (workflow-task-outcome.mjs).
    // 9,745,800 (measured 9,745,763 for submit.mjs, +612): a quality command that changes the source at submission names
    // the published step's version question (state.mjs's two QUALITY_COMMAND_SOURCE_MUTATION refusals, which said to publish
    // a fresh generation), and refusal-remediation.mjs leads with it [D3, OSA:REQ-030]. No new eager file.
    // 9,743,800 (measured 9,743,793, start.mjs now the largest; submit.mjs 9,741,327): the 11-17 follow-ups on one tree. The
    // asked-for views load submit's printed phase review only in a person's terminal (-4,800 or so), which more than covers
    // the other follow-ups' rises above. No new eager file.
    // 9,744,500 (measured 9,744,462 for start.mjs, +669): after an approval, its clean-chat item names the next step's own
    // command, the one VS Code's chat prefill puts in, never /sf-next beside it (owner, 2026-11-17): step-decision.mjs's
    // stepChatCommand (+313, the kernel route's command), state.mjs's approval, decision and rejection boundaries (+197),
    // nextsteps.mjs's pendingBoundary (+217) that narration/continuation.mjs now shares (-112), context-policy.mjs passing it
    // on (+53). Comments trimmed first. No new eager file.
    // 9,744,850 (measured 9,744,820 for start.mjs, +1,027): OSA Stage 5's leftovers. The planners take their routes from the
    // one action-to-command map (action-command-map.mjs +1,358: the author, show, Story-next, version-preview, handoff-submit,
    // approve and return routes, filled from its forms), which takes the commands they wrote in place out of them
    // (guide.mjs -462, nextsteps.mjs -162, sequence.mjs -24); a healthy step's refusals name its owner's correction or `sync`
    // instead of recovery (state.mjs +279, story-test-risk.mjs +54, story-test-command-amendment.mjs -16). No new eager file.
    // 9,745,500 (measured 9,745,489 for start.mjs): the two small-fix tracks of 2026-11-17 together, each measured above on
    // its own base (the approval's next command from the kernel route, and Stage 5's routes from the map). No new eager file.
    // 9,745,700 (measured 9,745,700 for start.mjs, +1,907): CVL gap report piece 1 (OSA §8, TCE:REQ-034). The gate records
    // that a required test run started and reconciles the last one before the next (state.mjs +1,390: the call, the held
    // check, the kept group answer and the input wait at preparation and publication), the runner keeps its stopped group's
    // answer (quality-command-runner.mjs +430) and the kernel carries the input a wait names (kernel/step-state.mjs +66,
    // step-decision.mjs +21). The marker itself loads from the CLI source only when a gate runs a test. No new eager file.
    // 9,746,550 (measured 9,746,521 for start.mjs, +2,728; submit.mjs 9,744,211): the fuller test-reuse key and the
    // `testRuns: fresh` step setting [TCE:REQ-080/081, CVL-REQ-013/014]. The step setting's one reader
    // (code-delivery-policy.mjs +351), its check at load (config.mjs +711), the gates reading it and handing a run's
    // dependencies and test policy to the reuse check (state.mjs +884), and the attempt keeping them (attempts.mjs +782).
    // The comparison itself, the policy digest and the lockfile reads stay lazy (evidence-reuse.mjs, test-toolchain.mjs).
    // No new eager file.
    // 9,750,200 (measured 9,750,124 for start.mjs, 464 files): CVL pieces 1 and 3 (recorded stops, the run-started marker, the
    // fuller reuse key and the fresh-run setting) on main 4d173adc1 with the small fixes, each measured above on its own base.
    // No new eager file.
    // 9,749,400 (measured 9,749,324 for start.mjs, +3,624): the review of CVL piece 1 (2026-11-17). Every recorded wait
    // leads with a route that works: an environment's own fix and the step's checks again beside it, a spent repair's
    // appeal (step-decision.mjs +1,999, action-command-map.mjs +432, kernel/step-state.mjs +31); the refusal's own fix
    // commands and the environment's name (state.mjs +475); a restore settles its wait by any route (documents.mjs +193);
    // a held test run listed by anyone and set aside only in a person's own terminal (person-step-catalog.mjs +268,
    // command-registry.mjs +226). The marker and the wait readers stay lazy. No new eager file.
    // 9,753,800 (measured 9,753,754 for start.mjs, 464 files): CVL pieces 1 and 3 with piece 1's review fixes, on main
    // 4d173adc1, each measured above on its own base. No new eager file.
    // 9,753,900 (measured 9,753,815, +61): the person-step catalog's confirming runs share one check (2026-11-18). No new
    // eager file.
    // 9,746,750 (measured 9,746,712 for start.mjs, +1,223; submit.mjs 9,745,853): review 2026-11-17, kernel #8 and #10. The
    // person's No to a typed change's version question goes on with the step's own action, never the question again or a
    // submission the engine refuses: the kernel names it (`declined`, kernel/step-state.mjs +322), the renderer gives its
    // route beside the question (step-decision.mjs +508), and next steps offers it instead of a refused submission (guide.mjs
    // +393). Comments trimmed first; submission readiness, which grew more, is not in start's closure. No new eager file.
    // 9,745,900 (measured 9,745,891 for start.mjs, +402 over 4d173adc1's 9,745,489): review 11-17 findings 2 and 11. Turning
    // self-approval off is refused while nobody else is named (configuration-people.mjs +268, a call into the lazy
    // config-approvers.mjs), and a test-command amendment's two refusals name the Story's own request
    // (story-test-command-amendment.mjs +134, calls into test-command-pins.mjs, which stays lazy). The route builders were
    // first put in test-command-amendment-contracts.mjs (+3,274 here and in session current) and moved out. No new eager file.
    // 9,755,700 (measured 9,755,658 for submit.mjs, +3,554 over d192ede2c's 9,752,104; start.mjs 9,755,429): the four
    // review-fix tracks of 2026-11-17 (rv-a..rv-d) merged on main d192ede2c, each measured above on its own base. Same 472
    // files in submit's closure. No new eager file.
    // 9,755,900 (measured 9,755,869 for submit.mjs, +211 on 99e006273's 9,755,658; start.mjs 9,755,640): the third account of
    // what a person typed, a question answered with nothing to change (owner, 2026-11-18): the account route's words
    // (step-decision.mjs +23), the card's result headline (narration/messages.mjs +173) and the `--as-question` boolean
    // (util.mjs +15). The account, the version question's third answer and their checks stay lazy. No new eager file.
    // 9,758,000 (measured 9,757,990 for submit.mjs, +2,332 over 9,755,658; start.mjs 9,757,676): CVL piece 4 (2026-11-18).
    // A plan's Interface api column and its rule that a screenshot never proves an API (verification/contracts.mjs +1,092),
    // the gate loading the API assertion check only for such a criterion (delivery-evidence.mjs +722), a declared surface
    // with no screens read by visual coverage (visual-coverage.mjs +433, a call into the lazy application-review-policy.mjs)
    // and its reason in the Flow Gate's passes (governance.mjs +85). The checks themselves stay lazy. No new eager file.
    // 9,758,250 (measured 9,758,201 for submit.mjs, +2,543 over 9,755,658; start.mjs 9,757,880): the question account and
    // CVL piece 4 merged on the review fixes (after-demo, 2026-11-18), each measured above on its own base. Same 472 files.
    // No new eager file.
    // 9,759,850 (measured 9,759,839 for submit.mjs, +1,640 over 9,758,199; start.mjs 9,758,302): a visual sign-off the plan
    // names no file for gets the screenshot a person captures at SFlow's browser (owner, 2026-11-18): the owed sign-off asks
    // the lazy visual-sign-off-capture.mjs, loaded by its path, for its file (owed-decisions.mjs +789), approve
    // --confirm-evidence confirms it (verification/witness-records.mjs +427), an untracked screenshot in the Story's folder
    // is SFlow's output, not a change to review (lifecycle-worktree.mjs +195), and `decision screenshot` is a person's own
    // step (person-step-catalog.mjs +215, command-registry.mjs +14). The build, server and browser stay lazy
    // (visual-sign-off-screenshot.mjs, application-review-preview.mjs). No new eager file.
    // 9,761,100 (measured 9,761,040 for submit.mjs, +1,203 over 9,759,837; start.mjs 9,759,503): a version opened to fix its
    // review's findings about tests or evidence only carries the published source (owner, 2026-11-18, Story new-ash-graph):
    // the gate's call into review-test-correction.mjs, loaded by its path, and the carried rows (delivery-evidence.mjs
    // +1,104) and the receipt's field (state.mjs +99). The rule and its review read stay lazy. No new eager file.
    // 9,759,900 (measured 9,759,897 for submit.mjs, +58 over 9,759,839) [owner, 2026-11-18]: a visual sign-off's screenshot
    // is a Decide card step, so its Copilot route is /sf-decide, never "no verified equivalent" (model-free-commands.mjs),
    // and an approved amendment's refusal says the steps it reopened are submitted again (source-review-policy.mjs).
    // No new eager file.
    // 9,761,100 (measured 9,761,073 for submit.mjs, start.mjs 9,759,536, 2026-11-18): both rises above merged with the
    // local-service fixes on one landing; they overlap, so together they add +33 over the first. No new eager file.
    // 9,761,850 (measured 9,761,835 for submit.mjs, +795 over 9,761,040; start.mjs 9,760,298): a failed test whose Node pin
    // the evidence names, and nobody undid, is settled before the next run, not a person's choice (owner, 2026-11-18): the
    // refusal asks the lazy node-version-settle.mjs, loaded by its path, for an earlier Story's pin and says SFlow pins it
    // (state.mjs +795). The settlement, the pin history and their checks stay lazy. No new eager file.
    // 9,762,350 (measured 9,762,325 for submit.mjs, +490 over 9,761,835; start.mjs 9,760,788): a refused test run names the
    // Node it ran on, not SFlow's own (owner, 2026-11-18, Story new-ash-graph): ranOnNode and "failed on Node N" (state.mjs
    // +381) and its projection (test-execution-diagnostics.mjs +109). `tests base` on the pinned Node stays lazy. No new eager file.
    // 9,762,500 (measured 9,762,472 for submit.mjs, +147 over 9,762,325; start.mjs 9,760,935): a version with nothing
    // written yet says so on its refusal (delivery-evidence.mjs nothingWritten), so recovery shows its findings as the version's
    // checklist, never a blocker (owner, 2026-11-18, Story new-ash-graph). No new eager file.
    // 9,762,550 (measured 9,762,505 for submit.mjs, start.mjs 9,760,968, 2026-11-19): the sf-code recovery above merged with
    // the local-service fixes and the Decide screens on one landing (+5 over its own measure). No new eager file.
    // 9,762,700 (measured 9,762,661 for submit.mjs, +156 over 9,762,505, 2026-11-19): lines the office mirror's secret
    // scanner refuses are reworded (a local named for a credential renamed, a kept field's value on the next line, a
    // passing status word from a constant) across the eager files. Trimmed from +766: shorter lexer and pagination names,
    // single-use status words flipped, line breaks instead of new locals; session current is 47 bytes smaller. No new eager file.
    // 9,762,700 (measured 9,762,668 for submit.mjs, +163 over 9,762,505): `singularity-flow update`, the installed package's
    // own updater, registered as a command (command-registry.mjs), routed to /sf-about and refused in every turn as the
    // person's own step (command-skills.mjs, person-step-catalog.mjs) [owner, 2026-11-19]. Its handler and runtime/update.mjs
    // stay lazy. No new eager file.
    // 9,763,900 (measured 9,763,893 for submit.mjs, +1,388 over 9,762,505; start.mjs 9,762,356, 2026-11-19): Git work SFlow
    // starts by itself waits for an idle laptop (owner, 2026-11-19): the operating system's input idle time is read through
    // the registered process owner (platform-process.mjs osIdleMilliseconds, +1,388). The gate, the stamp and the queue
    // (machine-activity.mjs, automatic-work.mjs) stay lazy. No new eager file.
    // 9,763,900 (measured 9,763,868 for submit.mjs, +1,363 over 9,762,505; start.mjs 9,762,331): SFlow prepares the code
    // environment itself (owner, 2026-11-19, ceremony cut 5): the gates make a Story checkout's dependencies ready before
    // its tests and say why when they cannot (state.mjs +1,363). The install, the copy, the Node probe and the Node kept for
    // a Story stay lazy (repository-dependency-setup.mjs, loaded by its path; node-version-settle.mjs; node-pin.mjs). No new eager file.
    // 9,767,350 (measured 9,767,312 for submit.mjs, +3,509 over 9,763,803; start.mjs 9,764,797, 2026-11-19): changes outside
    // the plan are settled from a fixed list [owner, 2026-11-19, C3, Q6]: the Story's settled test support is one
    // classification every reader takes (plan-amendments.mjs +1,000, source-boundary.mjs, supporting-changes.mjs,
    // specifications.mjs, candidate-scope.mjs), the settling pin and the completion hold on a step nobody approves (state.mjs),
    // and untracked files in the importer search (git.mjs). The classifier and the page-object reader stay lazy
    // (out-of-plan-classes.mjs, test-support-detection.mjs). No new eager file.
    // 9,767,400 (measured 9,767,375 for submit.mjs, +63, 2026-11-19): `--recommended` is a boolean option the parser knows
    // (util.mjs BOOLEAN_OPTIONS), the recommended answer recorded in chat with no reason [owner, 2026-11-19, C10]. No new eager file.
    // 9,767,900 (measured 9,767,892 for submit.mjs, +517 over 9,767,375, 2026-11-19): an undo of what was settled and an
    // approved amendment's acknowledgement are a /sf-decide turn's bound yes (person-step-catalog.mjs, copilot-mutation-guard.mjs
    // decide-turn admissions, copilot-answer-binding.mjs) and the catalog says why thirteen steps stay terminal-only
    // [owner, 2026-11-19, terminal-to-card]. No new eager file.
    // 9,778,300 (measured 9,778,268 for submit.mjs, +14,375 over 9,763,893; start.mjs 9,771,820, 2026-11-19, ceremony-approvals):
    // approve twice, one bound Yes and the convergence Yes [owner, 2026-11-19]: which steps a person must approve, read by
    // configuration (phase-roles.mjs +3,213, config.mjs +1,101), the `approval.automatic` key (approval-authority.mjs +1,875),
    // the approval check's automatic mode and the steps a person's approval covers (state.mjs +3,095), the automatic approval
    // and the landing after submission (submit.mjs +2,341), and their readers (governance, evidence receipt, approval chain,
    // inputs, publication, phase review: about +3,700). The approval itself, its replay and the landing (automatic-approval.mjs,
    // automatic-approval-replay.mjs, story-landing.mjs) stay lazy. No new eager file.
    // 9,778,900 (measured 9,778,850 for submit.mjs, +582, 2026-11-20, ceremony-approvals): a step's own two-approver or
    // self-approval-off policy holds an automatic step with its people instead of failing configuration, and the obligation
    // compiler counts a person's review on a route that leaves an automatic step with its people. No new eager file.
    // 9,768,673 (measured 9,768,673 for submit.mjs, +6,310 over 9,762,363; start.mjs 9,765,102, 2026-11-19 on
    // ceremony-turns): the ceremony cuts' wiring, as flow-turns measured it on its own base (+3,597, owner 2026-11-19), and the
    // owner's changes to it: a review's next version starts on its own at most twice in a row and never for a finding back
    // after a fix (source-review-continuation.mjs reviewFindingsHold, reviewFindingKeys), which the step's entry names to the
    // person (phase-authoring-entry.mjs successor.because), no in-turn submission for decision values, intake clarification's
    // one assumptions question (clarifications.mjs) and the kept chat's next step named, never run (approval-agent-result.mjs).
    // The settled opening and its records stay lazy (review-findings-opening.mjs, story-version-opening.mjs). No new eager file.
    // 9,792,077 (measured for submit.mjs on landing-6, 2026-11-20): code-env and the four ceremony branches above together.
    // 9,792,798 (measured for submit.mjs, +721, 2026-11-20): the full run's fixes: an automatic approval refused in its own stage of
    // the one check (state.mjs), its two owners and the gate's code (approval-check.mjs, gate-parity.mjs), and the routes of an undo. No new eager file.
    // 9,793,513 (measured for submit.mjs, +715, 2026-11-20): with no installed Node that can run the tests, the failed run's
    // refusal names the filled install command and its plan waits on it (state.mjs, refusal-remediation.mjs, agent-output.mjs);
    // the check that finds it stays lazy (node-pin.mjs nodeInstallOffer, test-plan.mjs). No new eager file.
    // 9,796,161 (measured for submit.mjs, +4,084, 2026-11-20, finding-dispute): "Dispute this finding" [owner, 2026-11-20]: the
    // decision list's finding rows and the dispute beside the undo of a start SFlow made (decision-list.mjs), a disputed finding
    // kept beside the blocking ones (source-grounded-review.mjs), the author told not to make that fix (source-review-continuation.mjs),
    // the approval's disputes in plain words, the command's route form (action-command-map.mjs) and its words, one new 971-byte
    // leaf (review-dispute-words.mjs). The dispute's reader and writer load only when used (review-finding-dispute.mjs).
    // 9,797,600 (measured 9,797,597 on landing-7, 2026-11-20): the finding dispute and the Node install route together.
    // 9,800,300 (measured 9,800,277 for submit.mjs, +2,677, 2026-11-20, limit audit track B): limits that threw with no code
    // carry one and their facts (state.mjs token budget and work interval, clarifications.mjs, analysis-limits.mjs), a
    // person's one more rework round past a spent budget (repair-budget.mjs) and reject's --beyond-budget boolean (util.mjs).
    // Their routes load only when refused (limit-remediation.mjs, with refusal-remediation.mjs). No new eager file.
    // 9,805,483 (measured on landing-11, 2026-11-20): the three hardening tracks and the optional-questions fix together.
    // SFlow fills the review report's copied values and the files it issued (track A), coded limits with their routes
    // (track B), the VS Code chat routes and approval-page fixes (track C), and optional rows never asked; their commands
    // come from the action-to-command map's named builders. No new eager file.
    // 9,811,199 (measured for submit.mjs, +5,716, 2026-11-20, intents-stage01): step intents stages 0 and 1, a workflow.yml
    // from a newer SFlow refused with the update instead of a factory reset, and `intent:` and `because:` checked on steps
    // when configuration loads (config.mjs), with the ten intents and the settings a reason may name (phase-roles.mjs).
    // The profiles, inference and kind-of-software report load only in workflow check (step-intents.mjs, software-kinds.mjs).
    // No new eager file.
    // 9,821,058 (measured for submit.mjs, the largest, on landing-12, 2026-11-21): step intents stages 0-1 and the coverage fix together.
    // A changed planned file counts for its row (specifications.mjs, spec-coverage-preview.mjs); the review brake is a
    // workflow setting (source-review-policy.mjs). No new eager file.
    // 9,821,123 (measured for submit.mjs, +65, 2026-11-21, timeout-retry): a SUBPROCESS_TIMEOUT names its program and limit
    // (util.mjs run), so a wait's retry says which program and how long [owner, 2026-11-21]. No new eager file.
    // 9,826,934 (measured for submit.mjs, +5,811, 2026-11-21, intents-stage2): step intents Stage 2's hooks only. Version 4,
    // the cheap gate that says whether a workflow.yml opts in (phase-roles.mjs) and where configuration resolves with a
    // derivation (config.mjs). The derivation, the inference and `workflow check --settings` load only when a workflow
    // opts in (step-intent-settings.mjs, step-intents.mjs, workflow-step-settings.mjs; asserted above). No new eager file.
    // 9,821,723 (measured for submit.mjs, +600, 2026-11-21, intents-runtime-review): the runtime check and the reviewer's second
    // pass (step intents §12.3-12.5) register `capability kind` and `app-review runtime-check` (command-registry.mjs, util.mjs
    // --again), refuse an agent's kind confirmation (copilot-mutation-guard.mjs) and show "Try it" at approval (agent-output.mjs).
    // The check, its adapters and the kind record load only when a code review or the command runs. No new eager file.
    // 9,827,849 (measured on landing-14, 2026-11-21): Stage 2's hooks, the runtime check's registrations and the review route builder together.
    // 9,828,644 (measured for submit.mjs, +795, 2026-11-21, intents-stage3): the six intent starter templates' digests
    // (packaged-asset-history.mjs) and the `workflow build intents` action (command-registry.mjs). The table, the Builder's
    // intent moves and the baseline criteria load only where they are used. No new eager file.
    // 9,832,468 (measured for submit.mjs, +4,619, 2026-11-21, marketplace-agents): a marketplace that is a Git repository is
    // checked where configuration loads (marketplace.mjs: its remote, ref and pinned commit), the one ls-remote that pins it and
    // executable files allowed in a read-only catalog's isolated repository (git.mjs), and `workflow from-agent` registered
    // (command-registry.mjs). The catalog reader and the conversion load only for marketplace browse and workflow from-agent
    // (marketplace-repository.mjs, agent-workflow.mjs, agent-workflow-bundle.mjs). No new eager file.
    // 9,833,263 (measured on landing-15, 2026-11-21): step intents Stage 3 and the marketplace agent import together.
    // 9,827,858 (measured on landing-14): capability kind's --confirm read as a typeof check (+9).
    // 9,833,272 (measured on landing-15 with main ce94e5a79): the typeof check and the two option names added.
    // 9,838,896 (measured for submit.mjs, +5,624, 2026-11-21, d1-auto-return): a test step's failing tests go back to the code
    // step on their own (D1). Submission lets a test step that changes no code submit with failing tests, and its approval
    // gives the filled choices (state.mjs); SFlow's own return (rejectPhase `automatic`), the two settled kinds with their
    // words and undo (settled-decisions.mjs, decision-plain.mjs), the settled openings (story-version-opening.mjs), the
    // `submit.returned` outcome and its end of turn (narration/messages.mjs, agent-output.mjs). The rules and the acts load
    // only when a test step's run failed or after a return (failing-tests-return.mjs, failing-tests-opening.mjs). No new eager file.
    // 9,833,472 (measured for submit.mjs, +200, 2026-11-21, intents-stage5): `testEvidenceFrom: false` read as absent where
    // configuration resolves a workflow that does not derive (config.mjs). The upgrade's intent pass loads only in the
    // configuration refresh (step-intents-upgrade.mjs). No new eager file.
    // 9,835,281 (measured for submit.mjs, +2,009, 2026-11-21, loose-ends): a hard gate's answer as a Story value, the
    // skill for another answer left out of a step (skill-library.mjs storyValueCondition, recordedStoryValues,
    // skillAppliesToStory, used in agents.mjs and retained-skill-instructions.mjs). No new eager file.
    // 9,843,339 (measured on the integration branch, 2026-11-21): Stages 4-6, D1 and the loose ends together.
    // 9,835,083 (measured for submit.mjs, +1,811, 2026-11-21, approval-focus): SFlow writes the verification evidence and the
    // release conformance report from its records where the step's content is derivable (owner, 2026-11-21: too many approvals
    // of almost similar documents): prepare and publish call it (state.mjs), the approval act leads with what needs the
    // person's eyes (agent-output.mjs) and the shorter implementation template's earlier digest stays known
    // (packaged-asset-history.mjs). The writer and the focus load only when used (record-documents.mjs, approval-focus.mjs).
    // No new eager file.
    // 9,845,150 (measured on the integration branch with approval-focus, 2026-11-21): the two together.
    // 9,844,341 (measured for submit.mjs, +1,002, 2026-11-21, intents-stage7): convergence folds into the code approval: its
    // rule's words (config.mjs, phase-roles.mjs, step-intent-settings.mjs), the submit refusal (state.mjs, submit.mjs) and
    // the version 2/3 form's `testEvidenceFrom: false` (workspace-configuration-refresh.mjs). The check and its section load
    // only at a convergence step's automatic approval and a code approval's evidence (convergence-section.mjs). No new eager file.
    // 9,846,152 (measured on the integration branch with Stage 7, 2026-11-21): approval-focus and Stage 7 together.
    // 9,846,882 (measured on the integration branch, 2026-11-21): the integration fixes (a narrowed top-level document list
    // kept for derived work types, a version 3 file resolving in the version 2 field order, one word-count line). No new eager file.
    // 9,847,460 (measured, 2026-11-21): the full run's fixes; the failing-tests warning names the code step SFlow returns to,
    // or promises no return when there is none, and the workflow change graph skips a step's reasons. No new eager file.
    // 9,848,538 (measured, 2026-11-22): an accepted risk's expiry refusal says which part is wrong and hands back the
    // decision with an expiry that fits (upstream-issues.mjs, Node 26 weekly fixes). No new eager file.
    // 9,849,943 (measured for submit.mjs, +1,405, 2026-11-22, daily run): a change the person asks for after a code step nobody
    // approves has finished goes back to it on their yes: the return's person-change branch (state.mjs rejectPhase), the
    // typed words kept for that step (asked-for.mjs), its act (agent-output.mjs), the `person-change` settled kind and its
    // words, and the preview route in the map. The rules and the acts load only when used (completed-step-change*.mjs).
    // No new eager file.
    // 9,853,196 (measured for submit.mjs, +3,253, 2026-11-22): a person's sign-off is evidence. The verification table cites it
    // (record-documents.mjs), the draft check names a claimed sign-off the document does not cite (witness-report-findings.mjs),
    // and a sign-off without a screenshot is recorded and read (witness-records.mjs, delivery-evidence.mjs). No new eager file.
    // 9,853,206 (measured, +10): --attest read as a flag (util.mjs BOOLEAN_OPTIONS).
    // 9,853,355 (measured, +149, 2026-11-22): `workflow fix` is /sf-fix-workflow's route too (command-skills.mjs), so the
    // repository check can name it for a custom workflow with a problem. No new eager file.
    // 9,855,100 (measured 9,855,052 for submit.mjs, +1,697, 2026-11-22, d-story): a review of a document SFlow wrote from the
    // records goes to the step that owns them: the review's owner rule (source-grounded-review.mjs) and its one filled raise
    // (source-review-continuation.mjs). Reading the seal loads only when used (record-documents.mjs). No new eager file.
    // 9,855,582 (measured for submit.mjs, +530, 2026-11-23, d-story): every finding a step raises names who fixes it, never the
    // maintainer for want of a rule (phase-resolution.mjs owners, foreignFindingGuidance; phase-finding-policy.mjs conformance
    // codes). No new eager file.
    // 9,858,437 (measured for submit.mjs, +2,855, 2026-11-23): only a step its reviewer reviews promises automatic approval
    // (automatic-approval-possible.mjs, the one new file, read by evidence-receipt.mjs and approval-chain.mjs), and a Story with
    // no clause offers no linked scope choice (owed-decisions.mjs, decision-list.mjs, scope/extract.mjs).
    // 9,862,384 (measured for submit.mjs, +3,947, 2026-11-23): a person overrides a blocking finding the check got wrong,
    // honoured where the checks read their findings (phase-draft-check.mjs, publication-preflight.mjs, conformance-readiness.mjs
    // and publication's specification gate load finding-overrides.mjs only when they run), with its route, guard and words
    // (phase-resolution.mjs, copilot-mutation-guard.mjs, copilot-answer-binding.mjs, person-step-catalog.mjs, decision-list.mjs).
    // No new eager file.
    // 9,863,740 (measured for submit.mjs, +1,356, 2026-11-23, d-story): a return of an upstream issue whose step already
    // goes back for an open return joins it, on the decision list and in its words (upstream-routes.mjs upstreamReturnJoin,
    // decision-list.mjs returnOption, decision-advice.mjs). No new eager file.
    // 9,864,782 (measured for submit.mjs, +1,042, 2026-11-23): in a test run, a submitted release's record documents are checked
    // against their records (submit.mjs submittedRecordDocuments, the step invariants loaded lazily from src/story-invariants.mjs),
    // and the release report's comparison writes it as the writer does (record-documents.mjs composed). No new eager file.
    // 9,868,579 (measured for submit.mjs, +3,797, 2026-11-23): each pinned procedure is also written as a file when a
    // step's prompt is composed, and the catalog names it (retained-skill-instructions.mjs, skill-library.mjs). No new eager file.
    // 9,870,456 (measured for submit.mjs, +1,877, 2026-11-24): Story lessons [LRN-v1]: `lessons` registered and routed
    // (command-registry.mjs, command-skills.mjs), a step refusal noted for its lessons (cli-failure.mjs) and the lessons a
    // step left said after its automatic approval (submit.mjs); the lesson modules load lazily. No new eager file.
    // 9,870,721 (+265, 2026-11-24): `lessons rule`, a team rule a person makes of a lesson (command-registry.mjs). No new eager file.
    // 9,872,232 (measured for submit.mjs, +1,511, 2026-11-25): `work` registered, a task's composed workflow laid over the
    // definition a start reads, and the amendment read through a task Story's composition (command-registry.mjs, state.mjs,
    // start.mjs, configuration-branch.mjs) [ITW M1]; the composer itself loads only for a task. No new eager file.
    // 9,872,488 (+256, 2026-11-25): --new, a task started over one open on its checkout (util.mjs), and /sf-task as the
    // route `nextsteps` names (safe-command-guidance.mjs) [ITW M2]. No new eager file.
    // 9,876,942 (measured for submit.mjs, +4,454, 2026-11-25): a started task gains a step [ITW:REQ-009]: its snapshot dialect
    // read in the accepted chain (workflow-snapshots.mjs), its check beside the test-command one, `work add` registered;
    // its capture, replay and review check load only for a task change. No new eager file.
    // 9,877,758 (measured for submit.mjs, +816, 2026-11-25): a task's code that touches a team's path rule adds the rule's
    // steps after its submission, said in one line (submit.mjs, submit-if-ready.mjs) [ITW:REQ-014]. No new eager file.
    // 9,874,991 (measured for submit.mjs, +2,503, 2026-11-25): a task's chosen skills frozen into its Story's snapshot with
    // the exact text its plan read (workflow-snapshots.mjs), and a loaded definition's marketplaces validated again unchanged
    // (marketplace.mjs) [ITW:REQ-010]; the chooser loads only for a task. No new eager file.
    // 9,880,261 (measured on the merge of both, 2026-11-25): the two rises above together.
    // 9,884,367 (measured on the merge of Ask SFlow R1-R5, 2026-11-25): Ask's registry entry, its record families
    // (schema-migrations.mjs), retained history in the ledger and source inspection, and its log fields. No new eager file.
    // 9,886,373 (measured for submit.mjs, +2,006, 2026-11-25): a task that grows [ITW:REQ-014, REQ-015]: the code's next
    // version after a grown task's plan and the `submit.grown` outcome (submit.mjs, narration/messages.mjs, agent-output.mjs),
    // the migration folders named once (application-paths.mjs MIGRATION_PATH, delivery-evidence.mjs), the `task-grown`
    // settled kind and opening (settled-decisions.mjs, story-version-opening.mjs) and a refactor's after-check at the test
    // step's approval (state.mjs). The growth, its return and the after-check load only for a task. No new eager file.
    // 9,884,511 (measured for submit.mjs, +144, 2026-11-25 on itw-market): MARKETPLACE_UNKNOWN names `marketplace list` as
    // its way on (marketplace.mjs, which every configuration load validates with). No new eager file.
    // 9,886,685 (measured on itw-all with the growth and marketplace merges, 2026-11-25): the two rises above together, the
    // ledger entry refusal's code and the Ask refusals' ways out (ce20208d3). No new eager file.
    // 9,886,541 (measured for submit.mjs at f4427ddba, the merge of itw-grow and itw-agentplan, unrecorded there).
    // 9,891,741 (measured for submit.mjs, +5,200, 2026-11-25 on itw-route): a task's Story carried on by /sf-task in the same
    // chat [ITW:REQ-008]: the task route and its reviewed check (safe-command-guidance.mjs), named on every planner's next
    // actions (guide.mjs, nextsteps.mjs, narration/continuation.mjs, phase-continuation.mjs, step-decision.mjs), and a
    // task's chat kept between its steps (context-policy.mjs, state.mjs, approval-agent-result.mjs, agent-output.mjs,
    // cli-steps.mjs). No new eager file.
    // 9,895,047 (measured for submit.mjs, +3,306, 2026-11-25 on itw-route): a person-facing route is one real command that
    // does what its Copilot route does (owner, 2026-11-25): a closed task's last message as its next action, a started
    // task's /sf-task beside its first step's command (start.mjs), a later step's Shell route as a person runs it
    // (action-command-map.mjs personCommand), the context boundary's one route its reset, and the approval receipt's command
    // marked as a private run (choices.mjs). No new eager file.
    // 9,895,191 (measured on itw-all with itw-route merged, 2026-11-25): the rises above together. No new eager file.
    // 9,886,741 (measured for submit.mjs, +56, 2026-11-25 on itw-store): `marketplace catalog`, the Marketplace page, a
    // marketplace read with its own command module (command-registry.mjs); the page engine loads only for it. No new eager file.
    // 9,897,591 (measured for submit.mjs, +3,046 from 9,894,545 on its base eb20cd6a4, 2026-11-26 on itw-market2; start.mjs
    // 9,897,324, +5,155): an index listing past its hour asks whether it changed (remote-fetch.mjs conditional and
    // remoteValidator, marketplace.mjs), --newest and --discard-edits read as flags (util.mjs), `skill restore` registered
    // and routed (command-registry.mjs, command-skills.mjs), and start's skill check names restore for a packaged skill
    // that does not parse, with the packaged-or-edited test it asks first on (skill-library-problems.mjs). No new eager file.
    // 9,898,216 (measured for submit.mjs on itw-all2 with itw-market2 and itw-turn, 2026-11-26): the two branches' rises together (restore and
    // marketplace routes; a task's turn carried on in chat). No new eager file.
    // 9,896,006 (measured for submit.mjs, +1,461 over 9,894,545 at eb20cd6a4, 2026-11-26 on itw-walks): a refactor's code step
    // stops on a behaviour change before its publication and a person's acceptance returns it to its plan (state.mjs), and
    // `work behaviour` is a person's own step and a registered mutation (person-step-catalog.mjs, command-registry.mjs)
    // [ITW:REQ-015]; the check, the choice and the last message's checks load only for a task. No new eager file.
    // 9,899,677 (measured for submit.mjs on itw-all2 with itw-walks merged, 2026-11-26): the rises above together. No new eager file.
    // 9,900,807 (measured for submit.mjs, +1,130 from 9,899,677 on its base c3b777ab1, 2026-11-26 on itw-market2): the hardened
    // reader keeps a request and its redirects on the origins a trust allows and codes a body over its limit
    // (remote-fetch.mjs), and that size refusal's way on for a link and an index's workflow bundle (limit-remediation.mjs);
    // the bundle's fetch loads only for `workflow import market:…`. No new eager file.
    // 9,904,350 (measured for submit.mjs, +4,673 over 9,899,677 at c3b777ab1, 2026-11-26 on itw-walks; start.mjs 9,903,490,
    // +3,881): the Story value a step's clarification asks in a marketplace agent's words, read where a submission's values
    // are (phase-roles.mjs, workflow-decisions.mjs, and for submit submission-readiness.mjs and its own read), and `work
    // behaviour` as a person's step the decisions card records (model-free-commands.mjs, person-step-catalog.mjs)
    // [ITW:REQ-011, REQ-015]; the card's item, the edited-test check and the plan label load only for a task. No new eager file.
    // 9,904,620 (measured on itw-all2 with itw-walks 99f7271c9 and itw-market2 9d32837b4 merged, 2026-11-26). No new eager file.
    // 9,905,480 (measured on itw-all2 with itw-walks 99f7271c9 and itw-market2 9d32837b4 merged, 2026-11-26). No new eager file.
    // 9,905,847 (measured for submit.mjs, +367 over 9,905,480 at 42731f7ca, 2026-11-26 on itw-walks; start.mjs 9,904,987, +367):
    // a refactor's behaviour choice as a family SF Guard signs and counts, with the words its card names it by
    // (person-step-catalog.mjs) [ITW:REQ-015]. No new eager file.
    // 9,906,063 (+216, measured 2026-11-26 on itw-all2 merged with main 867d6da4a): main's Ask SFlow Story conversation and
    // local help commits, small edits across modules the closure already held. No new eager file.
    // 9,906,163 (measured for submit.mjs, +100 over 9,906,063 at 480c2f936, 2026-11-26 on fpl-m1; start.mjs 9,905,573, +370):
    // `needs-you` registered as a read with /sf-inbox as its skill (command-registry.mjs, command-skills.mjs), and Story
    // discovery skips a Story Needs you keeps (session-story-discovery.mjs) [FPL:REQ-017]. No new eager file.
    // 9,906,598 (measured for submit.mjs, +535 over 9,906,063 at 480c2f936, 2026-11-26 on omk-m1; start.mjs 9,905,738, +535):
    // an index's channels and its entries' owners and lifecycles, read through the reader fetchMarketplaceIndex loads only
    // when it fetches an index (marketplace.mjs) [OMK:REQ-005]; the lifecycle, owner and CODEOWNERS readers stay lazy.
    // No new eager file.
    // 9,906,698 (measured for submit.mjs on m1-int with fpl-m1 and omk-m1 merged, 2026-11-26; start.mjs 9,906,108): the two
    // branches' rises together. No new eager file.
    // 9,915,050 (measured for submit.mjs, +8,987 over 9,906,063 at 480c2f936, 2026-11-26 on ssb-m1; start.mjs
    // 9,914,178): one resolver joins a Story's paths [SSB:REQ-009] (story-paths.mjs storyLocation and its record
    // classifiers; the state-ref arm is named only by its own tests in M1), clarificationRecordRelative beside its twin
    // in phase-generation.mjs, and the first small helpers moved to the resolver (SSB M1 B0, B1). No new eager file.
    // 9,916,795 (measured for submit.mjs, +1,745, 2026-11-26 on ssb-m1; start.mjs 9,915,869): the Story state kernel
    // joins a Story's paths through the resolver (state.mjs and 28 kernel modules, SSB M1 B2); a resolver call is
    // longer than the helper it replaces. No new eager file.
    // 9,917,391 (measured for submit.mjs, +596, 2026-11-26 on ssb-m1; start.mjs 9,916,515): steps, prompts and phase
    // records join through the resolver, and storyRecordWithin reads a Story from a path below another folder (SSB M1
    // B3). No new eager file.
    // 9,917,440 (measured for submit.mjs, +49, 2026-11-26 on ssb-m1; start.mjs 9,916,556): publication, recovery and
    // Git join a Story's paths through the resolver (SSB M1 B6). No new eager file.
    // 9,917,446 (measured for submit.mjs, +6, 2026-11-26 on ssb-m1; start.mjs 9,916,616): discovery, sessions,
    // workspaces, the editor and the hook-side guards join a Story's paths through the resolver (SSB M1 B9). No new
    // eager file.
    // 9,917,462 (measured for submit.mjs at the end of SSB M1, 2026-11-26 on ssb-m1; start.mjs 9,916,444): +11,399 over
    // 9,906,063 at 480c2f936 for all of M1, most of it story-paths.mjs (~10 KB), the Story path resolver [SSB:REQ-009].
    // No new eager file.
    // 9,918,097 (measured for submit.mjs on m1-int with fpl-m1, omk-m1 and ssb-m1 merged, 2026-11-26; start.mjs 9,917,349):
    // the three branches' rises together. No new eager file.
    // 9,907,027 (+329, measured 2026-11-26 on itw-local over 9,906,698 at 8a386d941; start.mjs 9,906,437, +329): a task's
    // skill of the repository's own (.github/skills or .agents/skills) is frozen into its snapshot from where the plan read
    // it (workflow-snapshots.mjs) [ITW:REQ-020]; the reading and choosing stay lazy (task-local.mjs). No new eager file.
    // 9,918,426 (measured for submit.mjs on main 30484105e with itw-local merged, 2026-11-26; start.mjs 9,917,678): the +329
    // above on top of the three bets' M1. No new eager file.
    // 9,919,298 (measured for submit.mjs, +1,201, 2026-11-26 on wm-clean; start.mjs 9,918,550): packaged-asset-history.mjs
    // keeps the earlier digests of the two agents and five Initiative templates that stopped naming the removed World
    // Model, so a refresh replaces them. No new eager file.
    // 9,919,627 (measured for submit.mjs on main 53e996c00 with wm-clean merged, 2026-11-26; start.mjs 9,918,879): the +1,201
    // above on top of itw-local. No new eager file.
    // 9,918,831 (+734, measured for submit.mjs 2026-11-26 on wmr-m1m2; start.mjs 9,918,083): `wm knowledge slice` is refused by name as retired, pointing to `wm brief --phase` (removed-features.mjs,
    // command-registry.mjs) [WMR:REQ-027]. No new eager file.
    // 9,919,188 (+357, measured for submit.mjs 2026-11-26 on wmr-m1m2 over d8c802e71; start.mjs 9,918,440): worldModel.knowledge.prompt may name steps, and a work type's
    // intelligence.worldModel may be `on` (config.mjs, intelligence-policy.mjs) [WMR:REQ-011]. No new eager file.
    // 9,920,718 (measured for submit.mjs on main 4c8b464a6 with wmr-m1m2 merged, 2026-11-26; start.mjs 9,919,970): the
    // +1,091 above on top of wm-clean. No new eager file.
    // 9,928,350 (measured for start.mjs, +12,742 over 9,915,608 at 2809f6edc, 2026-11-26 on ssb-m2; submit.mjs 9,926,916,
    // +10,560): a Story under story.storage: state-ref keeps its records on its state ref [SSB M2]: the resolver's
    // layout memory, records root and refusing prefix (story-paths.mjs), the pinned-copy read root
    // (configuration-read-scope.mjs), the setting (work-item-location.mjs, config.mjs), the state checkout found by the
    // Story index and on a read that finds no Story (repository-subject-index.mjs, story-workflow-read.mjs), the
    // start-path records through the records root (workflow-snapshots.mjs, state.mjs, work-intervals.mjs,
    // story-policy-anchor.mjs, story-state-write.mjs), resume's state fetch (start-context.mjs) and start recovery
    // (story-start-journal.mjs). The state ref's own module loads lazily. No new eager file.
    // 9,931,269 (measured for start.mjs, +2,919 over 9,928,350, 2026-11-27 on ssb-m2; submit.mjs 9,927,921): state-ref is
    // held back to today's layout unless its preview is on (work-item-location.mjs newStoryLayout, the resolution in
    // config.mjs), and the command-line start opens the state ref and says the held line (commands/start.mjs). No new
    // eager file.
    // 9,933,663 (measured for start.mjs, +2,394 over 9,931,269 at d99e2d11d, 2026-11-27 on fix-suite-1127): the state
    // checkout's Git reads go through the source inspection facade (checkoutPlace, checkoutChanges, indexEntries,
    // sourceTree; source-inspection.mjs +2,131) [SDA-AC-001], and the state-ref publication is named beside the
    // adapter (story-publication-service.mjs +263). No new eager file.
    // 9,934,063 (measured for start.mjs, +400 over 9,933,663 at 126eb798d, 2026-11-27 on omk-m3): a Story's start says
    // what its marketplace deprecated or retired of what its workflow was made from or attaches (commands/start.mjs
    // +400; the reading is marketplace-in-use.mjs, loaded lazily and only with a marketplace trusted) [OMK:REQ-041]. No
    // new eager file.
    // 9,934,141 (measured for start.mjs, +78 over 9,934,063 on the merge of fpl-m3 with main 4b925b87d, 2026-11-27;
    // submit.mjs 9,930,393, +78): `rules` registered as a read with /sf-explain as its skill (command-registry.mjs +53,
    // command-skills.mjs +25) [FPL:REQ-019, REQ-038]. No new eager file.
    // 9,938,035 (measured for start.mjs, +3,894 over 9,934,141 on the merge of fix-source-loop with main f6353df44,
    // 2026-11-27; submit.mjs 9,934,287): an editor's or IDE's own files (.vscode/, .idea/, Eclipse metadata) never stop
    // a step: not a document step's submission, as its publication already said, nor a code step's start, plan question
    // or approval (application-paths.mjs isEditorConfigurationPath +588, state.mjs +1,012, generation-boundary.mjs
    // +302, candidate-scope.mjs +203, lifecycle-worktree.mjs +423, recovery-preparation-context.mjs +66,
    // finding-escalation.mjs); with no return a refusal's route is the set-aside, never a plan decision, and it waits
    // on the person, never escalated (cross-phase-change.mjs +760) [office loop, 2026-11-27]. No new eager file.
    // 9,938,047 (measured for start.mjs, +12 over 9,938,035, 2026-11-27 on fix-source-loop; submit.mjs 9,934,299): the
    // set-aside command is the map's own setAsideCommand (action-command-map.mjs +118), so state.mjs routes no command
    // itself [OSA:AC-020]. No new eager file.
    assert.ok(closure.bytes <= 9_938_047, `${file} exceeds the 9 MB eager-source budget (${closure.bytes} bytes)`);
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
  // 862,250 (measured 862,203): `decision witness-defer` is a person's mutation [PHR:REQ-007] (command-registry.mjs +17),
  // which every command reads to dispatch; the command itself loads lazily.
  // 864,550 (measured 864,534): /sf-status and the other utility reads accept --work-id, and a refused read names
  // the option and the exact command to run (utility-entry.mjs +2.3 KB) [Story anu-bin, 2026-11-11].
  // 864,800 (measured 864,795): `workflow walk` and `workflow fix` (command-registry.mjs), and doctor --repair-hooks
  // classified as SFlow's own mutation so a live turn's baseline moves past it (command-registry.mjs) [2026-11-12].
  // 865,250 (measured 865,237): `confirm <CODE>` is registered and the entry swaps it for its command before dispatch
  // (command-registry.mjs, cli-entry.mjs); the expansion itself loads lazily [owner, 2026-11-12].
  // 865,300 (measured 865,257): every kept --for-agent result also keeps the view the agent was shown, for the
  // post-tool hook to hand over when a host showed nothing (cli-json-output.mjs +20) [office, 2026-11-12].
  // 865,900 (measured 865,873): a refused request for objects by ID, which a second laptop's blobless clone makes,
  // has its own classification and advice (git-remote-diagnostics.mjs +590) [owner, 2026-11-13].
  // 866,100 (measured 866,068): `decisions undo`, a person's undo of what was settled for them, is a registered
  // mutation (command-registry.mjs +195) [owner, 2026-11-13]. No new eager file.
  // 866,450 (measured 866,429): the window heartbeat is machine-local upkeep, a third command class (command-registry.mjs
  // OPERATION_CLASSES, cli-entry.mjs) [SPEC-SCF stage 1d, 2026-11-15]. No new eager file. Still holds on the merge with
  // main 4ac5c5c40 (measured 866,439: `workflow assess` is a registered read, +10).
  // 867,700 (measured 867,672): SFlow's agents move to singularity/agents [SPEC-AGH, owner 2026-11-14]: the
  // transport policy reads the layout workflow.yml records, declared where configuration locations are
  // (configuration-assets.mjs +1,643). The migration itself stays lazy (agents-home-migration.mjs). No new eager file.
  // 867,850 (measured 867,845): the one resolver of where agents live [AGH:REQ-028, owner 2026-11-15]: agentFileIn and its
  // comment (configuration-assets.mjs +173). No new eager file.
  // 868,300 (measured 868,255): the agents home above (+1,816) merged with main 04a6f2adc and its SPEC-SCF stage 1
  // (866,439 there) [2026-11-16]. No new eager file.
  // 869,150 (measured 869,135): a step name typed by mistake names the Story's steps (util.mjs unknownStepDetails +880)
  // [2026-11-16]. No new eager file.
  // 870,250 (measured 870,201): SPEC-SCF stage 5: a moved active workspace's refusal names `workspace repair` (built in
  // workspace-relink.mjs, which stays lazy), `workspace repair <CLONE>` leases a clone in no workspace (cli-entry.mjs +941)
  // and the folder-gone refusal names repair for a Story checkout (util.mjs +526) [2026-11-16]. No new eager file.
  // 870,900 (measured 870,863, +662 on the 870,201 above): the 11-17 landing puts the branches' registrations on one tree:
  // OSA's `phase opening --reconcile` and SCF's `configuration approve`/`reject` for every proposal kind
  // (command-registry.mjs +339, util.mjs +51, the rest in their small imports). Each was under 869,150 alone. No new eager file.
  // 871,100 (measured 871,089, +226): the review of CVL piece 1 (2026-11-17), `tests held` registered as a read and its
  // `--set-aside` as the person's mutation (command-registry.mjs). No new eager file.
  // 871,150 (measured 871,104, +15): `--as-question` is a boolean option the parser knows (util.mjs BOOLEAN_OPTIONS), for the
  // third account of what a person typed (owner, 2026-11-18). No new eager file.
  // 871,180 (measured 871,180, +76): the local browser service's `ui` command, registered as an upkeep family
  // (command-registry.mjs), kept out of repository routing and the mutation lease (cli-entry.mjs) and its `--drain`
  // boolean (util.mjs) [local service merge, 2026-11-18]. The service itself stays lazy (src/local-ui/). No new eager file.
  // 871,600 (measured 871,573, +469): a refused command derives the live Copilot turns again, as a successful one does, so a
  // test failure recorded mid-turn never ends the turn as stale; both paths share one helper (cli-entry.mjs refreshTurns)
  // [owner, 2026-11-18, Story new-ash-graph]. No new eager file.
  // 871,650 (measured 871,645, +72): `singularity-flow update` registered (command-registry.mjs) and kept out of
  // repository routing and the mutation lease (cli-entry.mjs) [owner, 2026-11-19]. The updater stays lazy
  // (src/commands/update.mjs loads runtime/update.mjs only when run). No new eager file.
  // 873,000 (measured 872,976, +1,601 over 871,375): Git work SFlow starts by itself waits for an idle laptop (owner,
  // 2026-11-19): every foreground command that is not upkeep stamps the laptop's activity, lazily (cli-entry.mjs +213), and
  // the operating system's input idle time is read through the registered process owner (platform-process.mjs +1,388).
  // The stamp itself (machine-activity.mjs) loads lazily. No new eager file.
  // 873,300 (measured 873,289 on landing-5, 2026-11-19): the update command and the idle stamp together (+72 and +1,601 above).
  // 873,438 (measured 873,438, +149, 2026-11-19): `decisions learn` registered as a read (command-registry.mjs), the
  // read-only report of how often answers followed the recommendation [owner, 2026-11-19, Q13]. No new eager file.
  // 873,501 (measured 873,501, +63, 2026-11-19): `--recommended` in the parser's boolean options (util.mjs) [C10]. No new eager file.
  // 873,308 (measured 873,308, +19 over 873,289, 2026-11-19 on ceremony-turns): `--review-findings`, the settled start of a
  // review's next version, is a boolean option the parser knows (util.mjs). No new eager file.
  // 873,320 (measured 873,314, +25): `guard card` (a read: SF Guard's card for the Decide card and approval page) and
  // `guard setup` (the person's own step) registered (command-registry.mjs) [owner, 2026-11-19]. No new eager file.
  // 873,555 (measured on landing-6, 2026-11-20): `decisions learn`, `--recommended`, `--review-findings` and `guard card|setup` together.
  // 873,588 (measured 873,588, +33, 2026-11-20, finding-dispute): `review-source dispute` registered as a mutation
  // (command-registry.mjs) [owner, 2026-11-20]. No new eager file.
  // 873,717 (measured 873,717, +129, 2026-11-20, limit audit track B): reject's `--beyond-budget`, a person's one more rework
  // round, is a boolean option the parser knows (util.mjs). No new eager file.
  // 873,782 (measured 873,782, +65, 2026-11-21, timeout-retry): a SUBPROCESS_TIMEOUT names its program and limit (util.mjs
  // run), so a wait's retry says which program and how long. No new eager file.
  // 873,794 (measured 873,794, +12, 2026-11-21, intents-stage2): `workflow check --settings`, each step's settings and where
  // each came from, is a boolean option the parser knows (util.mjs). No new eager file.
  // 874,195 (measured 874,195, +413, 2026-11-21, intents-runtime-review): `capability kind` (a read, and its person-confirmed
  // record) and `app-review runtime-check` registered (command-registry.mjs), with --again a boolean (util.mjs). No new eager file.
  // 874,207 (measured on landing-14, 2026-11-21): Stage 2's hooks and the runtime check's registrations together.
  // 874,218 (measured, +11, 2026-11-21, intents-stage3): the `workflow build intents` action (command-registry.mjs); no new file.
  // 874,679 (measured, +472, 2026-11-21, marketplace-agents): `workflow from-agent` registered, a read without --out or
  // --propose (command-registry.mjs). No new eager file.
  // 874,690 (measured on landing-15, 2026-11-21): step intents Stage 3 and the marketplace agent import together.
  // 874,216 (measured on landing-14): capability kind's --confirm read as a typeof check (+9).
  // 874,699 (measured on landing-15 with main ce94e5a79): the typeof check and the two option names added.
  // 874,709 (measured, +10, 2026-11-22): --attest, a person's sign-off with no screenshot, read as a flag (util.mjs).
  // 874,729 (measured, +20, 2026-11-23): `decision override-finding` registered (command-registry.mjs). No new eager file.
  // 875,334 (measured, +605, 2026-11-24): `lessons` registered with its read and its three writes, and a step refusal
  // noted for its lessons (command-registry.mjs, command-loaders.mjs, cli-failure.mjs). No new eager file.
  // 875,350 (+16, 2026-11-24): `lessons rule` (command-registry.mjs). No new eager file.
  // 875,926 (+576, 2026-11-25): `work`, a task's plan and Story, registered with --start read as a flag (command-registry.mjs,
  // command-loaders.mjs, util.mjs) [ITW M1]. No new eager file.
  // 875,984 (+58, 2026-11-25): --new read as a flag (util.mjs) [ITW M2]. No new eager file.
  // 876,614 (+630, 2026-11-25): `work add` and `work skip` registered (command-registry.mjs) [ITW:REQ-009]. No new eager file.
  // 876,763 (measured, +149, 2026-11-25): `review-source submit` asks the branch tip early (cli-entry.mjs) and stage's agent
  // view is output-only like check's (cli-json-output.mjs). No new eager file.
  // 876,625 (+11, 2026-11-25): `skill catalog`, every skill here and in trusted marketplaces, a skill read (command-registry.mjs). No new eager file.
  // 876,774 (the two rises above together, 2026-11-25).
  // 878,930 (measured on the merge of Ask SFlow R1-R5, 2026-11-25): `ask` registered, its read skipping the deferred index
  // refresh (cli-entry.mjs) and its record families (schema-migrations.mjs). No new eager file.
  // 879,086 (+156, measured on itw-all, 2026-11-25): the Ask handoff's for-agent refusal names `help work` (cli-entry.mjs) and
  // `work` refuses a skill's name as a task's words (command-registry help). No new eager file.
  // 879,110 (measured at f4427ddba, the merge of itw-grow and itw-agentplan, unrecorded there; itw-route adds nothing here).
  // 879,142 (+56, measured on itw-store, 2026-11-25): `marketplace catalog`, the Marketplace page, a marketplace read with its
  // own command module (command-registry.mjs; command-loaders.mjs names it in an import the root does not follow). No new eager file.
  // 879,142 (measured on itw-all with itw-store, 2026-11-25): `marketplace catalog` registered (command-registry.mjs). No new eager file.
  // 879,356 (+214, measured 2026-11-26 on itw-market2): `marketplace catalog --newest` and `skill restore --discard-edits`
  // read as flags (util.mjs), and `skill restore` registered (command-registry.mjs). No new eager file.
  // 879,170 (measured, +28, 2026-11-26 on itw-walks): `work behaviour` registered as a mutation (command-registry.mjs)
  // [ITW:REQ-015]. No new eager file.
  // 879,384 (measured on itw-all2 with itw-walks merged, 2026-11-26): `work behaviour` and the marketplace's new options registered. No new eager file.
  // 879,468 (+84, measured 2026-11-26 on fpl-m1): `needs-you` registered as a read and left out of active-workspace
  // routing, as `inbox` is (command-registry.mjs, cli-entry.mjs) [FPL:REQ-010]. No new eager file.
  // 888,269 (measured, +8,885, 2026-11-26 on ssb-m1): schema-migrations.mjs tests a Story record's family on the path
  // inside the Story, which the resolver reads (storyRecordOf), so story-paths.mjs joins root dispatch [SSB:REQ-009,
  // SSB M1 B10]. One new eager file, story-paths.mjs (40 files, the budget above); util.mjs, its only import, was
  // already here.
  // 888,312 (measured, +43, 2026-11-26 on ssb-m1): cli-entry.mjs's tracked-subjects glob names the Stories folder
  // through storiesRoot() (SSB M1 B11). No new eager file.
  // 888,719 (measured, +407, 2026-11-26 on ssb-m1): the resolver's layout refusals name their way out, an SFlow update
  // (story-paths.mjs). No new eager file.
  // 888,803 (measured on m1-int with fpl-m1, omk-m1 and ssb-m1 merged, 2026-11-26): the rises above together; the one new
  // eager file is ssb-m1's story-paths.mjs.
  // 889,537 (+734, measured 2026-11-26 on wmr-m1m2): `wm knowledge slice` is refused by name as retired, pointing to `wm brief --phase` (removed-features.mjs,
  // command-registry.mjs) [WMR:REQ-027]. No new eager file.
  // 890,053 (+516, measured 2026-11-26 on wm-dead over 0aaac1bb4): doctor names an agent file that still carries the
  // retired sflow-world-model-views header, once (removed-features.mjs) [WMR:REQ-005]. No new eager file.
  // 894,302 (+4,249, measured 2026-11-26 on ssb-m2 over 2809f6edc): every command in a clone that keeps a state-ref
  // Story makes its state checkout right at entry, known from files only (cli-entry.mjs +1,004); the resolver's layout
  // memory and records root (story-paths.mjs) and the pinned-copy read root (configuration-read-scope.mjs) [SSB M2].
  // No new eager file.
  // 879,344 (+258, measured 2026-11-25 on vsc-agenthost-hooks): a command a Copilot chat runs says when SFlow's hooks never saw
  // the chat (cli-entry.mjs loads copilot-chat-hooks.mjs only then). No new eager file.
  // 894,560 (+258, measured 2026-11-27 on the merge of vsc-agenthost-hooks onto 5c682d8c1): the hooks note above. No new eager file.
  // 894,613 (+53, measured 2026-11-27 on fpl-m3 over 70131c215): `rules` registered as a read (command-registry.mjs)
  // [FPL:REQ-019]. No new eager file.
  assert.ok(root.bytes <= 894_613, `root dispatch loads ${root.bytes} source bytes`);
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
  // 221: confirm-code.mjs, which builds the short code a confirmation route carries [owner, 2026-11-12].
  assert.ok(current.files.size <= 221, `session current reaches ${current.files.size} files; old session handler reached 429`);
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
  // 4,188,500 (measured 4,188,489): the plan's corrections for a planned fulfillment the delivery cannot meet
  // (delivery-evidence.mjs +1950) [PHR:REQ-003].
  // 4,189,950 (measured 4,189,942): a plan row removed for a clause an amendment removed, read where every plan is read
  // (plan-row-corrections.mjs +1050, specifications.mjs +389) [PHR:REQ-002].
  // 4,190,300 (measured 4,190,259): a plan row upheld against the approved intent (verification/intent.mjs +265,
  // specifications.mjs +52) [PHR:REQ-003].
  // 4,190,800 (measured 4,190,757): the witness-deferral person step (person-step-catalog.mjs +481, command-registry.mjs +17) [PHR:REQ-007].
  // 4,191,900 (measured 4,191,853): a plan row an intent amendment carries is in force once it is approved
  // (plan-row-corrections.mjs +1096) [PHR:REQ-008].
  // 4,192,050 (measured 4,192,007): the same repository test commands as start (external-command-policy.mjs, config.mjs)
  // [RTC:REQ-001, REQ-002, REQ-011].
  // 4,193,250 (measured 4,193,219): phase-responsibility batch 1 merged with repository test commands (the two sets above
  // together).
  // 4,199,400 (measured 4,199,393): phase-responsibility batch 2 merged with main (the sets above together).
  // 4,200,200 (measured 4,200,180): the visual-risk person step (person-step-catalog.mjs +477, command-registry.mjs +15), and
  // the level-2 pin (phase-roles.mjs +295) [PHR:REQ-006].
  // 4,201,100 (measured 4,201,051): a revised clause's row kept as it stands (plan-row-corrections.mjs +871) [PHR:REQ-008].
  // 4,203,750 (measured 4,203,735): a code step's later steps' repository tests, resolved at Story start (config.mjs +2684) [PHR:REQ-007].
  // 4,208,500 (measured 4,208,463): a reviewer in every authored step of a new Story, code included, pinned at its start
  // [review level 2] (source-review-policy.mjs +3611, config.mjs +801, phase-roles.mjs +314). Its evaluator stays lazy.
  // 4,209,100 (measured 4,209,083): the clarification reply file's exact shape on every route that records replies
  // (phase-staging-paths.mjs CLARIFICATION_RESPONSE_FORMAT, clarifications.mjs) [Story anu-bin, 2026-11-11]. No new eager file.
  // 4,212,000 (measured 4,211,990): the 2026-11-11 class sweep merged (agent-input refusals and copy-slip checks in
  // text-lines.mjs, the utility entry's --work-id, agent-view wording). No new eager file.
  // 4,214,950 (measured 4,214,929): the same test-support rule (source-boundary.mjs, supporting-changes.mjs) [office, 2026-11-11].
  // 4,237,150 (measured 4,237,138): the 2026-11-12 after-demo merge, mostly the packaged template digests of the
  // one-line, marked template guidance (packaged-asset-history.mjs +14.8 KB) and the governed-roots and deployed-URL
  // checks. No new eager file.
  // 4,244,150 (measured 4,244,138): a confirmation route's short code (confirm-code.mjs, the one new file above).
  // 4,245,250 (measured 4,245,212): the POC workflow templates' released bytes stay registered after their clause
  // anchors took each Story's Work ID (packaged-asset-history.mjs +1,062) [office, 2026-11-12]. No new eager file.
  // 4,246,800 (measured 4,246,748): the same, the applicability rule and Test run's registered assets [owner, 2026-11-12].
  // 4,247,750 (measured 4,247,717): confirmation routes read as short codes for commits and plan IDs too (confirm-code.mjs
  // and the route words, +969) [owner, "fix the remaining hash screens", 2026-11-12]. No new eager file.
  // 4,249,300 (measured 4,249,267): intent amendments from chat [owner, 2026-11-13]: acknowledging one is a person's own
  // step (person-step-catalog.mjs +266) on the decisions card (source-review-policy.mjs +344), an authoring turn may write
  // the amendment draft (phase-staging-paths.mjs +382), /sf-reject's propose route (copilot-guidance.mjs +303) and the
  // clarification protocol's amendment route (clarifications.mjs +255). The pause itself stays out of this graph
  // (intent-amendment-pause.mjs). No new eager file.
  // 4,250,100 (measured 4,250,094): a second laptop's blobless clone [owner, 2026-11-13]: a refused request for
  // objects by ID has its own classification and advice (git-remote-diagnostics.mjs +590), and a Story's
  // creation blobs are asked for without "have" lines (workflow-snapshots.mjs +206). No new eager file.
  // 4,251,800 (measured 4,251,750): settled decisions [owner, 2026-11-13]: a person's undo is their own step and its
  // record a review-safe person record, read on every hook (person-step-catalog.mjs +560); a file a plan row covers and
  // a settled Node's version file count with the plan, read where the plan is (plan-amendments.mjs +901, no import);
  // `decisions undo` is registered (command-registry.mjs +195); /sf-session's entry says a settled Story is opened
  // (copilot-mode.mjs +93). What records, reads and undoes them stays lazy (settled-decisions.mjs). No new eager file.
  // 4,250,772 (measured): a decision's VS Code route is the Decide card, never "not available for this action",
  // also where a route arrives without its model-free field [owner, 2026-11-13] (model-free-commands.mjs +678). No new eager file.
  // 4,252,450 (measured 4,252,428): both of the above together on one branch, each one's growth as measured (+1,656 and
  // +678); the card's advice (decision-advice.mjs) and the settled list stay lazy. No new eager file.
  // 4,253,612 (measured): SPEC-CIC stage 6's one change impact setting and the scope-change authority it names are
  // normalized and checked where the spec block already is (specifications.mjs +941, config.mjs +277); the class rules,
  // the card's class and the chat entry stay lazy (amendment-class.mjs). No new eager file.
  // 4,253,836 (measured): the chat entry's two turns and its one step in the person-step catalog, which every hook reads
  // (person-step-catalog.mjs +224); its check stays in the lazily loaded answer binding. No new eager file.
  // 4,253,868 (measured on the merge with main 153e78d1a): main's own growth since (+32) on top of the two above.
  // 4,256,000 (measured 4,255,985 on the merge with main 7f0d9b738): every decision the Decide card records has the card
  // as its VS Code route, and an intent amendment's decision or acknowledgement and a settled one's undo the card as their
  // Copilot route too, read wherever a route is shown (model-free-commands.mjs +1,751, safe-command-guidance.mjs +366)
  // (paid run, 2026-11-14), on top of the 4,253,868 above. No new eager file.
  // SPEC-CIC stage 7 turns change impact on by default and pins it either way, and a work
  // type opts out over its repository by the same rule (specifications.mjs +1,134, config.mjs -34; owner, 2026-11-15);
  // the counts and the report section stay lazy (change-impact-counts.mjs). No new eager file.
  // The person's own steps the Decide card records (an accepted risk, test-run risk or
  // test command, a reused run, a screen size, a sign-off) have the card as their Copilot route too, wherever a route
  // is derived (model-free-commands.mjs +629, copilot-guidance.mjs +409, person-step-catalog.mjs +70) [owner, 2026-11-15].
  // No new eager file.
  // 4,258,200 (measured 4,258,193): the two above together, measured where both land (2026-11-15).
  // A cached GitHub account answers only the environment and Git email it was resolved
  // for, and an agent session's actor only the environment that chose it (git.mjs +2,141, session.mjs +438) (real run,
  // 2026-11-15: one person's login and name were on another person's records). No new eager file.
  // 4,260,800 (measured 4,260,782): the three above together with workflow assess, measured for the stable build (2026-11-15).
  // SPEC-SCF stage 1 [2026-11-15]: the upkeep class (command-registry.mjs, +316) [1d], and configuration commits name
  // the person, read past a transport's hidden Git configuration (git.mjs configurationCommitIdentity, +1,077) [1b].
  // No new eager file.
  // 4,262,200 (measured 4,262,175): stage 1 on top of the stable build's 4,260,782, measured on the merge with main
  // 4ac5c5c40 (2026-11-15).
  // 4,257,800 (measured 4,257,780): the agents home [SPEC-AGH, owner 2026-11-14]: the layout signal read
  // where configuration loads, and init's layout (config.mjs +1,678), the init mappings for either layout
  // (initialization-assets.mjs +1,305), the legacy root governed only when no source records a layout
  // (application-paths.mjs +500), the layout and the transport policy (configuration-assets.mjs +1,643) and moved
  // agents' package history (packaged-asset-history.mjs +226). The migration, its preview and its lines stay lazy
  // (agents-home-migration.mjs). No new eager file.
  // 4,257,850 (measured 4,257,812): the same, merged with main 153e78d1a (+32 there). No new eager file.
  // 4,258,950 (measured 4,258,907): the agents home above, merged with main 7f0d9b738 and its SPEC-CIC stage 6
  // (4,253,868 there): +5,039 for the agents home on that base [2026-11-15]. No new eager file.
  // 4,261,050 (measured 4,261,024): the agents home, merged with main bd90bcc46 and its Decide card routes (4,255,985
  // there): +5,039 for the agents home on that base [2026-11-15]. No new eager file.
  // 4,261,350 (measured 4,261,313): the one resolver of where agents live [AGH:REQ-028, owner 2026-11-15]
  // (configuration-assets.mjs +173, an import in clone-strategy.mjs, initialization-assets.mjs, skp-contract.mjs and
  // specifications.mjs; application-paths.mjs -103, config.mjs -23). No new eager file.
  // 4,267,550 (measured 4,267,503): the agents home above (+5,328) merged with main 04a6f2adc and its SPEC-SCF stage 1
  // (4,262,175 there) [2026-11-16]. No new eager file.
  // 4,262,850 (measured 4,262,833): the registered Git query a reset's Story checkout reads use (SDA-AC-001, 2026-11-16).
  // 4,268,200 (measured 4,268,161): the agents home (4,267,503) merged with main 27361670a and its registered Git query
  // (+658) [2026-11-16]. No new eager file.
  // 4,268,650 (measured 4,268,636): the same, for an open next version [2026-11-16].
  // 4,269,550 (measured 4,269,516): a step name typed by mistake names the Story's steps (util.mjs unknownStepDetails +880)
  // [2026-11-16]. No new eager file.
  // 4,268,300 (measured 4,268,279): upgrade-direct merged with main 5a1d62130: the upgrade clears each registered clone's
  // stale history copies through one registered query (git-query.mjs configuration.local-superseded-refs, +510), and
  // configuration history cleanup and its refs helper are removed [owner, 2026-11-16]. No new eager file.
  // 4,271,500 (measured 4,271,462): the 2026-11-16 batch on main 56dfa031e (4,269,516): the same registered worktree list
  // (git-query.mjs +520) and `phase rollover` as the step author's route, with its step in the Copilot route
  // (code-delivery-policy.mjs +457, copilot-guidance.mjs +466, command-skills.mjs +326, safe-command-guidance.mjs +260,
  // +1,509). No new eager file.
  // 4,271,600 (measured 4,271,580): the 2026-11-16 batch and the one-click direct upgrade together on main 6343414ae.
  // 4,273,400 (measured 4,273,377): SPEC-OSA stage 1 (+1,915): the one "being written" test (phase-generation-need.mjs),
  // the open-version helper (code-delivery-policy.mjs) and the step's work command on the task's own entry
  // (workflow-task-store.mjs, phase-authoring-progress.mjs) [OSA Stage 1]. No new eager file.
  // 4,273,500 (measured 4,273,495): OSA v1 stage 1 merged on top of the batch and the direct upgrade [2026-11-16].
  // 4,277,600 (measured 4,277,571, +4,076): SPEC-OSA v1.1 Stage 1 moves the version predicates into the kernel
  // (kernel/step-versions.mjs, 5,083 bytes) and deletes phase-inspection-generation.mjs, so the file count stays 221. The
  // moved bodies cost what they did; the rise is the new §4.3 checks (one opening number, bounded counters) and the record
  // adapter (phase-generation-need.mjs versionFactsOf). The reducer (kernel/step-state.mjs) stays out of this closure.
  // 4,279,100 (measured 4,279,049, +1,478): SPEC-OSA v1.1 Stage 2. The record adapter names an opening's provenance and
  // its reservation (phase-generation-need.mjs openingFactsOf and counters, +784), the one version arithmetic never reuses a
  // reserved number (kernel/step-versions.mjs, +375) and `phase opening --reconcile` is registered (command-registry.mjs,
  // +~330). The opening operation, its consent and its acceptance reader stay out of this closure. No new eager file.
  // 4,278,500 (measured 4,278,480): SPEC-SCF stage 5 (+5,103): `workspace repair`'s registered Git queries (git-query.mjs
  // +1,922) and worktree mutations (git.mjs +1,091), the folder-gone refusal's route (util.mjs +526) and one repository key
  // for a clone's origin with a workspace reference's ID first (workspace-context.mjs +641) [2026-11-16]. No new eager file.
  // 4,277,750 (measured 4,277,717): SPEC-SCF stages 3 and 4 on 4,273,495 (+4,222): the registered Git queries
  // (git-query.mjs +4,869), ancestry proof v2 readers (workflow-snapshots.mjs +580, schema-migrations.mjs +272,
  // test-command-amendment-contracts.mjs +231) and two flags (+51), less skp-amendment-audit.mjs (-1,781) [2026-11-16].
  // 4,287,800 (measured 4,287,778): the 11-17 landing, OSA v1.1 Stages 1-3 with SPEC-SCF stages 2-5 and the 11-16 small
  // fixes on one tree; the measured rises above together. No new eager file.
  // 4,280,250 (measured 4,280,210, +1,148): SPEC-OSA v1.1 Stage 4. The work command's two names (command-skills.mjs
  // WORK_COMMANDS, isWorkCommand), the command validator reading them (safe-command-guidance.mjs) and the card's yes
  // narrated (narration/messages.mjs). The map's renderer and the alias adapter stay out of this closure. No new eager file.
  // 4,288,950 (measured 4,288,926): OSA v1.1 Stage 4 (+1,148 alone) merged into the 11-17 landing above. No new eager file.
  // 4,288,050 (measured 4,288,014, -912): SPEC-OSA v1.1 Stage 5 lowers it to what it measures: the unused predicate
  // wrappers it deleted (code-delivery-policy.mjs opensCodeVersion, phase-generation.mjs consumedByPublishedGeneration).
  // 4,288,300 (measured 4,288,283, +269): the 11-17 landing's fixes. manual-authorship.mjs loads the artifact checks only
  // where an artifact is checked, which takes 20 modules out of the Copilot edit guard on every tool call (68 -> 56); this
  // projection reaches those checks another way, so it keeps them and gains only the loader. No new eager file.
  // 4,288,700 (measured 4,288,671; 4,288,241 before it): CVL gap report piece 1, the runner keeps a stopped run's process
  // group answer and tells a gate's run record the process it started (quality-command-runner.mjs +430) [TCE:REQ-034].
  // No new eager file.
  // 4,289,350 (measured 4,289,303 on 4,288,241, +1,062): the `testRuns: fresh` step setting [TCE:REQ-080, CVL-REQ-014]:
  // its one reader (code-delivery-policy.mjs +351) and its check at load (config.mjs +711). The fuller reuse key stays
  // out of this closure. No new eager file.
  // 4,289,800 (measured 4,289,786): CVL pieces 1 and 3 together (the runner keeps the process group's answer; the reuse key's
  // fields), each measured above on its own base. No new eager file.
  // 4,289,200 (measured 4,289,165, +494): the review of CVL piece 1, a held test run listed by anyone and set aside only
  // in a person's own terminal (person-step-catalog.mjs +268, command-registry.mjs +226). No new eager file.
  // 4,290,300 (measured 4,290,280): CVL pieces 1 and 3 with piece 1's review fixes, each measured above on its own base.
  // No new eager file.
  // 4,290,400 (measured 4,290,341, +61): the person-step catalog's confirming runs share one check. No new eager file.
  // 4,292,200 (measured 4,292,155, +1,814): CVL piece 4 (2026-11-18), the plan's Interface api column
  // (verification/contracts.mjs +1,092) and the gate's lazy API assertion check (delivery-evidence.mjs +722). No new eager file.
  // 4,292,400 (measured 4,292,397, +229): `decision screenshot`, where a person brings up the screen a visual sign-off is
  // about at SFlow's browser, is their own step (person-step-catalog.mjs +215, command-registry.mjs +14) [owner, 2026-11-18].
  // No new eager file.
  // 4,293,500 (measured 4,293,456, +1,061): a version opened to fix its review's findings about tests or evidence only carries
  // the published source (delivery-evidence.mjs, the gate's call into review-test-correction.mjs, loaded by its path)
  // [owner, 2026-11-18, Story new-ash-graph]. No new eager file.
  // 4,292,500 (measured 4,292,455, +58): a visual sign-off's screenshot routes to /sf-decide (model-free-commands.mjs),
  // and an amendment's refusal is in plain words (source-review-policy.mjs) [owner, 2026-11-18]. No new eager file.
  // 4,293,500 (measured 4,293,489, 2026-11-18): both rises above merged with the local-service fixes on one landing; they
  // overlap, so together they add +33 over the first. No new eager file.
  // 4,293,600 (measured 4,293,565, +109): a refused test run's projection keeps the Node it ran on (test-execution-diagnostics.mjs
  // ranOnNode) [owner, 2026-11-18, Story new-ash-graph]. No new eager file.
  // 4,293,750 (measured 4,293,712, +147): a version with nothing written yet says so on its refusal (delivery-evidence.mjs
  // nothingWritten), read by recovery as the version's checklist [owner, 2026-11-18, Story new-ash-graph]. No new eager file.
  // 4,293,950 (measured 4,293,908, +196): `singularity-flow update` registered, routed to /sf-about and refused in every
  // turn as the person's own step (command-registry.mjs, command-skills.mjs, person-step-catalog.mjs) [owner, 2026-11-19].
  // No new eager file.
  // 4,295,150 (measured 4,295,133, +1,388 over 4,293,745): the operating system's input idle time, read through the
  // registered process owner (platform-process.mjs osIdleMilliseconds), so Git work SFlow starts by itself waits for an idle
  // laptop [owner, 2026-11-19]. No new eager file.
  // 4,295,200 (measured 4,295,190 on landing-5, 2026-11-19): the update command, the idle reader and the secret-scanner rewording together.
  // 4,295,339 (measured 4,295,339, +149, 2026-11-19): `decisions learn` registered as a read (command-registry.mjs) [owner,
  // 2026-11-19, Q13]. No new eager file.
  // 4,297,750 (measured 4,297,704, +2,365, 2026-11-19): the Story's settled test support read by every path classifier
  // (plan-amendments.mjs, source-boundary.mjs, supporting-changes.mjs, specifications.mjs) and untracked files in the importer
  // search (git.mjs) [owner, 2026-11-19, C3]. No new eager file.
  // 4,297,800 (measured 4,297,767, +63, 2026-11-19): `--recommended` in the parser's boolean options (util.mjs) [C10]. No new eager file.
  // 4,298,300 (measured 4,298,284, +517, 2026-11-19): the two bound yeses in /sf-decide and the terminal-only reasons
  // (person-step-catalog.mjs, copilot-mutation-guard.mjs, copilot-answer-binding.mjs) [terminal-to-card]. No new eager file.
  // 4,301,700 (measured 4,301,652, +6,462 over 4,295,190, 2026-11-19, ceremony-approvals): configuration reads which steps a
  // person must approve (phase-roles.mjs +3,213, config.mjs +1,101) and the `approval.automatic` key (approval-authority.mjs
  // +1,875) [owner, 2026-11-19, approve twice]. No new eager file.
  // 4,302,300 (measured 4,302,238, +586, 2026-11-20, ceremony-approvals): the same policy hold and route review as above.
  // 4,295,434 (measured 4,295,434, +244 over 4,295,190, 2026-11-19 on ceremony-turns): `--review-findings` (util.mjs +19) and
  // intake clarification's words, required only at a Story's intake, with one assumptions question when nothing is open
  // (clarifications.mjs +296), less the outcome review's question (code-delivery-policy.mjs -71). No new eager file.
  // 4,295,220 (measured 4,295,215, +25): `guard card` and `guard setup` registered (command-registry.mjs) [owner, 2026-11-19].
  // No new eager file.
  // 4,305,601 (measured on landing-6, 2026-11-20): code-env and the four ceremony branches above together.
  // 4,305,774 (measured, +173, 2026-11-20): the full run's route fixes for an undo and an acknowledgement (agent-output.mjs, copilot-guidance.mjs).
  // 4,306,039 (measured 4,306,039, +438, 2026-11-20, finding-dispute): `review-source dispute`, a /sf-decide turn's bound yes:
  // its catalog row (person-step-catalog.mjs), its skill route (command-skills.mjs) and its route form (action-command-map.mjs)
  // [owner, 2026-11-20]. No new eager file.
  // 4,306,250 (measured 4,306,212 on landing-7, 2026-11-20): the finding dispute and the Node install route together.
  // 4,307,760 (measured 4,307,760, +1,510, 2026-11-20, limit audit track B): coded limits with their facts (clarifications.mjs,
  // analysis-limits.mjs), a person's one more rework round (repair-budget.mjs) and `--beyond-budget` (util.mjs). No new eager file.
  // 4,310,976 (measured on landing-11, 2026-11-20): the three hardening tracks and the optional-questions fix together
  // (filled values and path-slip corrections, coded limits, VS Code chat routes, optional rows). No new eager file.
  // 4,316,692 (measured, +5,716, 2026-11-20, intents-stage01): configuration's check of a newer SFlow's workflow.yml and of
  // `intent:` and `because:` on steps (config.mjs), with the intent and reason lists (phase-roles.mjs). No new eager file.
  // 4,322,851 (measured on landing-12, 2026-11-21): step intents stages 0-1 and the coverage fix together. No new eager file.
  // 4,322,916 (measured, +65, 2026-11-21, timeout-retry): a SUBPROCESS_TIMEOUT names its program and limit (util.mjs run).
  // No new eager file.
  // 4,328,362 (measured, +5,446, 2026-11-21, intents-stage2): step intents Stage 2's gate and configuration hooks (phase-roles.mjs,
  // config.mjs); the derivation loads only for a workflow.yml that opts in. No new eager file.
  // 4,323,516 (measured, +600, 2026-11-21, intents-runtime-review): the two commands registered, --again, the guard's refusal of an
  // agent's kind confirmation and "Try it" in the approval act. No new eager file.
  // 4,328,962 (measured on landing-14, 2026-11-21): Stage 2's hooks and the runtime check's registrations together.
  // 4,329,757 (measured, +795, 2026-11-21, intents-stage3): the six intent starter templates' digests (packaged-asset-history.mjs)
  // and the `workflow build intents` action (command-registry.mjs). No new eager file.
  // 4,333,581 (measured, +4,619, 2026-11-21, marketplace-agents): a Git repository marketplace checked where configuration
  // loads (marketplace.mjs), the ls-remote that pins it and executables in a read-only catalog (git.mjs), and `workflow
  // from-agent` registered (command-registry.mjs). Its reader and conversion load only when used. No new eager file.
  // 4,334,376 (measured on landing-15, 2026-11-21): step intents Stage 3 and the marketplace agent import together.
  // 4,328,971 (measured on landing-14): capability kind's --confirm read as a typeof check (+9).
  // 4,334,385 (measured on landing-15 with main ce94e5a79): the typeof check and the two option names added.
  // 4,334,585 (measured, +200, 2026-11-21, intents-stage5): `testEvidenceFrom: false` read as absent (config.mjs). No new eager file.
  // 4,335,893 (measured, +1,508, 2026-11-21, loose-ends): the Story value's skill choice in skill-library.mjs. No new eager file.
  // 4,338,331 (measured on the integration branch, 2026-11-21): Stages 4-6, D1 and the loose ends together.
  // 4,334,573 (measured, +188, 2026-11-21, approval-focus): the shorter implementation template's earlier digest stays known,
  // so an unmodified copy upgrades (packaged-asset-history.mjs). No new eager file.
  // 4,338,519 (measured on the integration branch with approval-focus, 2026-11-21): the two together.
  // 4,338,600 (measured, +269, 2026-11-21, intents-stage7): the convergence rule's words (config.mjs, phase-roles.mjs). No new eager file.
  // 4,338,788 (measured on the integration branch with Stage 7, 2026-11-21): approval-focus and Stage 7 together.
  // 4,339,518 (measured on the integration branch, 2026-11-21): the integration fixes in config.mjs and step-intent-settings.mjs. No new eager file.
  // 4,339,923 (measured, +405, 2026-11-22): a person's sign-off without a screenshot is read as met (witness-records.mjs). No new eager file.
  // 4,339,933 (measured, +10): --attest read as a flag (util.mjs BOOLEAN_OPTIONS).
  // 4,340,082 (measured, +149, 2026-11-22): `workflow fix` is /sf-fix-workflow's route too (command-skills.mjs). No new eager file.
  // 4,341,351 (measured, +1,269, 2026-11-23): the finding override as a person's step in the tables the guard reads
  // (person-step-catalog.mjs, copilot-answer-binding.mjs, command-registry.mjs). No new eager file.
  // 4,342,348 (+997, measured 2026-11-23): the skill catalog's words for a pinned procedure's file (skill-library.mjs).
  // 4,342,982 (+634, measured 2026-11-24): `lessons` in the tables the guard reads (command-registry.mjs, command-skills.mjs,
  // copilot-mutation-guard.mjs). No new eager file.
  // 4,342,998 (+16, 2026-11-24): `lessons rule` (command-registry.mjs). No new eager file.
  // 4,343,659 (+661, 2026-11-25): `work` and /sf-task in the tables the guard reads (command-registry.mjs, command-skills.mjs,
  // copilot-mutation-guard.mjs, phase-mutation-contract.mjs, util.mjs) [ITW M1]. No new eager file.
  // 4,343,915 (+256, 2026-11-25): --new (util.mjs) and /sf-task as `nextsteps`' route (safe-command-guidance.mjs) [ITW M2].
  // No new eager file.
  // 4,347,584 (+3,669, 2026-11-25): a task's added step read in the accepted snapshot chain (workflow-snapshots.mjs,
  // schema-migrations.mjs) and `work add` registered [ITW:REQ-009]; the rest loads only for a task change. No new eager file.
  // 4,346,418 (+2,503, 2026-11-25): a task's skills frozen into its snapshot (workflow-snapshots.mjs) and marketplaces
  // validated again unchanged (marketplace.mjs) [ITW:REQ-010]. No new eager file.
  // 4,350,087 (measured on the merge of both, 2026-11-25): the two rises above together.
  // 4,353,049 (measured on the merge of Ask SFlow R1-R5, 2026-11-25): `ask` registered and its record families. No new eager file.
  // 4,353,387 (+338, 2026-11-25): the migration folders named once, for the delivery receipt and a task that grows
  // (application-paths.mjs MIGRATION_PATH) [ITW:REQ-014]. No new eager file.
  // 4,353,193 (+144, 2026-11-25 on itw-market): MARKETPLACE_UNKNOWN names `marketplace list` as its way on (marketplace.mjs).
  // No new eager file.
  // 4,353,531 (measured on itw-all, 2026-11-25): the growth and marketplace rises above together. No new eager file.
  // 4,357,681 (+4,294, 2026-11-25 on itw-route): /sf-task as a task Story's route and its reviewed check
  // (safe-command-guidance.mjs) and a task's chat kept between its steps (context-policy.mjs) [ITW:REQ-008]. No new eager file.
  // 4,359,058 (+1,377, 2026-11-25 on itw-route): a closed task's last message as its next action and the context boundary's
  // one route its reset (safe-command-guidance.mjs, context-policy.mjs). No new eager file.
  // 4,359,202 (measured on itw-all with itw-route merged, 2026-11-25): the rises above together. No new eager file.
  // 4,353,587 (+56, measured on itw-store, 2026-11-25): `marketplace catalog` registered (command-registry.mjs). No new eager file.
  // 4,361,439 (+3,046 from 4,358,393 on its base eb20cd6a4, measured 2026-11-26 on itw-market2): an index listing past its
  // hour asks whether it changed (remote-fetch.mjs, marketplace.mjs), the new flags (util.mjs) and `skill restore` and
  // /sf-marketplace in the tables the guard reads (command-registry.mjs, command-skills.mjs). No new eager file.
  // 4,361,681 (measured on itw-all2 with itw-walks merged, 2026-11-26): the rises above together. No new eager file.
  // 4,362,811 (+1,130 from 4,361,681 on its base c3b777ab1, measured 2026-11-26 on itw-market2): the hardened reader's
  // origin-pinned redirects and coded size refusal (remote-fetch.mjs) and its way on (limit-remediation.mjs). No new eager file.
  // 4,365,562 (+3,881 over 4,361,681 at c3b777ab1, measured 2026-11-26 on itw-walks): the Story value a step's
  // clarification asks (phase-roles.mjs, workflow-decisions.mjs) and `work behaviour` as a step the decisions card records
  // (model-free-commands.mjs, person-step-catalog.mjs) [ITW:REQ-011, REQ-015]. No new eager file.
  // 4,366,692 (measured on itw-all2 with itw-walks and itw-market2 merged, 2026-11-26). No new eager file.
  // 4,367,059 (+367 over 4,366,692 at 42731f7ca, measured 2026-11-26 on itw-walks): a refactor's behaviour choice as a
  // family SF Guard signs and counts (person-step-catalog.mjs) [ITW:REQ-015]. No new eager file.
  // 4,367,275 (+216, measured 2026-11-26 on itw-all2 merged with main 867d6da4a): main's Ask SFlow Story conversation and
  // local help commits, small edits across modules it already loaded. No new eager file.
  // 4,367,375 (+100, measured 2026-11-26 on fpl-m1): `needs-you` registered with /sf-inbox as its skill (command-registry.mjs,
  // command-skills.mjs) [FPL:REQ-038]. No new eager file.
  // 4,367,810 (+535 over 4,367,275 at 480c2f936, measured 2026-11-26 on omk-m1): an index's channels, owners and
  // lifecycles, read through a reader fetchMarketplaceIndex loads only when it fetches (marketplace.mjs) [OMK:REQ-005].
  // No new eager file.
  // 4,367,910 (measured on m1-int with fpl-m1 and omk-m1 merged, 2026-11-26): the two branches' rises together. No new eager file.
  // 4,376,031 (+8,756 over 4,367,275 at 480c2f936, measured 2026-11-26 on ssb-m1): the Story path resolver
  // [SSB:REQ-009] (story-paths.mjs, already in this closure) and the first helpers moved to it (SSB M1 B0, B1). No new
  // eager file.
  // 4,376,090 (+59, measured 2026-11-26 on ssb-m1): the kernel modules it loads join through the resolver (SSB M1 B2).
  // No new eager file.
  // 4,376,565 (+475, measured 2026-11-26 on ssb-m1): the step and prompt modules it loads join through the resolver
  // (SSB M1 B3). No new eager file.
  // 4,375,656 (measured at the end of SSB M1, 2026-11-26 on ssb-m1): +8,381 over 4,367,275 at 480c2f936 for all of
  // M1, most of it story-paths.mjs, the Story path resolver [SSB:REQ-009]. No new eager file.
  // 4,376,291 (measured on m1-int with fpl-m1, omk-m1 and ssb-m1 merged, 2026-11-26): the three branches' rises together.
  // No new eager file.
  // 4,368,239 (+329 over 4,367,910 at 8a386d941, measured 2026-11-26 on itw-local): a task's skill of the repository's own is
  // frozen into its snapshot from where the plan read it (workflow-snapshots.mjs) [ITW:REQ-020]. No new eager file.
  // 4,376,620 (measured on main 30484105e with itw-local merged, 2026-11-26): the +329 above on top of the three bets'
  // M1. No new eager file.
  // 4,377,492 (+1,201, measured 2026-11-26 on wm-clean): packaged-asset-history.mjs keeps the earlier digests of the
  // templates that stopped naming the removed World Model. No new eager file.
  // 4,377,821 (measured on main 53e996c00 with wm-clean merged, 2026-11-26): the +1,201 above on top of itw-local. No new
  // eager file.
  // 4,377,025 (+734, measured 2026-11-26 on wmr-m1m2): `wm knowledge slice` is refused by name as retired, pointing to `wm brief --phase` (removed-features.mjs,
  // command-registry.mjs) [WMR:REQ-027]. No new eager file.
  // 4,377,382 (+357, measured 2026-11-26 on wmr-m1m2 over d8c802e71): worldModel.knowledge.prompt may name steps, and a work type's
  // intelligence.worldModel may be `on` (config.mjs, intelligence-policy.mjs) [WMR:REQ-011]. No new eager file.
  // 4,378,912 (measured on main 4c8b464a6 with wmr-m1m2 merged, 2026-11-26): the +1,091 above on top of wm-clean. No new
  // eager file.
  // 4,379,377 (+465, measured 2026-11-26 on wm-dead over 0aaac1bb4): doctor names an agent file that still carries the
  // retired sflow-world-model-views header (removed-features.mjs, +516); the parser and Story snapshot stop carrying it
  // (agent-document-parser.mjs, config.mjs) [WMR:REQ-005]. No new eager file.
  // 4,388,333 (+8,956, measured 2026-11-26 on ssb-m2 over 2809f6edc): the state-ref layout the resolver remembers and
  // its records root (story-paths.mjs), the pinned-copy read root (configuration-read-scope.mjs), the setting
  // (work-item-location.mjs, config.mjs) and the state checkout the Story index finds [SSB M2]. No new eager file.
  // 4,389,338 (+1,005, measured 2026-11-27 on ssb-m2): the held-back state-ref layout (work-item-location.mjs,
  // config.mjs) [SSB M2]. No new eager file.
  // 4,391,469 (+2,131, measured 2026-11-27 on fix-suite-1127 over d99e2d11d): the source inspection facade's checkout
  // reads, which the state checkout now uses instead of starting Git itself (source-inspection.mjs) [SDA-AC-001]. No
  // new eager file.
  // 4,391,547 (+78, measured 2026-11-27 on fpl-m3 over 70131c215): `rules` registered as a read with /sf-explain as its skill
  // (command-registry.mjs, command-skills.mjs) [FPL:REQ-019, REQ-038]. No new eager file.
  // 4,393,163 (+1,616 over 4,391,547, measured 2026-11-27 on the merge of fix-source-loop with main f6353df44): the
  // editor-configuration rule and the set-aside route of a document step's refusal (application-paths.mjs +588,
  // candidate-scope.mjs +203, cross-phase-change.mjs +760) [office loop]. No new eager file.
  assert.ok(current.bytes <= 4_393_163, `session current loads ${current.bytes} source bytes`);
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
