/**
 * /sf-amend [owner, 2026-11-14]: the dedicated Copilot route for changing a Story's requirements after its scope
 * is approved. It runs /sf-reject's intent-amendment route and nothing else: its turn reads, drafts in the one
 * issued file and proposes the bound Story's amendment. Deciding and acknowledging stay a person's, on the
 * decisions card (/sf-decide <WORK-ID>) or in their own terminal, on both Copilot hosts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { commandLineWithoutSkill, skillForCommandLine, skillsForCommand } from '../src/command-skills.mjs';
import { canonicalCommand, resolveOperation } from '../src/command-registry.mjs';
import { copilotAction, copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { argvAllowed, captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { intentAmendmentDraftPath, phaseStagingPaths } from '../src/phase-staging-paths.mjs';
import { safeCommandGuidance, validateSflowExecutionCommand } from '../src/safe-command-guidance.mjs';
import { parseArgs } from '../src/util.mjs';

const ROOT = new URL('..', import.meta.url);
const WORK = 'AMD-1';
const skillText = (name) => readFileSync(new URL(`plugin/skills/${name}/SKILL.md`, ROOT), 'utf8');

/** An approved scope step and a code step after it, its generation open: a Story that may propose an amendment. */
function story() {
  return {
    workItem: { id: WORK, branch: WORK }, status: 'in_progress', currentPhase: 'build', phaseOrder: ['intake', 'build'],
    phases: {
      intake: { id: 'intake', label: 'Intake', status: 'approved', generation: 1, writeScope: 'artifact-only',
        requiredArtifact: { path: 'artifacts/intake/requirements.md', kind: 'requirements' }, generationPolicy: { task: 'document', requirement: 'required' } },
      build: { id: 'build', label: 'Build', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
        generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } }
    },
    resolution: { obligationGraph: { nodes: [{ id: 'intake', responsibilities: ['scope'] }, { id: 'build', responsibilities: ['implement'] }] } },
    history: [], intentAmendments: []
  };
}

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-amend-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q', '-b', WORK); git('config', 'user.name', 'Amend Tester'); git('config', 'user.email', 'amend@example.test');
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  const definition = { workItemRoot: 'singularity/work-items' };
  const workflow = story();
  const item = path.join(root, definition.workItemRoot, WORK);
  await mkdir(path.join(item, 'artifacts', 'intake'), { recursive: true });
  await writeFile(path.join(item, 'artifacts', 'intake', 'requirements.md'), `# Requirements\n\n- The value is 1. [${WORK}:REQ-001]\n`);
  await writeFile(path.join(item, 'workflow.json'), JSON.stringify(workflow));
  git('add', '-A'); git('commit', '-qm', 'fixture');
  const accepted = { definition, workflow };
  const capture = (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root, load: async () => accepted });
  return { root, workflow, draft: intentAmendmentDraftPath(gitDir(root), workflow), capture };
}

// What each host hands the hooks: Copilot CLI a `/sf-…` prompt and `toolName`/`toolArgs`; VS Code's own chat
// its expanded `<skill-context>` prompt and `tool_name`/`tool_input` (run_in_terminal, replace_string_in_file).
const HOSTS = Object.freeze({
  'Copilot CLI': {
    enter: async (f, session, skill = '/sf-amend', words = `${WORK} The value must be 2.`) => {
      const payload = { cwd: f.root, sessionId: session, prompt: `${skill} ${words}` };
      await recordRepositoryBoundaryTurn(payload, { captureMutation: f.capture });
      return payload;
    },
    run: (payload, command, cwd) => repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd } }),
    edit: (payload, file) => repositoryToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: file } })
  },
  'VS Code': {
    enter: async (f, session, skill = '/sf-amend', words = `${WORK} The value must be 2.`) => {
      const payload = { cwd: f.root, session_id: session, hook_event_name: 'UserPromptSubmit',
        prompt: `<skill-context name="${skill.slice(1)}">Change a Story's requirements.\nARGUMENTS: ${words}\n</skill-context>` };
      await recordRepositoryBoundaryTurn(payload, { captureMutation: f.capture });
      return { cwd: f.root, session_id: session };
    },
    run: (payload, command, cwd) => repositoryToolGuard({ ...payload, hook_event_name: 'PreToolUse', tool_name: 'run_in_terminal', tool_input: { command, cwd } }),
    edit: (payload, file) => repositoryToolGuard({ ...payload, hook_event_name: 'PreToolUse', tool_name: 'replace_string_in_file',
      tool_input: { filePath: file, oldString: 'x', newString: 'y' } })
  }
});

