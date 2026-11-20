/**
 * Every route VS Code's own chat is handed exists there, and none sends it round [hardening C, "walk the VS Code path";
 * owner's Story, 2026-11-20]. Fast, no Story; the journeys that walk it on real Stories are test/journey-vscode.test.mjs.
 *
 *   1. Every page tool the skills name (#sflowX, sflow_x, singularityFlow_X) is one VS Code or Copilot CLI has.
 *   2. Every status a page tool answers has a rule: its tool description or its calling skill names it, or it says what
 *      happens next itself. None answers "busy" or "already open" with nothing to follow: a second ask waits for the open
 *      page and gets its answer.
 *   3. Every Command Palette route the engine names is a command VS Code contributes, and the Decide card's routes give
 *      VS Code's chat its own way (#sflowDecide), never only Copilot CLI's /decide.
 *   4. No skill's in-turn hand-offs (do /sf-x N-M now) and VS Code branches form a cycle with nothing changed between.
 *
 * Not walked yet on a real Story (each needs a fixture the journeys do not have): a decision that holds the approval (V2,
 * covered by test/vscode-decide-card-summary-note.test.mjs on engine packets), a reviewer's finding disputed from VS Code
 * (V4, offered items are the offered-not-asked branch's), a test-run risk put in a terminal from the card (V5), a sign-off
 * on the card (V7; its "Not sure" words are checked below) and a convergence step (V8; the page's wait is checked below).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentAct } from '../src/agent-output.mjs';
import { decideCardNext, withStoryNext } from '../src/commands/decisions.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { VSCODE_DECIDE_CARD, VSCODE_SELECT_STORY, VSCODE_WITNESS_REVIEW, vscodeDecideCardChat } from '../src/model-free-commands.mjs';
import { decideCardInThisChat } from '../src/phase-mutation-contract.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { unsureWords } from '../src/sign-off-question.mjs';
import { onVscodeChat, skillToolBranches, vscodeChatNames } from './helpers/route-follower.mjs';
import { loadVscodeHost, vscodeHost } from './helpers/vscode-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const manifest = JSON.parse(read('apps/vscode/package.json'));
const names = vscodeChatNames(ROOT);
const skills = new Map(readdirSync(path.join(ROOT, 'plugin/skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
  .flatMap((entry) => { try { return [[entry.name, read(`plugin/skills/${entry.name}/SKILL.md`)]]; } catch { return []; } }));
const W = 'VCR-1';

// ------------------------------------------------------------------------------------------- 1

test('every page tool a skill names is a tool VS Code or Copilot CLI has', () => {
  const vscodeTools = new Set(manifest.contributes.languageModelTools.flatMap((tool) => [tool.name, `#${tool.toolReferenceName ?? tool.name}`]));
  const copilotCli = new Set([...read('plugin/extensions/decisions/extension.mjs').matchAll(/name: '(sflow_\w+)'/gu)].map((match) => match[1]));
  for (const tool of manifest.contributes.languageModelTools) if (tool.name.startsWith('sflow_')) copilotCli.add(tool.name);
  const missing = [];
  for (const [name, text] of skills) {
    for (const [reference] of text.matchAll(/#sflow[A-Z]\w*|\bsingularityFlow_\w+|\bsflow_[a-z]\w*/gu)) {
      if (!vscodeTools.has(reference) && !copilotCli.has(reference)) missing.push(`${name}: ${reference}`);
    }
  }
  assert.deepEqual(missing, []);
  // The branch the VS Code walk takes is read from the skill, as the agent reads it: /sf-decide step 1, and what follows it.
  assert.deepEqual(skillToolBranches().get('/sf-decide')?.[0], { step: 1, reference: '#sflowDecide', copilotCli: 'sflow_decide', inputs: ['workId'],
    then: { command: 'singularity-flow decisions <WORK-ID> --for-agent --json', unless: 'approval-*' } });
});

// ------------------------------------------------------------------------------------------- 2

