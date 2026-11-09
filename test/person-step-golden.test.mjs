/**
 * Golden: which turns may run each person's step, and how each refuses it, as it is today [study 6.6, S6].
 *
 * Before any table of person steps moves (PERSON_DECISIONS, OWN_TERMINAL_STEPS, PERSON_STEP_FAMILIES,
 * the review effects), this pins every command form against every skill's turn, a plain prompt, a
 * paused Copilot and no turn at all: allowed, or refused with exactly these words and this route. So
 * moving a table cannot quietly widen or change a refusal: this file must pass unchanged, before and after.
 *
 * test/fixtures/person-step-golden.json is the record. It changes only when someone means to change
 * who may run a person's step; SINGULARITY_FLOW_GOLDEN_WRITE=1 writes it, and the diff is the decision.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { slowLane } from './helpers/slow-lane.mjs';
import { recordableInApproval } from '../src/approval-decisions.mjs';
import { commandLineWithoutSkill, DECISION_LIST_CHAT_OPTIONS, OWN_TERMINAL_STEPS, ownTerminalStep, skillForCommandLine } from '../src/command-skills.mjs';
import { captureMutationTurn, mutationPostToolGuard } from '../src/copilot-mutation-guard.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { ISSUE_ONLY_OPTIONS } from '../src/decision-list.mjs';
import { PERSON_STEP_FAMILIES } from '../src/presence/person-steps.mjs';
import { REVIEW_EFFECTS } from '../src/state.mjs';

const GOLDEN = new URL('./fixtures/person-step-golden.json', import.meta.url);
const digest = `sha256:${'c'.repeat(64)}`;

/** Every form of every person's step, by the id the guard knows it by; `preview` forms stay open. */
const COMMANDS = Object.freeze({
  // Approving and returning: their own turns, a receipt, and a person's own confirmation flags.
  approve: ['singularity-flow approve custom-step --work-id PMC-1 --yes', 'singularity-flow approve custom-step --work-id PMC-1 --selection-receipt tok-1 --json',
    'singularity-flow approve custom-step --work-id PMC-1 --selection-receipt tok-1 --for-agent --json', 'sflow approve custom-step'],
  reject: ['singularity-flow reject custom-step --work-id PMC-1 --reason "Wrong."', 'singularity-flow reject custom-step --work-id PMC-1 --selection-receipt tok-1 --reason "Wrong." --json'],
  // PERSON_DECISIONS.
  'story-decision': ['singularity-flow decision scope PMC-1 --item SRI-0123456789ab --as excluded --reason "Out of scope."',
    'singularity-flow decision applicability PMC-1 --clause PMC-1:REQ-001 --as not-applicable --reason "No UI."',
    'singularity-flow decision completeness PMC-1 --reason "Complete."', 'singularity-flow decision choose PMC-1 --choice O1 --reason "Simpler."',
    'singularity-flow decision plan PMC-1 --add-location PMC-1:AC-001=src/a.mjs --reason "Also here."',
    'singularity-flow decision plan PMC-1 --add-supporting src/b.mjs=test-support --supporting-reason "A helper." --reason "Accounted for here."',
    // A person's decision on a code step's departure [CQF:REQ-024]: a /sf-decide turn's, held to their answer.
    'singularity-flow decision departure PMC-1 --fetch --departure DEP-001 --as accepted --reason "The page ships with this code."',
    'singularity-flow decision departure PMC-1 --fetch --departure DEP-002 --as rejected --reason "Not part of this Story."'],
  'story-reopen': ['singularity-flow reopen PMC-1 --to custom-step --reason "Found a defect."'],
  'convergence-adjudication': ['singularity-flow story adjudicate PMC-1 --finding F-1 --as dismissed --reason "Not a defect."'],
  'source-review-decision': ['singularity-flow review-source decide custom-step --finding F-1 --reason "Accepted."'],
  'constitution-exception': ['singularity-flow constitution except ART-1 --work-id PMC-1 --reason "Waived for the spike."'],
  'repair-authorization': [`singularity-flow repair authorize RPR-001 --confirm ${digest} --open --json`],
  'telemetry-consent': ['singularity-flow telemetry enable --confirm "ENABLE LOCAL USAGE" --json'],
  'epic-approval': ['singularity-flow initiative approve phase --confirm define:phase --acknowledge-self-approval', 'singularity-flow epic approve phase --confirm define:phase'],
  'epic-story-decision': [`singularity-flow epic review approve S-1 --epic E-1 --packet ${'b'.repeat(64)}`, `singularity-flow initiative review reject S-1 --epic E-1 --packet ${'b'.repeat(64)} --reason "Wrong scope."`],
  'epic-completion': ['singularity-flow epic complete E-1 --confirm E-1'],
  'goal-plan-approval': ['singularity-flow goal plan approve GEX-1 --confirm GEX-1'],
  'sgos-ratification': ['singularity-flow intent ratify INT-1 --confirm INT-1', 'singularity-flow intent confirm INT-1', 'singularity-flow program approve PRG-1 --confirm PRG-1'],
  'capability-break-glass': ['singularity-flow capabilities lease grant CAP-1 --confirm CAP-1 --reason "Incident."'],
  'host-policy-assertion': ['singularity-flow ledger deployment-check --confirm-protected --authority leads'],
  'agent-trust': ['singularity-flow agents lock local-agent'],
  // OWN_TERMINAL_STEPS.
  witness: ['singularity-flow decision witness PMC-1 --criterion PMC-1:AC-001 --slot screen --file evidence/screen.png --confirm states-the-outcome --reason "Looked at the screen."'],
  risk: ['singularity-flow decision risk PMC-1 --obligation OBL-001 --category evidence --expires 2099-01-01 --reason "Accepted until the device lab returns."'],
  'witness-exception-renewal': [`singularity-flow decision witness-exception PMC-1 --phase custom-step --mapping sha256:${'a'.repeat(64)} --expires 2099-01-01 --reason "The device lab is still down."`],
  'test-run-risk': ['singularity-flow decision test-risk PMC-1 --phase custom-step --cause "No browser here." --expires 2099-01-01 --reason "Decided by the approver."',
    'singularity-flow decision test-narrowing PMC-1 --phase custom-step --reason "Decided by the approver."',
    'singularity-flow decision evidence-reuse PMC-1 --phase custom-step --from-attempt TA-001 --reason "Decided by the approver."',
    'singularity-flow decision visual-profile PMC-1 --phase custom-step --profile tablet --not-applicable --reason "Decided by the approver."',
    'singularity-flow decision finding-risk PMC-1 --phase custom-step --finding F-0123456789abcdef --expires 2099-01-01 --reason "The nested branches mirror the table."'],
  'test-command-decision': ['singularity-flow decision test-command PMC-1 --accept TCD-001', 'singularity-flow decision test-command PMC-1 --revoke TCD-001 --reason "The repository configures this runner now."'],
  'decision-list-record': ['singularity-flow decisions record PMC-1 --answers /tmp/card-answers.json --json', `singularity-flow decisions record PMC-1 --choose d1=accept-test-command --confirm ${digest}`,
    `singularity-flow decisions record PMC-1 --choose d1=dismiss --choose d2=accept-test-command --confirm ${digest}`, 'singularity-flow decisions record PMC-1'],
  'decision-list-record-chat': [`singularity-flow decisions record PMC-1 --choose d1=dismiss --choose d2=return --confirm ${digest}`, `singularity-flow decisions record PMC-1 --choose d1=accept-risk --expires d1=2099-01-01 --confirm ${digest}`],
  'set-aside': [`singularity-flow recover PMC-1 --phase custom-step --set-aside --confirm ${digest} --json`],
  'publication-set-aside': [`singularity-flow sync PMC-1 --set-aside --confirm ${'a'.repeat(40)}`, `singularity-flow initiative sync INIT-1 --set-aside --confirm ${'a'.repeat(40)}`],
  'workflow-delete': [`singularity-flow workflow delete team-flow --confirm ${digest}`],
  'target-origin-pin': [`singularity-flow story target-origin PMC-1 --url https://staging.example.test --reason "Approved staging target." --confirm ${digest}`],
  'intent-amendment-decision': ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001'],
  'knowledge-confirmation': ['singularity-flow wm rules confirm R-0123456789ab --json', 'singularity-flow wm knowledge reject K-rule-0123456789abcdef --note "Not a rule."'],
  'spec-drift-decision': ['singularity-flow spec drift decide PMC-1:REQ-001 --accept --reason "The code is right."'],
  'spec-library-decision': ['singularity-flow spec author decide SPEC-CHK-004 GAP-001 --option O1 --reason "Strictly above."', 'singularity-flow spec author settle SPEC-CHK-004 --all-articles satisfied',
    'singularity-flow spec author publish SPEC-CHK-004 --reviewed', 'singularity-flow spec author discard SPEC-CHK-004'],
  'spec-slice-change': ['singularity-flow spec attach PMC-1 --drop SPEC-CHK-004:REQ-001 --reason "Delivered by another Story."'],
  'spec-split-publication': ['singularity-flow spec split SPEC-CHK-004@1 --publish'],
  'upstream-issue-decision': ['singularity-flow upstream-issue decide UPI-001 --work-id PMC-1 --outcome dismiss --reason "Already handled."'],
  'upstream-amendment-decision': ['singularity-flow upstream-issue decide-amendment FAM-001 --decision approve --reason "The amendment is right." --confirm FAM-001',
    'singularity-flow upstream-issue revalidate custom-step --amendment FAM-001 --outcome unchanged --reason "Still holds."'],
  'environment-binding': ['singularity-flow env bind staging --stdin', 'singularity-flow env unbind staging --json'],
  'apm-install': ['singularity-flow apm install acme/review-pack', 'singularity-flow apm install --dev ../local-pack --json', 'singularity-flow apm update', 'singularity-flow apm update reviewer@acme-catalog --json'],
  'apm-organisation': ['singularity-flow apm publish reviewer --marketplace ../acme-catalog', 'singularity-flow apm marketplace init --name acme-catalog --owner "Platform Team" --json', 'singularity-flow apm policy init --marketplace acme/acme-catalog'],
  'lock-release': ['singularity-flow lock release publication PMC-1 --confirm 0123456789abcdef', 'singularity-flow lock release-file /tmp/workspaces.json.lock --confirm 0123456789abcdef --json'],
  'configuration-approve': ['singularity-flow configuration approve sflow/config-change/workflow/studio-x --yes', 'singularity-flow configuration approve --json'],
  'workflow-activate': ['singularity-flow workflow activate sflow/config-change/workflow/studio-x --confirm 0123456789abcdef0123456789abcdef01234567 --acknowledge-unprotected --json'],
  'approval-evidence-confirmation': ['singularity-flow approve custom-step --work-id PMC-1 --confirm-evidence'],
  'adjudication-answers': ['singularity-flow story adjudicate --answers /tmp/a.json --expect sha256:abc --work-id PMC-1'],
  'adjudication-table': ['singularity-flow story adjudicate --work-id PMC-1', 'singularity-flow story adjudicate'],
  'clarification-answer': ['singularity-flow clarification answer custom-step --question "Is 2 right?" --answer "Yes."'],
  'plan-correction': ['singularity-flow decision plan PMC-1 --set-fulfillment PMC-1:REQ-001=test-only --reason "The tests are the whole delivery."',
    'singularity-flow decision plan PMC-1 --replace-location PMC-1:AC-001=src/a.mjs:src/b.mjs --reason "The plan named the wrong module."'],
  'live-terminal-review': [`singularity-flow appeal decide APL-001 --work-id PMC-1 --decision account-scope --reason "Reviewed the exact diff." --confirm ${digest}`,
    `singularity-flow appeal risk-accept --work-id PMC-1 --phase custom-step --reason "Accepted until the lab returns." --expires 2099-01-01 --confirm ${digest}`,
    `singularity-flow appeal risk-revoke PQR-001 --work-id PMC-1 --reason "The lab is back." --confirm ${digest}`, `singularity-flow appeal evidence-accept --work-id PMC-1 --phase custom-step --confirm ${digest}`,
    `singularity-flow story test-policy accept-risk PMC-1 --phase custom-step --apply --confirm ${digest}`, `singularity-flow story test-policy amend PMC-1 --phase custom-step --reason "The runner moved." --apply --confirm ${digest}`,
    `singularity-flow story test-policy baseline-admission PMC-1 --phase custom-step --apply --confirm ${digest}`, `singularity-flow story test-policy confirm PMC-1 --phase custom-step --confirm ${digest}`,
    `singularity-flow story approvers refresh PMC-1 --reason "The reviewer joined the group." --confirm ${digest}`],
  'sf-guard-person-step': ['singularity-flow guard register', 'singularity-flow guard rotate --key SHA256:abc', 'singularity-flow guard recover --key SHA256:abc',
    'singularity-flow guard revoke approver-0123456789ab --reason "Left the team."', 'singularity-flow guard enable --remote-check sf-guard-verify', 'singularity-flow guard disable --reason "Moving to another signer."',
    'singularity-flow guard exception add approver-0123456789ab', 'singularity-flow guard exception revoke EXC-001 --reason "Now on a Mac."'],
  // New since this record was first taken: a person's choice on the list, a plan amendment over several paths, and the Node pin.
  'decision-list-record-new': [`singularity-flow decisions record PMC-1 --choose d1=pin-node --confirm ${digest}`, `singularity-flow decisions record PMC-1 --choose d1=include --reason d1=Why --confirm ${digest}`],
  'plan-amendment-batch': ['singularity-flow decision plan PMC-1 --add-location PMC-1:AC-001=src/a.mjs --add-location PMC-1:AC-001=src/b.mjs --add-supporting test/h.mjs=test-support --supporting-reason "A helper." --reason "One reason for them all."'],
  'tests-node': ['singularity-flow tests node --work-id PMC-1 --node 22', 'singularity-flow tests node --work-id PMC-1 --node 22 --phase custom-step --json'],
  // The model records a departure without asking [CQF:REQ-021]: not a person's step, so it is open to the turns that edit.
  'departure-record': ['singularity-flow departure record --kind path --path src/a.mjs --clause PMC-1:AC-001 --reason "The change needed this file too."',
    'singularity-flow departure record --kind wording --target custom-step --file drafts/custom-step.md --reason "The wording no longer matches the code." --json',
    // And accounts for each instruction the person typed [SCS:REQ-042]: the model's statement, never a person's decision.
    'singularity-flow departure account --instruction 1 --clauses PMC-1:AC-001 --json', 'singularity-flow departure account --instruction 2 --departure DEP-001'],
  // Who a record is credited to.
  'authorship-claim': ['singularity-flow phase publish custom-step --authored human --channel manual-in-place --json', 'singularity-flow phase publish custom-step --json', 'singularity-flow phase publish custom-step --authored external-tool'],
  'agent-publication': ['singularity-flow phase publish custom-step --authored governed-agent --json'],
  'record-authorship': ['singularity-flow upstream-issue raise --work-id PMC-1 --phase custom-step --about REQ-001 --problem "Wrong." --authored human',
    'singularity-flow story intent-amendment propose --work-id PMC-1 --authored human --candidate /tmp/spec.md'],
  // Previews and reads: open everywhere they are open today, and they must stay so.
  preview: ['singularity-flow decision plan PMC-1 --add-location PMC-1:AC-001=src/a.mjs --dry-run', 'singularity-flow epic complete E-1 --dry-run --json', 'singularity-flow program approve PRG-1', 'singularity-flow decision show PMC-1',
    'singularity-flow decisions PMC-1 --json', 'singularity-flow appeal risk-prepare --work-id PMC-1 --phase custom-step --reason "Preview the risk."', `singularity-flow appeal evidence-accept --work-id PMC-1 --phase custom-step --review-ui --confirm ${digest}`,
    'singularity-flow story test-policy accept-risk PMC-1 --phase custom-step', 'singularity-flow apm install acme/review-pack --dry-run', 'singularity-flow choices begin approve PMC-1 --json',
    'singularity-flow departure list --json', 'singularity-flow departure show DEP-001 --json']
});