const DECIDE = `singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id ${WORK}`;
const ACKNOWLEDGE = `singularity-flow story intent-amendment acknowledge AMD-001 --work-id ${WORK}`;

test('the skill is /sf-reject\'s intent-amendment route on its own, with the shared blocks copied as they are', () => {
  const amend = skillText('sflow-amend');
  const reject = skillText('sflow-reject');
  const frontmatter = YAML.parse(amend.match(/^---\n([\s\S]*?)\n---\n/u)[1]);
  assert.equal(frontmatter.name, 'sflow-amend');
  assert.equal(frontmatter['disable-model-invocation'], true);
  assert.equal(frontmatter.agent, 'agent');
  assert.match(frontmatter['argument-hint'], /^\[WORK-ID\] \[status\|draft\|preview\|propose\]/u);
  // The pause check, the output contract and the boundary, exactly as /sf-reject (the same class and boundary) carries them.
  for (const marker of ['<!-- sflow-copilot-pause -->', '<!-- sflow-output-contract: governed-review -->', '<!-- sflow-execution-boundary -->']) {
    const line = (text) => text.split('\n')[text.split('\n').indexOf(marker) + 1];
    assert.ok(line(reject), marker);
    assert.equal(line(amend), line(reject), marker);
  }
  const { skills } = YAML.parse(readFileSync(new URL('plugin/skills/registry.yml', ROOT), 'utf8'));
  assert.deepEqual(skills['sflow-amend'], { class: 'review' }, 'the default budget, no override');
  // Every SFlow command its own steps name (after the shared blocks) reads, or drafts and proposes the amendment; it never
  // names a decision or an acknowledgement.
  const marker = '<!-- sflow-execution-boundary -->\n';
  const steps = amend.slice(amend.indexOf('\n', amend.indexOf(marker) + marker.length) + 1);
  const named = [...steps.matchAll(/`((?:singularity-flow|sflow) [^`]+)`/gu)].map((match) => match[1].replace(/^(?:singularity-flow|sflow) /u, ''));
  assert.ok(named.length >= 6, named.join('\n'));
  for (const command of named) {
    assert.match(command, /^(?:status|nextsteps|session current|story intent-amendment(?: (?:status|draft|preview|propose))?)(?:\s|$)/u, command);
  }
  assert.doesNotMatch(amend, /intent-amendment (?:decide|acknowledge)/u);
  // Proposed only on the person's own yes to its preview, with their words as the reason [CIC:REQ-015, owner decision 3].
  assert.match(amend, /story intent-amendment propose --work-id <WORK-ID> --file <FILE> --reason "<THEIR WORDS>" --authored governed-agent --channel copilot-host --json/u);
  // The decision and the acknowledgement, said as the product says them: a person's, on the card or in their own terminal.
  assert.match(amend, /The decision and the acknowledgement are a person's, never this turn's: a person who approves the scope decides it on the decisions card, `\/sf-decide <WORK-ID>`/u);
  assert.match(amend, /or in their own terminal/u);
  assert.match(amend, /Never decide or acknowledge here/u);
  // No new exit: no sentence in it stops, halts, ends the turn or hands off (test/exit-ratchet.test.mjs reads the same words).
  const reviewed = JSON.parse(readFileSync(new URL('test/fixtures/skill-exits.json', ROOT), 'utf8'));
  assert.equal(reviewed['sflow-amend'], undefined);
  assert.doesNotMatch(amend, /\b(?:stop|stops|halt|end (?:this|the|your) turn|hand(?:s|ing)?[ -]?off|handoff)\b/iu);
});

test('drafting and proposing route to /sf-amend propose; reading, deciding and acknowledging name no skill', () => {
  assert.equal(mutationTurnMode('/sf-amend'), mutationTurnMode('/sf-reject'));
  assert.ok(skillsForCommand('story').includes('sf-amend'));
  for (const command of [`singularity-flow story intent-amendment draft --work-id ${WORK} --clause ${WORK}:REQ-001`,
    `singularity-flow story intent-amendment propose --work-id ${WORK} --file amended.md --reason "The value changed."`,
    `sflow story intent-amendment propose --work-id ${WORK} --file amended.md --reason x --authored governed-agent --channel copilot-host --json`]) {
    assert.equal(skillForCommandLine(command), 'sf-amend', command);
    assert.equal(copilotCommandForCommand(command), '/sf-amend propose', command);
    assert.deepEqual([safeCommandGuidance(command)?.skill, safeCommandGuidance(command)?.copilotCommand], ['/sf-amend', '/sf-amend propose'], command);
    // /sf-reject's own form still drafts and proposes: a producer that names it is given the dedicated route.
    assert.equal(copilotAction({ skill: '/sflow-reject', command }).copilotCommand, '/sf-amend propose', command);
  }
  for (const command of [`singularity-flow story intent-amendment status --work-id ${WORK} --json`, `singularity-flow story intent-amendment preview AMD-001 --work-id ${WORK}`,
    `singularity-flow story intent-amendment --work-id ${WORK}`, DECIDE, ACKNOWLEDGE]) {
    assert.equal(commandLineWithoutSkill(command), true, command);
    assert.equal(copilotCommandForCommand(command, '/sf-amend'), null, command);
  }
  // nextsteps and the guide offer the dedicated route wherever proposing can succeed.
  const offered = workflowGuide(story()).nextActions.find((action) => action.command.includes('intent-amendment propose'));
  assert.deepEqual([offered.skill, offered.copilotCommand], ['/sf-amend', '/sf-amend propose']);
});

/**
 * Commands to hold both turns to: every SFlow command a packaged skill names (its placeholders filled), every
 * command form of a person's step the golden pins, and the amendment's own forms with and without its Story.
 */
function corpus() {
  const fill = (raw) => raw.replace(/\[[^\]]*\]/gu, ' ').replace(/<([^<>]+)>/gu, (_, name) => (/WORK-ID|STORY/u.test(name) ? WORK
    : /FILE|PATH|SPEC/u.test(name) ? '/tmp/amended.md' : 'x1')).replace(/(\w)\|[\w|-]+/gu, '$1').replace(/\s+/gu, ' ').trim();
  const lines = new Set();
  for (const name of readdirSync(new URL('plugin/skills/', ROOT)).filter((entry) => entry.startsWith('sflow-'))) {
    for (const match of skillText(name).matchAll(/`((?:singularity-flow|sflow) [^`]+)`/gu)) lines.add(fill(match[1]));
  }
  const golden = JSON.parse(readFileSync(new URL('test/fixtures/person-step-golden.json', ROOT), 'utf8'));
  for (const row of [...golden.inProgress, ...golden.awaitingApproval]) lines.add(row.command.replaceAll('PMC-1', WORK));
  for (const action of ['status', 'draft', 'preview', 'propose', 'decide AMD-001', 'acknowledge AMD-001']) {
    for (const tail of ['', ` --work-id ${WORK}`, ' --work-id OTHER-1', ` --work-id ${WORK} --file /tmp/amended.md --reason x`,
      ` --work-id ${WORK} --file /tmp/amended.md --reason x --authored governed-agent --channel copilot-host --json`, ' --file /tmp/amended.md --reason x']) {
      lines.add(`singularity-flow story intent-amendment ${action}${tail}`);
    }
  }
  for (const line of [`singularity-flow reopen ${WORK} --fetch --to build --reason x`, `singularity-flow reject build --work-id ${WORK} --to intake --reason x`,
    `singularity-flow story rework roll-forward --work-id ${WORK} --change-request CR-001 --json`, `singularity-flow choices begin reject ${WORK} --json`,
    `singularity-flow choices begin amend ${WORK} --json`, 'singularity-flow choices answer tok-1 --value x', 'singularity-flow choices status --json',
    `singularity-flow decisions record ${WORK} --choose d1=dismiss --confirm sha256:${'c'.repeat(64)}`]) lines.add(line);
  return [...lines].map((line) => validateSflowExecutionCommand(line, { shell: 'posix' })?.argv).filter((argv) => argv?.length);
}