/** A function's own text in a source file, from its declaration to its closing brace at the start of a line. */
const functionText = (relative, name) => {
  const text = read(relative);
  const start = text.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(|\\n  (?:private |public )?(?:async )?${name}\\(`, 'u'));
  assert.ok(start >= 0, `${name} in ${relative}`);
  const end = text.indexOf(text[start + 1] === ' ' ? '\n  }\n' : '\n}\n', start);
  return text.slice(start, end);
};
/** Each page tool: the code its statuses come from, and the skills that call it. */
const PAGE_TOOLS = {
  singularityFlow_decide: { sources: () => [read('apps/vscode/src/views/decide-card.ts'), read('apps/vscode/src/views/decide-card-page.ts')], skills: ['sflow-decide', 'sflow-approve'] },
  singularityFlow_adjudicate: { sources: () => [read('apps/vscode/src/views/adjudication.ts')], skills: ['sflow-converge'] },
  singularityFlow_witnessReview: { sources: () => [functionText('apps/vscode/src/views/decision-list.ts', 'reviewWitness'), functionText('apps/vscode/src/views/decision-list.ts', 'witnessReview'),
    functionText('apps/vscode/src/views/decision-list-model.ts', 'runWitnessReview')], skills: ['sflow-decide', 'sflow-outcome'] },
  singularityFlow_deliveryValidation: { sources: () => [functionText('apps/vscode/src/views/outcome-review.ts', 'guideDelivery'), functionText('apps/vscode/src/views/outcome-review.ts', 'chooseDelivery')],
    skills: ['sflow-outcome'] }
};
// A status whose answer carries what to do next itself, so no rule is needed for it: why, for each.
const SAYS_ITSELF = {
  recorded: 'what was recorded, and its remaining or next',
  cancelled: 'nothing recorded; the tool descriptions say not to call again after it',
  drafted: 'the draft is the next step, named in the message',
  'nothing-to-decide': 'the Story\'s next step is its next',
  'nothing-open': 'nothing to decide; the step goes on',
  'not-open': 'the list\'s own message',
  'not-prepared': 'the list\'s own message',
  refused: 'the engine\'s refusal words',
  unavailable: 'no sign-off for this person here; the Decide card says whose',
  selected: 'VS Code already ran it (ranHere); never run again',
  blocked: 'a refusal, with what it said and, for another Story, the route to select it'
};
const statusesIn = (text) => new Set([...text.matchAll(/status: '([a-z-]+)'/gu)].map((match) => match[1]));

test('every status a page tool answers has a rule, and none answers "busy" with nothing to follow', () => {
  const missing = [];
  for (const [tool, { sources, skills: callers }] of Object.entries(PAGE_TOOLS)) {
    const description = manifest.contributes.languageModelTools.find((entry) => entry.name === tool).modelDescription;
    const statuses = new Set([...sources().flatMap((source) => [...statusesIn(source)]), ...statusesIn(read('apps/vscode/src/lm-decision-tools.ts'))]);
    for (const status of statuses) {
      assert.notEqual(status, 'busy', `${tool} answers busy: a second ask waits for the open page instead`);
      assert.notEqual(status, 'already-open', `${tool} answers already-open: a second ask waits for the open page instead`);
      const named = new RegExp(`\\b${status}\\b|\`${status.split('-')[0]}-\\*\``, 'u');
      if (!SAYS_ITSELF[status] && !named.test(description) && !callers.some((caller) => named.test(skills.get(caller) ?? ''))) missing.push(`${tool}: ${status}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('a second ask while a page is open waits for it and gets the person\'s answer there (the convergence decisions page)', async () => {
  // The adjudication page on a list as `story adjudications --json` returns it (test/story-adjudicate-terminal.test.mjs).
  const list = { status: 'open', workId: W, phase: 'convergence', open: 1, digest: 'sha256:abc', repositoryPath: ROOT, settled: [],
    items: [{ id: 'CF-1', kind: 'unclaimed-changed-path', paths: ['src/a.js'], clauseIds: [], detail: null, plan: null, acceptAll: true, decision: null }],
    decidedBy: { groups: ['leads'], labels: ['Leads'], allowed: true, words: 'You may decide these (Leads).' },
    dispositions: [{ id: 'accepted-deviation', label: 'Accept as is' }, { id: 'rework', label: 'Send back to fix' }] };
  const client = { repository: ROOT, invalidateReads() {}, run: async () => list, forkForRepository() { return client; } };
  const host = await vscodeHost({ workId: W, root: ROOT }, { client, person: { adjudicate: () => 'cancel' } });
  const first = host.command('singularityFlow.adjudicate');
  for (let waited = 0; waited < 5_000 && !host.panels.length; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await host.callTool('singularityFlow_adjudicate', { workId: W });
  assert.equal(host.panels.filter((panel) => panel.viewType === 'singularityFlow.adjudicate').length, 1, 'no second page');
  assert.equal(second.status, 'cancelled');
  assert.match(second.message, /^The convergence decisions for VCR-1 were already open; this is what the person did there\. No decision was recorded\.$/u);
  assert.equal((await first).status, 'cancelled');
});

test('"Not sure" on a sign-off names no skill to go back to: the review was called from /sf-decide, on its card', () => {
  assert.equal(unsureWords(W), 'Nothing was recorded for VCR-1. Ask someone who knows that screen, or take the screenshot again; the sign-off stays open on the Decide card.');
  assert.doesNotMatch(unsureWords(W), /\/sf-|\/decide/u);
  // The Copilot CLI card keeps the same words.
  assert.match(read('plugin/extensions/decisions/card.mjs'), /export const unsureWords = \(workId\) => `Nothing was recorded for \$\{workId\}\. Ask someone who knows that screen, or take the screenshot again; the sign-off stays open on the Decide card\.`;/u);
});

// ------------------------------------------------------------------------------------------- 3

test('every Command Palette route the engine names is a command VS Code contributes', async () => {
  const routes = new Set([VSCODE_DECIDE_CARD, VSCODE_WITNESS_REVIEW, VSCODE_SELECT_STORY]);
  for (const [route] of read('src/model-free-commands.mjs').matchAll(/Command Palette: [^'`"$]+/gu)) routes.add(route.trim());
  // The screens a person's own command opens (model-free-screens.mjs rows: title first; "X, then Y" opens X).
  for (const [, title] of read('src/model-free-screens.mjs').matchAll(/\[\s*'([^']+)', '[a-z]/gu)) routes.add(`Command Palette: Singularity Flow: ${title.split(', then ')[0]}`);
  const missing = [...routes].filter((route) => !onVscodeChat(names, route));
  assert.deepEqual(missing, []);
});