const SPECIAL_TURNS = Object.freeze(['(plain prompt)', '(paused)', '(no turn)']);

async function fixture(t, status) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-golden-')));
  const root = path.join(directory, 'repository');
  await mkdir(root);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'Golden Tester']); git(['config', 'user.email', 'golden@example.test']);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  const phase = { id: 'custom-step', status, generation: status === 'in_progress' ? 0 : 1, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const file = path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(workflow));
  git(['add', 'src', 'singularity']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const enter = async (prompt, sessionId) => {
    const payload = { cwd: root, sessionId, prompt };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  return { root, enter };
}

/** A decision as one comparable line: allowed, or the exact refusal and its first route, without this machine's paths. */
function outcome(decision, root) {
  if (decision.permissionDecision !== 'deny') return decision.permissionDecision ?? 'allowed';
  const text = String(decision.permissionDecisionReason ?? '').replaceAll(root, '<ROOT>');
  const route = decision.next?.[0];
  return `deny ${text.split(/[.:]/u)[0].slice(0, 80)} [${createHash('sha256').update(text).digest('hex').slice(0, 16)}] route ${route?.copilotCommand ?? '-'} | ${String(route?.command ?? '-').replaceAll(root, '<ROOT>').slice(0, 60)}`;
}

async function turnMatrix(t, status, turns) {
  const { root, enter } = await fixture(t, status);
  const rows = Object.entries(COMMANDS).flatMap(([id, commands]) => commands.map((command) => ({ id, command, outcomes: new Map() })));
  for (const turn of turns) {
    const payload = SPECIAL_TURNS.includes(turn) ? await (async () => {
      if (turn === '(no turn)') return { cwd: root, sessionId: 'golden-never-entered', prompt: undefined };
      return enter(turn === '(plain prompt)' ? 'Thanks. Now take care of the rest.' : 'Please go on.', `golden-${turn}`);
    })() : await enter(turn, `golden-${turn}`);
    if (turn === '(paused)') await setCopilotPaused(true);
    try {
      for (const row of rows) {
        const decision = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: row.command, cwd: root } });
        row.outcomes.set(turn, outcome(decision, root));
      }
    } finally { if (turn === '(paused)') await setCopilotPaused(false); }
  }
  // One line per command: what most turns do, and each turn that differs, so a changed turn shows as itself.
  return rows.map(({ id, command, outcomes }) => {
    const counted = new Map();
    for (const value of outcomes.values()) counted.set(value, (counted.get(value) ?? 0) + 1);
    const usual = [...counted].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))[0][0];
    const other = {};
    for (const [turn, value] of [...outcomes].sort(([left], [right]) => left.localeCompare(right))) if (value !== usual) (other[value] ??= []).push(turn);
    return { id, command, usual, ...(Object.keys(other).length ? { other } : {}) };
  });
}