test('a /sf-amend turn admits no command a /sf-reject turn refuses, and records only the bound Story\'s proposal', () => {
  const argvs = corpus();
  assert.ok(argvs.length > 800, `${argvs.length} commands`);
  const value = (skill, decisionEnded) => ({ skill, decisionEnded, originPhase: 'build', contract: { workId: WORK, phaseId: 'build' } });
  const wider = [];
  const recorded = new Set();
  let rejectOnly = 0;
  for (const argv of argvs) for (const decisionEnded of [false, true]) {
    const amend = argvAllowed(argv, 'approval-only', value('/sf-amend', decisionEnded));
    const reject = argvAllowed(argv, 'approval-only', value('/sf-reject', decisionEnded));
    if (amend && !reject) wider.push(argv.join(' '));
    if (reject && !amend) rejectOnly += 1;
    // What every turn runs, a read turn too (rehydrating a pinned document), is no part of either route.
    if (!amend || argvAllowed(argv, 'read', value('/sf-help', decisionEnded))) continue;
    const { positionals, options } = parseArgs([...argv]);
    try { positionals[0] = canonicalCommand(positionals[0]); } catch { /* as written */ }
    const classification = (() => { try { return resolveOperation({ requestedCommand: positionals[0], positionals, options }).classification; } catch { return null; } })();
    if (classification !== 'read') recorded.add(`${positionals.join(' ')} work-id=${options['work-id']} file=${typeof options.file} ended=${decisionEnded}`);
  }
  assert.deepEqual(wider, [], 'a /sf-amend turn admitted what a /sf-reject turn refuses');
  assert.ok(rejectOnly > 0, '/sf-reject keeps its other routes; /sf-amend has none of them');
  // Beyond what any turn runs, its one recorded step: proposing the bound Story's amendment from a file, before the turn's decision ended.
  assert.deepEqual([...recorded], [`story intent-amendment propose work-id=${WORK} file=string ended=false`]);
});