test('the Decide card\'s routes give VS Code\'s chat #sflowDecide beside Copilot CLI\'s /decide, from the list, a refusal plan and a denied turn', () => {
  const chatRoute = vscodeDecideCardChat(W);
  assert.equal(chatRoute, `#sflowDecide ${W}`);
  assert.equal(onVscodeChat(names, chatRoute), true);
  assert.equal(onVscodeChat(names, `/decide ${W}`), false, 'Copilot CLI\'s /decide is no VS Code route');
  assert.equal(decideCardNext(W).vscodeChat, chatRoute);
  assert.equal(decideCardInThisChat({ argv: ['decisions', W] }, W).vscodeChat, chatRoute);
  // Every remediation step that names /decide names VS Code's way to the card too.
  const refused = Object.assign(new Error('Refused.'), { code: 'PLAN_AMENDMENT_INVALID', details: { workId: W } });
  const card = refusalRemediationPlan(refused, ['approve', 'code']).steps.find((step) => step.id === 'open-decision-list');
  assert.deepEqual([card?.copilotCommand, card?.vscodeChat], [`/decide ${W}`, chatRoute]);
  // An agent reading a list whose next is the card: do.vscodeChat, called once, never again after it answered in the turn.
  const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } };
  const workflow = { workItem: { id: W, workType: 'custom' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    history: [], resolution: { approvalAuthorities: AUTHORITIES, presence: { status: 'on' } },
    phases: { specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } } } };
  const amendment = { id: 'AMD-001', status: 'approved', changedClauses: [`${W}:AC-001`], affectedPhases: ['implementation'], acknowledgementRequired: true, acknowledgedAt: null };
  const list = withStoryNext({ ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { intentAmendments: [amendment] } },
    { authorities: AUTHORITIES, actor: { name: 'Person', email: 'person@example.invalid' }, at: '2026-11-20T09:00:00.000Z' })), repositoryPath: '/repo' }, null);
  const act = agentAct(list);
  assert.equal(act.state, 'confirm-in-terminal');
  assert.equal(act.do.vscodeChat, chatRoute);
  assert.match(act.said, /In VS Code's own chat, which has no \/decide, the card is do\.vscodeChat: call that tool once with workId only, unless it already answered in this turn; then give do\.vscodeChat and do\.vscode\./u);
});