/**
 * The steps a chat decision must carry the person's answer for ("A chat decision must carry what the
 * person answered"): with nobody's answer the matrix above shows them refused, and once the person
 * has answered, here, their own turn runs them. So that rule only tightened who may run them.
 */
async function answeredTurns(t, status) {
  const { root, enter } = await fixture(t, status);
  const rows = [];
  const turnOf = { 'story-decision': '/sf-decide PMC-1', 'convergence-adjudication': '/sf-converge', 'upstream-issue-decision': '/sf-decide PMC-1', 'decision-list-record-chat': '/sf-decide PMC-1' };
  for (const [id, turn] of Object.entries(turnOf)) {
    for (const command of COMMANDS[id]) {
      const words = [...command.matchAll(/--(?:supporting-)?reason "([^"]+)"/gu)].map((match) => match[1]).join(' ') || 'yes, record it';
      const payload = await enter(turn, `answered-${rows.length}`);
      await mutationPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs: { question: 'Why?' }, toolResult: { textResultForLlm: `User responded: ${words}` } });
      rows.push({ id, command, turn, outcome: outcome(await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: root } }), root) });
    }
  }
  return rows;
}

/** The tables themselves, and what each answers for a command: routes, signing and review effects. */
function tablesToday() {
  const allCommands = Object.values(COMMANDS).flat();
  const effectKinds = ['upstream-issue', 'upstream-issue-decision', 'evidence-reuse', 'visual-profile', 'test-run-risk', 'test-narrowing', 'test-command', 'plan-amendment', 'obligation-risk', 'finding-risk'];
  return {
    ownTerminalSteps: OWN_TERMINAL_STEPS.map((step) => step.id),
    routes: Object.fromEntries(allCommands.map((command) => [command, { own: ownTerminalStep(command), skill: skillForCommandLine(command), withoutSkill: commandLineWithoutSkill(command) }])),
    signedFamilies: PERSON_STEP_FAMILIES.map(({ id, list, action, label, isPerson }) => ({ id, list, action, label,
      isPerson: [{}, { accepts: 'x' }, { revokes: 'x' }, { by: 'person' }, { by: 'rule' }].map((entry) => isPerson(entry)) })),
    reviewEffects: REVIEW_EFFECTS,
    chatOptions: [...DECISION_LIST_CHAT_OPTIONS], issueOnlyOptions: [...ISSUE_ONLY_OPTIONS],
    inApproval: effectKinds.flatMap((kind) => ['upstream-issue', 'accept-risk', 'other'].map((id) => [kind, id, recordableInApproval({ id, effects: [{ kind }], needs: {} })]))
  };
}