for (const [host, { enter, run, edit }] of Object.entries(HOSTS)) {
  test(`${host}: a /sf-amend turn reads, drafts in the issued file and proposes; deciding and acknowledging get the card`, async (t) => {
    const f = await fixture(t);
    const payload = await enter(f, `amend-${host}`);
    const propose = `singularity-flow story intent-amendment propose --work-id ${WORK} --file "${f.draft}" --reason "The value must be 2." --authored governed-agent --channel copilot-host --json`;
    for (const command of ['singularity-flow status --for-agent --json', 'singularity-flow nextsteps --for-agent --json',
      `singularity-flow story intent-amendment status --work-id ${WORK} --json`, `singularity-flow story intent-amendment draft --work-id ${WORK} --clause ${WORK}:REQ-001`,
      `singularity-flow story intent-amendment preview --work-id ${WORK} --file "${f.draft}" --for-agent --json`, propose]) {
      assert.deepEqual(await run(payload, command, f.root), {}, `${host}: ${command}`);
    }
    // The person's own steps: the same refusal every turn gets, with the decisions card as their route.
    for (const command of [DECIDE, DECIDE.replace('approve', 'reject'), ACKNOWLEDGE]) {
      const denied = await run(payload, command, f.root);
      assert.equal(denied.permissionDecision, 'deny', `${host}: ${command}`);
      assert.match(denied.permissionDecisionReason, command === ACKNOWLEDGE
        ? new RegExp(`^PHASE_MUTATION_OPERATION_NOT_ALLOWED: acknowledging an approved intent amendment is a person's own step, recorded on the decisions card, never by this turn\\. Tell them to open it with /sf-decide ${WORK}`, 'u')
        : new RegExp(`^PHASE_MUTATION_OPERATION_NOT_ALLOWED: an intent amendment is decided by a person who approves the scope, on the decisions card, never by this turn\\. Tell them to open it with /sf-decide ${WORK} \\(a stale one is refreshed there\\)`, 'u'), `${host}: ${command}`);
      assert.deepEqual([denied.next[0].copilotCommand, denied.next[0].command], [`/sf-decide ${WORK}`, command], `${host}: ${command}`);
    }
    // None of /sf-reject's other routes, nobody else's Story, no proposal a person is credited with, and no other step.
    for (const command of [`singularity-flow reopen ${WORK} --fetch --to build --reason "A closed Story needs a fix."`,
      `singularity-flow reject build --work-id ${WORK} --fetch --to intake --reason "Scope changed."`,
      `singularity-flow story rework roll-forward --work-id ${WORK} --change-request CR-001 --json`, `singularity-flow choices begin reject ${WORK} --json`,
      `singularity-flow story intent-amendment propose --work-id OTHER-1 --file "${f.draft}" --reason x`,
      `singularity-flow story intent-amendment propose --file "${f.draft}" --reason x`,
      `singularity-flow story intent-amendment propose --work-id ${WORK} --file "${f.draft}" --reason x --authored human`,
      `singularity-flow submit build --work-id ${WORK}`, `singularity-flow approve build --work-id ${WORK}`, 'singularity-flow prepare build']) {
      assert.equal((await run(payload, command, f.root)).permissionDecision, 'deny', `${host}: ${command}`);
    }
    // The draft is the one file it writes.
    assert.deepEqual(await edit(payload, f.draft), {}, `${host}: the issued draft`);
    for (const file of [path.join(f.root, 'src', 'App.jsx'), path.join(f.root, 'singularity', 'work-items', WORK, 'artifacts', 'intake', 'requirements.md'),
      path.join(f.root, 'amended-scope.md')]) {
      assert.equal((await edit(payload, file)).permissionDecision, 'deny', `${host}: ${file}`);
    }
    // /sf-reject's turn, for comparison, takes the same draft; an approval turn takes none.
    const reject = await enter(f, `reject-${host}`, '/sf-reject', 'intent-amendment propose');
    assert.deepEqual(await run(reject, propose, f.root), {});
    assert.equal((await run(reject, DECIDE, f.root)).permissionDecision, 'deny');
    const approve = await enter(f, `approve-${host}`, '/sf-approve', 'build');
    assert.equal((await run(approve, propose, f.root)).permissionDecision, 'deny');
    assert.equal((await edit(approve, f.draft)).permissionDecision, 'deny');
  });
}