test('@sflow\'s Prepare button fills only a route VS Code\'s chat has, never Copilot CLI\'s /decide', () => {
  const source = read('apps/vscode/src/sflow-chat.ts');
  assert.match(source, /if \(isChatRoute\(rendered\.copilot\)\) \{\n\s+stream\.button\(\{\n\s+command: 'singularityFlow\.prefillParticipantAction'/u);
  assert.match(source, /'singularityFlow\.prefillParticipantAction', async \(skill: string, commandId: string\) => \{\n\s+if \(!isChatRoute\(skill\)\) return;/u);
});

test('sflow_run after the person declined VS Code\'s dialog says so: it never runs without a receipt, whose refusal brought the dialog back', () => {
  const source = read('apps/vscode/src/extension.ts');
  assert.match(source, /return ran \?\? \(declined \? SFLOW_RUN_DECLINED : kernel\.run\(/u);
  assert.match(source, /code: 'gateway\.confirmation-declined'/u);
  assert.match(source, /Do not call sflow_run for it again/u);
});

test('the four page tools are registered from the one table the VS Code journeys call', async () => {
  const { tools } = await loadVscodeHost();
  assert.deepEqual(Object.keys(tools.DECISION_TOOLS).sort(), manifest.contributes.languageModelTools.map((tool) => tool.name).filter((name) => name.startsWith('singularityFlow_')
    && ['singularityFlow_decide', 'singularityFlow_adjudicate', 'singularityFlow_witnessReview', 'singularityFlow_deliveryValidation'].includes(name)).sort());
  assert.match(read('apps/vscode/src/extension.ts'), /for \(const name of Object\.keys\(DECISION_TOOLS\)\) \{\n\s+context\.subscriptions\.push\(lm\.registerTool\(name, \{\n\s+invoke: async \(options: \{ input\?: Record<string, unknown> \}\) => toolAnswer\(await decisionToolAnswer\(name, options\.input,/u);
});

// ------------------------------------------------------------------------------------------- 4

/**
 * The in-turn hand-offs between skills: "do /sf-x N-M now" (that skill's steps, in this turn, with nothing typed between),
 * and a VS Code branch's tool, from the sentence and step that names it. A cycle through them is a loop in one turn unless a
 * change comes first; each reviewed below says what changes.
 */
function handOffs() {
  const edges = [];
  for (const [name, text] of skills) {
    const from = `/${name.replace(/^sflow-/u, 'sf-')}`;
    for (const line of text.split('\n').filter((entry) => /^\d+\. /u.test(entry))) {
      const step = Number(/^(\d+)\./u.exec(line)[1]);
      for (const sentence of line.split(/(?<=[.;!?])\s+/u)) {
        for (const match of sentence.matchAll(/do (\/sf-[a-z-]+) (\d+)(?:-(\d+))? now/gu)) {
          edges.push({ from, step, to: match[1], steps: [Number(match[2]), Number(match[3] ?? match[2])], sentence: sentence.trim() });
        }
      }
    }
  }
  return edges;
}
// What changes between the two ends of each reviewed hand-off, so it is no loop.
const REVIEWED = {
  '/sf-decide 14 -> /sf-approve 1-6': 'after the person\'s yes records the decisions in this turn (step 14), or with them in the approval\'s one commit',
  '/sf-approve 1 -> /sf-decide 11-14': 'only for `decisions-required`, whose steps 11-14 never reach step 1\'s card or list read'
};

test('no in-turn hand-offs between skills form a cycle with nothing changed between', () => {
  const edges = handOffs();
  const key = (edge) => `${edge.from} ${edge.step} -> ${edge.to} ${edge.steps[0]}-${edge.steps[1]}`;
  // Each edge leaves from one step and enters a range of the other skill's steps; a cycle returns to the step it left.
  const open = edges.filter((edge) => !REVIEWED[key(edge)]);
  const cycles = [];
  const walk = (path) => {
    const last = path.at(-1);
    for (const next of open.filter((edge) => edge.from === last.to && edge.step >= last.steps[0] && edge.step <= last.steps[1])) {
      if (next.to === path[0].from && path[0].step >= next.steps[0] && path[0].step <= next.steps[1]) cycles.push([...path, next].map(key).join(' => '));
      else if (path.length < 6 && !path.includes(next)) walk([...path, next]);
    }
  };
  for (const edge of open) walk([edge]);
  assert.deepEqual(cycles, []);
  // Each reviewed hand-off is still in the skills as reviewed: a changed one is reviewed again.
  for (const reviewed of Object.keys(REVIEWED)) assert.ok(edges.some((edge) => key(edge) === reviewed), `${reviewed} is no longer a hand-off: remove it from REVIEWED`);
  // And /sf-decide step 1's own hand-off to /sf-approve runs only after its card did not open the approval page.
  const step1 = skills.get('sflow-decide').split('\n').find((line) => line.startsWith('1. '));
  assert.ok(step1.indexOf('unless it returned `approval-*`') < step1.indexOf('do /sf-approve 1-6 now'));
});

test('a skill names Copilot CLI\'s /decide only as Copilot CLI\'s, never as VS Code\'s chat route', () => {
  const found = [];
  for (const [name, text] of skills) {
    for (const match of text.matchAll(/(?<![\w-])\/decide\b/gu)) if (!/Copilot CLI: `?$/u.test(text.slice(Math.max(0, match.index - 14), match.index))) found.push(`${name}: ${text.slice(match.index - 40, match.index + 20)}`);
  }
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------------------------------------- the approver nobody established

test('an approver this read could not establish is said so, never "not yours", and the card and the approval page both leave it to the approval', async () => {
  // Owner's Story arshy, 2026-11-20 (VS Code, build 6a510139b): a ready approval with no holds answered "nothing to decide"
  // in VS Code's chat, because the row's decidedBy.allowed was not true, and the chat ended with no route. The read resolves
  // the person as `approve` does (actionActor: Git email, and the GitHub login looked up), so when that lookup did not resolve
  // and the group names its members only by GitHub login, who they are is unknown here, not "someone else".
  const AUTHORITIES = { reviewers: { label: 'Engineering reviewers', members: [{ name: 'Pat', githubLogin: 'pat-reviews' }] } };
  const workflow = { workItem: { id: W, workType: 'custom' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'], history: [],
    resolution: { approvalAuthorities: AUTHORITIES },
    phases: { implementation: { id: 'implementation', label: 'Implementation', status: 'awaiting_approval', generation: 5, approvals: [],
      approvalPolicy: { authorities: ['reviewers'], minimum: 1, allowSelfApproval: true } } } };
  const approvalOf = (actor) => decisionPacket(workflow, { phaseId: 'implementation' }, { authorities: AUTHORITIES, actor, at: '2026-11-20T09:00:00.000Z' })
    .items.find((item) => item.kind === 'approval');
  const unknown = approvalOf({ name: 'Me', email: 'me@example.invalid', login: null, githubLookup: 'unavailable' });
  assert.equal(unknown.decidedBy.allowed, false);
  assert.equal(unknown.decidedBy.established, false);
  assert.match(unknown.decidedBy.words, /^SFlow could not tell here whether you are one of the Engineering reviewers: it checks that when you do this\./u);
  // Resolved, or a login to match, or an actor no lookup was made for: as before.
  for (const actor of [{ name: 'Me', email: 'me@example.invalid', login: null, githubLookup: 'resolved' }, { name: 'Me', email: null, login: 'someone-else', githubLookup: 'resolved' },
    { name: 'Me', email: 'me@example.invalid' }]) {
    const known = approvalOf(actor);
    assert.equal(known.decidedBy.allowed, false);
    assert.equal('established' in known.decidedBy, false, JSON.stringify(actor));
    assert.match(known.decidedBy.words, /^The Engineering reviewers \(Pat\) decide this; ask them\./u);
  }
  // The card opens the approval page for the unknown one, and names who for the known one.
  const cardPage = await import('../apps/vscode/src/views/decide-card-page.ts');
  const list = (item) => ({ workId: W, phase: 'implementation', phaseLabel: 'Implementation', items: [item] });
  assert.equal(cardPage.readyApproval(list(unknown)), unknown);
  const theirs = approvalOf({ name: 'Me', email: 'me@example.invalid', login: null, githubLookup: 'resolved' });
  assert.equal(cardPage.readyApproval(list(theirs)), null);
  assert.equal(cardPage.othersApproval(theirs), true);
  // The approval page: no login known and a group named by login only offers Approve, which checks it.
  const { buildApprovals } = await import('../apps/vscode/src/views/approvals-model.ts');
  const snapshot = (identities) => ({ initiative: null, initiatives: [], selectedInitiativeId: null, selectedWorkId: W, workItems: [{ id: W, title: 'A Story' }], identities,
    workflow: { ...workflow, workItem: { ...workflow.workItem, title: 'A Story', branch: W }, phases: { implementation: { ...workflow.phases.implementation, artifacts: [] } } },
    decisions: { schemaVersion: 1, workId: W, decisions: [], ahead: null, pending: null, skipped: [], log: [] } });
  const [open] = buildApprovals(snapshot({ git: { email: 'me@example.invalid' } })).pending;
  assert.equal(open.standing, 'yours');
  assert.equal(open.reason, 'Your GitHub account is not known here, so SFlow cannot confirm you are in this group: approving checks it.');
  const [other] = buildApprovals(snapshot({ git: { email: 'me@example.invalid' }, github: 'someone-else' })).pending;
  assert.equal(other.standing, 'others');
});

test('an approve turn in VS Code always ends with the approval page opened or the person\'s own @sflow /approve, never with no route', async () => {
  // Owner's Story arshy, 2026-11-20: /sf-approve ended "nothing to decide… please review on the approval page" with no route.
  // Each list is the engine's own (decisionPacket, plain words, the list's next) for a step awaiting approval.
  const AUTHORITIES = { planners: { label: 'Planners', allowAnyGitIdentity: true, members: [] } };
  const workflow = { workItem: { id: W, workType: 'custom' }, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['planning', 'implementation'], history: [],
    phases: { planning: { id: 'planning', label: 'Planning', status: 'awaiting_approval', generation: 1, approvals: [], approvalPolicy: { authorities: ['planners'], minimum: 1 },
      artifacts: [] }, implementation: { id: 'implementation', label: 'Implementation', status: 'pending', generation: 0 } },
    resolution: { approvalAuthorities: AUTHORITIES } };
  const engineList = () => withStoryNext({ ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'planning' },
    { authorities: AUTHORITIES, actor: { name: 'Person', email: 'person@example.invalid' }, at: '2026-11-20T09:00:00.000Z' })), repositoryPath: ROOT }, null);
  const base = engineList();
  const approval = base.items.find((item) => item.kind === 'approval');
  const { allowed: ignored, ...noAllowed } = approval.decidedBy;
  const cases = {
    ready: base,
    'approver not established': { ...base, items: [{ ...approval, decidedBy: { ...approval.decidedBy, allowed: false, established: false } }] },
    'no allowed at all': { ...base, items: [{ ...approval, decidedBy: noAllowed }] },
    held: { ...base, items: [{ ...approval, why: '0 of 1 approvals recorded. It waits for the review of the plan first.', details: { ...approval.details, ready: false } }] }
  };
  const PERSON = `@sflow /approve planning --work-id ${W}`;
  for (const [name, list] of Object.entries(cases)) {
    const client = { repository: ROOT, invalidateReads() {}, forkForRepository() { return client; },
      run: async (argv) => { if (argv[0] !== 'decisions') throw new Error('not here'); return { resultType: 'command-result', data: list }; } };
    const host = await vscodeHost({ workId: W, root: ROOT }, { client });
    const answer = await host.callTool('singularityFlow_decide', { workId: W });
    const opened = host.approvals.some((page) => page.focus?.workId === W && page.focus?.phase === 'planning');
    assert.ok(opened || answer.next?.modelFreeCommand === PERSON, `${name}: ${JSON.stringify(answer)}`);
    // Every approval the person may give carries their own model-free route, the page or not; nothing a chat would take itself.
    assert.equal(answer.next?.modelFreeCommand, PERSON, `${name}: ${JSON.stringify(answer)}`);
    assert.equal(answer.next?.copilotCommand ?? null, null, name);
    assert.equal(answer.next?.command ?? null, null, name);
    assert.equal(opened, name !== 'held', `${name}: the page opens for a ready approval, not a held one`);
    assert.ok(onVscodeChat(names, PERSON), '@sflow /approve is a participant command VS Code has');
  }
});