/** The record as a reviewer reads it: one line per command, and each list of turns named once, since most repeat. */
function packed(found) {
  const groups = new Map();
  const named = (turns) => {
    const key = JSON.stringify(turns);
    if (!groups.has(key)) groups.set(key, `T${groups.size + 1}`);
    return groups.get(key);
  };
  const rows = (list) => list.map(({ other, ...row }) => ({ ...row, ...(other ? { other: Object.fromEntries(Object.entries(other).map(([value, turns]) => [value, named(turns)])) } : {}) }));
  const [inProgress, awaitingApproval] = [rows(found.inProgress), rows(found.awaitingApproval)];
  const lines = (list) => `[\n${list.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n]`;
  return `{\n"turns": ${JSON.stringify(found.turns)},\n"turnGroups": ${JSON.stringify(Object.fromEntries([...groups].map(([key, name]) => [name, JSON.parse(key)])), null, 0)},\n`
    + `"inProgress": ${lines(inProgress)},\n"awaitingApproval": ${lines(awaitingApproval)},\n"answered": ${lines(found.answered)},\n"tables": ${JSON.stringify(found.tables, null, 1)}\n}\n`;
}

function unpacked({ turnGroups, ...record }) {
  const rows = (list) => list.map(({ other, ...row }) => ({ ...row, ...(other ? { other: Object.fromEntries(Object.entries(other).map(([value, name]) => [value, turnGroups[name]])) } : {}) }));
  return { ...record, inProgress: rows(record.inProgress), awaitingApproval: rows(record.awaitingApproval) };
}