test('its turn rules name the draft it may write, as /sf-reject\'s do', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(phaseStagingPaths({ gitDirectory: gitDir(f.root), definition: {}, workflow: f.workflow, turnMode: 'approval-only', skill: '/sf-amend' }), [f.draft]);
  assert.deepEqual(phaseStagingPaths({ gitDirectory: gitDir(f.root), definition: {}, workflow: f.workflow, turnMode: 'approval-only', skill: 'sflow-amend' }), [f.draft]);
  assert.deepEqual(phaseStagingPaths({ gitDirectory: gitDir(f.root), definition: {}, workflow: f.workflow, turnMode: 'approval-only', skill: '/sf-approve' }), []);
  const payload = { cwd: f.root, sessionId: 'amend-rules', prompt: `/sf-amend ${WORK}` };
  const entered = await recordRepositoryBoundaryTurn(payload, { captureMutation: f.capture });
  assert.match(JSON.stringify(entered), /SFlow turn boundary \(sf-amend\): approval-only turn/u);
  const records = path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const files = readdirSync(records).filter((name) => name.endsWith('.mutation.json'));
  const summaries = await Promise.all(files.map(async (name) => JSON.parse(await readFile(path.join(records, name), 'utf8')).contract?.summary ?? ''));
  assert.ok(summaries.some((summary) => summary.includes(`Draft an intent amendment only at the issued file ${f.draft}, for story intent-amendment propose --file.`)), summaries.join('\n'));
});