// The turns that differ most, for the default lane: a full run takes about a minute.
const QUICK_TURNS = Object.freeze(['/sf-phase', '/sf-recover', '/sf-next', '/sf-decide PMC-1', '/sf-approve', '/sf-reject', '/sf-spec-author', '/sf-converge', '/sf-fix', '/sf-help', ...SPECIAL_TURNS]);

test('the tables, and every person\'s step against the turns that differ most, have not moved', async (t) => {
  const golden = unpacked(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  assert.deepEqual(tablesToday(), golden.tables, 'a table of person steps changed');
  assert.ok(QUICK_TURNS.every((turn) => golden.turns.includes(turn)), 'a quick turn is no longer a turn');
  for (const [field, status] of [['inProgress', 'in_progress'], ['awaitingApproval', 'awaiting_approval']]) {
    const before = new Map(golden[field].map((row) => [row.command, row]));
    const moved = [];
    for (const row of await turnMatrix(t, status, QUICK_TURNS)) {
      const was = before.get(row.command);
      const outcomeIn = (entry, turn) => Object.entries(entry.other ?? {}).find(([, turns]) => turns.includes(turn))?.[0] ?? entry.usual;
      for (const turn of QUICK_TURNS) if (!was || outcomeIn(row, turn) !== outcomeIn(was, turn)) moved.push(`${turn}: ${row.command}: now ${outcomeIn(row, turn)}, was ${was ? outcomeIn(was, turn) : 'not recorded'}`);
    }
    assert.deepEqual(moved, [], `${field}: a person's step changed who may run it or how it refuses`);
  }
});

test('every person\'s step, against every turn: who may run it and how it refuses have not moved', slowLane({ timeout: 900_000 }), async (t) => {
  const { skills } = YAML.parse(readFileSync(new URL('../plugin/skills/registry.yml', import.meta.url), 'utf8'));
  const names = (Array.isArray(skills) ? skills : Object.keys(skills)).map((entry) => (typeof entry === 'string' ? entry : entry.id ?? entry.name)).map((name) => String(name).replace(/^sflow-/u, 'sf-'));
  const turns = [...new Set(names.map((name) => `/${name}`)), '/sf-decide PMC-1', ...SPECIAL_TURNS].sort();
  assert.ok(turns.length > 50, String(turns.length));
  const found = { turns, inProgress: await turnMatrix(t, 'in_progress', turns), awaitingApproval: await turnMatrix(t, 'awaiting_approval', turns),
    answered: await answeredTurns(t, 'awaiting_approval'), tables: tablesToday() };
  // A new own-terminal step is held to this too: name its command above.
  assert.deepEqual(OWN_TERMINAL_STEPS.map((step) => step.id).filter((id) => !Object.hasOwn(COMMANDS, id)), []);
  if (process.env.SINGULARITY_FLOW_GOLDEN_WRITE === '1') writeFileSync(GOLDEN, packed(found));
  const golden = unpacked(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  assert.deepEqual(found.turns, golden.turns, 'the turns themselves changed: a new skill needs its line');
  for (const [field, list] of [['inProgress', found.inProgress], ['awaitingApproval', found.awaitingApproval]]) {
    const before = new Map(golden[field].map((row) => [row.command, row]));
    const moved = list.filter((row) => JSON.stringify(row) !== JSON.stringify(before.get(row.command)));
    assert.deepEqual(moved.map((row) => ({ now: row, was: before.get(row.command) })), [], `${field}: a person's step changed who may run it or how it refuses`);
    assert.deepEqual(golden[field].map((row) => row.command).filter((command) => !list.some((row) => row.command === command)), [], `${field}: a command form was dropped`);
  }
  assert.deepEqual(found.answered, golden.answered, 'what a person\'s answer lets their own turn run changed');
  assert.deepEqual(found.tables, golden.tables, 'a table of person steps changed');
});
