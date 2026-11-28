import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFreeCommandForArgv, modelFreeCommandForCommand, parseModelFreeTarget } from '../src/model-free-commands.mjs';
import { safeCommandGuidance, commandGuidanceForCommands, commandGuidanceLines } from '../src/safe-command-guidance.mjs';

test('model-free presentation preserves supported phase and Story selectors', () => {
  assert.deepEqual(parseModelFreeTarget('custom-build --work-id PILOT-1'), { phase: 'custom-build', workId: 'PILOT-1' });
  for (const [argv, expected] of [
    [['nextsteps', '--json'], '@sflow /next'],
    [['check', '--json'], '@sflow /check'],
    [['instruction', 'list', '--json'], '@sflow /instructions'],
    [['submit', 'custom-build', '--json'], '@sflow /submit custom-build'],
    [['approve', 'custom-check', '--work-id', 'PILOT-1', '--fetch'], '@sflow /approve custom-check --work-id PILOT-1'],
    [['phase', 'publish', 'custom-build', '--authored', 'governed-agent', '--channel', 'copilot-host'], '@sflow /publish custom-build'],
    [['phase', 'publish', 'converge', '--authored', 'deterministic', '--channel', 'kernel-generator'], '@sflow /publish converge']
  ]) assert.equal(modelFreeCommandForArgv(argv), expected);
});

test('unsafe, unsupported, selector-dropping and authority-bearing alternatives are never advertised', () => {
  for (const argv of [
    ['next'], ['nextsteps', 'OTHER-STORY'], ['inputs', 'planning', '--dry-run'],
    ['instruction', 'show', 'web-guide', '--json'], ['instruction', 'list', '--unknown'],
    ['submit', 'build', '--skip-checks'], ['approve', 'phase', '--allow-dirty'],
    ['approve', 'phase', '--yes'], ['approve', 'Story-1', '--phase', 'build'],
    ['phase', 'publish', 'build', '--from', '/private/file'],
    ['phase', 'publish', 'build', '--authored', 'human', '--channel', 'manual-import'],
    ['phase', 'publish', 'build', '--authored', 'governed-agent', '--channel', 'kernel-generator'],
    ['phase', 'publish', 'build', '--channel', 'copilot-host'],
    ['phase', 'publish', '<PHASE>'], ['submit', 'build', '--decision', 'pass=yes']
  ]) assert.equal(modelFreeCommandForArgv(argv), null, argv.join(' '));
  for (const prompt of ['build --yes', 'build now', 'build --work-id OTHER --work-id THIRD', '$(whoami)', 'build; touch x']) {
    assert.throws(() => parseModelFreeTarget(prompt));
  }
  assert.equal(modelFreeCommandForCommand('singularity-flow submit build; touch x'), null);
});

test('CLI and Copilot guidance show derived @sflow options without trusting asserted routes', () => {
  assert.equal(safeCommandGuidance({ command: 'singularity-flow check --json' }).copilotCommand, '/sf-check');
  const guidance = safeCommandGuidance({ command: 'singularity-flow approve build --work-id STORY-1 --fetch', modelFreeCommand: '@evil /approve' });
  assert.equal(guidance.modelFreeCommand, '@sflow /approve build --work-id STORY-1');
  const mapped = commandGuidanceForCommands({ publish: 'singularity-flow phase publish build --authored governed-agent --channel copilot-host' });
  assert.equal(mapped.publish.modelFreeCommand, '@sflow /publish build');
  assert.equal(mapped.publish.copilotStatus, 'available');
  assert.equal(mapped.publish.copilotCommand, '/sf-publish build', 'the publish-only journey never re-enters the phase author');
  assert.match(commandGuidanceLines(mapped.publish, 'Publish').join('\n'), /VS Code \(model-free\): @sflow \/publish build/);
});

test('every decision the Decide card records has the card as its routes, never "no verified equivalent" or "not available" beside it [paid run, 2026-11-14]', async () => {
  const { VSCODE_DECIDE_CARD, VSCODE_WITNESS_REVIEW, commandRouteRows } = await import('../src/model-free-commands.mjs');
  const routes = (command) => commandRouteRows(safeCommandGuidance(command)).map((row) => row.command ?? null);
  // A person's own step the card records as the same decision: its Shell line stays theirs, and Copilot and VS Code open the card.
  for (const [command, copilot] of [
    ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id PAY-1', '/sf-decide PAY-1'],
    ['singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001', '/sf-decide'],
    ['singularity-flow story intent-amendment acknowledge AMD-001 --work-id PAY-1', '/sf-decide PAY-1'],
    ['singularity-flow decisions undo PAY-1 --settled STL-001', '/sf-decide PAY-1'],
    // An accepted risk, test-run risk or test command [owner, 2026-11-15]: still a person's own step.
    ['singularity-flow decision risk PAY-1 --obligation OBL-001 --category evidence --expires 2099-01-01 --reason "Accepted until the lab returns."', '/sf-decide PAY-1'],
    ['singularity-flow decision test-risk PAY-1 --phase build --cause "No browser here." --expires 2099-01-01 --reason "Decided by the approver."', '/sf-decide PAY-1'],
    ['singularity-flow decision test-narrowing PAY-1 --phase build --reason "Decided by the approver."', '/sf-decide PAY-1'],
    ['singularity-flow decision evidence-reuse PAY-1 --phase build --from-attempt TA-001 --reason "Decided by the approver."', '/sf-decide PAY-1'],
    ['singularity-flow decision visual-profile PAY-1 --phase build --profile tablet --not-applicable --reason "Decided by the approver."', '/sf-decide PAY-1'],
    ['singularity-flow decision test-command PAY-1 --accept TCD-001', '/sf-decide PAY-1']
  ]) {
    assert.deepEqual(routes(command), [copilot, command, VSCODE_DECIDE_CARD], command);
    const guidance = safeCommandGuidance(command);
    assert.equal(guidance.skill, '/sf-decide', command);
    // Its own card route asserted is the same route; any other skill still contradicts it.
    assert.equal(safeCommandGuidance({ command, skill: '/sf-decide' })?.copilotCommand, copilot, command);
    assert.equal(safeCommandGuidance({ command, copilotCommand: copilot })?.copilotCommand, copilot, command);
    for (const other of ['/sf-reject', '/sf-amend']) assert.equal(safeCommandGuidance({ command, skill: other }), null, `${command} ${other}`);
  }
  // A decision a /sf-decide turn records on the card's behalf: the card is its VS Code route too.
  for (const command of ['singularity-flow decision scope PAY-1 --fetch --item SRI-0123456789ab --as excluded --reason "Out of scope."',
    'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "Not a defect."',
    'singularity-flow decision plan PAY-1 --add-location PAY-1:AC-001=src/a.mjs --reason "The helper implements it."',
    'singularity-flow upstream-issue decide UPI-001 --work-id PAY-1 --outcome return --reason "The design must change first."',
    'singularity-flow upstream-issue revalidate fix-design --work-id PAY-1 --amendment AMD-001 --outcome unchanged --reason "The design holds as written."'
  ]) assert.deepEqual(routes(command).slice(1), [command, VSCODE_DECIDE_CARD], command);
  // A sign-off: /sf-decide opens the page that takes it, and VS Code's evidence review page is its own.
  const witness = 'singularity-flow decision witness PAY-1 --criterion PAY-1:AC-001 --slot screen --file e.png --confirm states-the-outcome --reason "Looked."';
  assert.deepEqual(routes(witness), ['/sf-decide PAY-1', witness, VSCODE_WITNESS_REVIEW]);
  // A plan row correction is kept on the card too [owner, 2026-11-19]: the card is its VS Code route.
  assert.equal(routes('singularity-flow decision plan PAY-1 --add-row PAY-1:AC-003 --reason "A new clause needs its row."')[2], VSCODE_DECIDE_CARD);
  // What the card does not record keeps its routes: raising an issue, revoking a test command and an appeal's decision.
  for (const command of ['singularity-flow upstream-issue raise --phase fix-design --about AC-001 --problem "The design names the wrong cause."',
    'singularity-flow decision test-command PAY-1 --revoke TCD-001 --reason "The repository configures this runner now."',
    'singularity-flow story adjudicate --answers /tmp/answers.json'
  ]) assert.equal(routes(command)[2], null, command);
  // What the card has no row for keeps no Copilot route: revocations.
  for (const command of ['singularity-flow decision test-command PAY-1 --revoke TCD-001 --reason "The repository configures this runner now."',
    'singularity-flow decision risk PAY-1 --revoke RSK-001 --reason "The lab is back."'
  ]) assert.deepEqual(routes(command).filter((_, at) => at !== 1), [null, null], command);
  // Moved to the card [owner, 2026-11-28]: a forward amendment's two choices and a lapsed exception's renewal are rows it records,
  // and a finding's accepted risk runs from its row on "Do this now"; /sf-decide opens it.
  for (const command of ['singularity-flow upstream-issue decide-amendment FAM-001 --work-id PAY-1 --decision approve --reason "Agreed with the corrected plan." --confirm FAM-001',
    `singularity-flow decision witness-exception PAY-1 --phase build --mapping sha256:${'a'.repeat(64)} --expires 2099-01-01 --reason "The device lab is still down."`,
    'singularity-flow decision finding-risk PAY-1 --phase build --finding F-0123456789abcdef --expires 2099-01-01 --reason "The nested branches mirror the table."',
    // A sign-off handed to a later step and a screen that differs have rows of their own too [owner, 2026-11-28].
    'singularity-flow decision visual-risk PAY-1 --comparison visual-0123456789abcdef01234567 --expires 2099-01-01 --reason "One pixel row differs."',
    'singularity-flow decision witness-defer PAY-1 --criterion PAY-1:AC-001 --slot screen --to build --reason "The later step changes it."'
  ]) assert.deepEqual(routes(command).filter((_, at) => at !== 1), ['/sf-decide PAY-1', VSCODE_DECIDE_CARD], command);
});

test('every person\'s own step the Decide card records has the card as its Copilot route, and stays the person\'s [owner, 2026-11-15]', async () => {
  const { EFFECT_ORDER } = await import('../src/decision-list.mjs');
  const { PERSON_STEPS, OWN_TERMINAL_STEPS, PERSON_DECISIONS, ANSWER_BOUND_STEPS } = await import('../src/person-step-catalog.mjs');
  const { ownTerminalStep } = await import('../src/command-skills.mjs');
  // One command form per catalog row the card records (decision-list.mjs EFFECT_ORDER): a new one fails until it is named here.
  const FORMS = {
    risk: 'singularity-flow decision risk PAY-1 --obligation OBL-001 --category evidence --expires 2099-01-01 --reason "Accepted until the lab returns."',
    'test-command': 'singularity-flow decision test-command PAY-1 --accept TCD-001',
    'test-narrowing': 'singularity-flow decision test-narrowing PAY-1 --phase build --reason "Decided by the approver."',
    'test-run-risk': 'singularity-flow decision test-risk PAY-1 --phase build --cause "No browser here." --expires 2099-01-01 --reason "Decided by the approver."',
    'evidence-reuse': 'singularity-flow decision evidence-reuse PAY-1 --phase build --from-attempt TA-001 --reason "Decided by the approver."',
    'visual-profile': 'singularity-flow decision visual-profile PAY-1 --phase build --profile tablet --not-applicable --reason "Decided by the approver."',
    'refactor-behaviour': 'singularity-flow work behaviour keep --work-id PAY-1',
    'witness-exception': `singularity-flow decision witness-exception PAY-1 --phase build --mapping sha256:${'a'.repeat(64)} --expires 2099-01-01 --reason "The device lab is still down."`,
    'forward-amendment': 'singularity-flow upstream-issue decide-amendment FAM-001 --work-id PAY-1 --decision approve --reason "Agreed with the corrected plan." --confirm FAM-001'
  };
  // Also a /sf-decide turn's bound yes [owner, 2026-11-28]: the card records them, and so does that turn on the person's Yes.
  const CHAT_YES = ['test-narrowing', 'test-run-risk', 'evidence-reuse', 'visual-profile', 'witness-exception', 'forward-amendment'];
  const recorded = PERSON_STEPS.filter((row) => (String(row.guard).startsWith('own:') || CHAT_YES.includes(row.id)) && [row.effect ?? []].flat().some((effect) => EFFECT_ORDER.includes(effect)));
  assert.deepEqual(recorded.map((row) => row.id).sort(), Object.keys(FORMS).sort(), 'a card-recorded own step needs its form here');
  // The card's own steps named by their effects (an amendment's decision and acknowledgement, a settled one's undo).
  const named = [...Object.values(FORMS), 'singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id PAY-1',
    'singularity-flow story intent-amendment acknowledge AMD-001 --work-id PAY-1', 'singularity-flow decisions undo PAY-1 --settled STL-001'];
  // Terminal-to-card (ceremony-decisions, owner 2026-11-19): an acknowledgement and an undo are also a /sf-decide turn's
  // bound yes, so they are the person's as answer-bound decisions of that turn, no longer own-terminal steps.
  const decideYes = new Set(['singularity-flow story intent-amendment acknowledge AMD-001 --work-id PAY-1', 'singularity-flow decisions undo PAY-1 --settled STL-001',
    ...CHAT_YES.map((id) => FORMS[id])]);
  for (const command of named) {
    const guidance = safeCommandGuidance(command);
    assert.equal(guidance?.copilotCommand, '/sf-decide PAY-1', command);
    if (decideYes.has(command)) {
      const words = command.split(/\s+/u).slice(1).filter((word) => !word.startsWith('-'));
      const decision = PERSON_DECISIONS.find((entry) => entry.matches(words, {}));
      assert.deepEqual([decision?.owners, ANSWER_BOUND_STEPS.includes(decision?.id)], [['decide'], true], command);
    } else {
      // Still the person's own terminal step: the guard refuses it in every turn, and the Shell line is the command itself.
      assert.ok(OWN_TERMINAL_STEPS.some((step) => step.id === ownTerminalStep(command)), command);
    }
    assert.equal(guidance.command, command);
  }
});

test('a person\'s own command that a VS Code screen finishes names that screen, never "not available" [audit 2026-11-19, entry 4]', async () => {
  const { readFile } = await import('node:fs/promises');
  const { VSCODE_DECIDE_CARD, VSCODE_WITNESS_REVIEW, commandRouteRows } = await import('../src/model-free-commands.mjs');
  const palette = (title) => `Command Palette: Singularity Flow: ${title}`;
  const VSCODE_SCREENS = { reject: palette('Approvals, then Request changes…'), reopen: palette('Request Changes to a Closed Story'),
    cancel: palette('Cancel and Archive Story'), start: palette('Start Work'), sessionWorkspace: palette('Attach Copilot Session to Workspace'),
    workspaceUse: palette('Work in This Workspace'), configuration: palette('Configuration Approvals'),
    testPolicy: palette('Review Story Test Policy and Recovery'), appeal: palette('Resolve Phase Issues and Appeals') };
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const titles = new Set(manifest.contributes.commands.map((entry) => entry.category ? `${entry.category}: ${entry.title}` : entry.title));
  // Each route names a Command Palette entry the extension contributes, by its exact title.
  for (const route of [...Object.values(VSCODE_SCREENS), VSCODE_DECIDE_CARD, VSCODE_WITNESS_REVIEW]) {
    const title = route.replace(/^Command Palette: /u, '').replace(/, then .*$/u, '');
    assert.ok(titles.has(title), `${route}: no VS Code command is titled "${title}"`);
  }
  const routes = (command) => commandRouteRows(safeCommandGuidance(command))[2].command ?? null;
  for (const [command, screen] of [
    ['singularity-flow reject build --work-id PAY-1 --to design --reason "<REASON>"', VSCODE_SCREENS.reject],
    ['singularity-flow reject PAY-1 --fetch --phase build --to design --reason "The design names the wrong table."', VSCODE_SCREENS.reject],
    ['singularity-flow reopen PAY-1 --to release --reason "<REASON>"', VSCODE_SCREENS.reopen],
    ['singularity-flow cancel PAY-1 --reason "<REASON>" --confirm PAY-1', VSCODE_SCREENS.cancel],
    ['singularity-flow start PAY-2 --from-branch main --title "<TITLE>"', VSCODE_SCREENS.start],
    ['singularity-flow session workspace payments', VSCODE_SCREENS.sessionWorkspace],
    ['singularity-flow workspace use payments', VSCODE_SCREENS.workspaceUse],
    ['singularity-flow configuration approve sflow/proposals/people-1 --confirm 0123456789abcdef0123456789abcdef01234567', VSCODE_SCREENS.configuration],
    ['singularity-flow configuration reject sflow/proposals/people-1 --confirm 0123456789abcdef0123456789abcdef01234567 --reason "<REASON>"', VSCODE_SCREENS.configuration],
    ['singularity-flow story test-policy amend --work-id PAY-1 --phase build --reason "<REASON>"', VSCODE_SCREENS.testPolicy],
    ['singularity-flow story test-policy show --work-id PAY-1', VSCODE_SCREENS.testPolicy],
    ['singularity-flow appeal repair-plan --work-id PAY-1 --phase build', VSCODE_SCREENS.appeal],
    ['singularity-flow appeal preflight --work-id PAY-1 --phase build', VSCODE_SCREENS.appeal]
  ]) {
    assert.equal(routes(command), screen, command);
    assert.equal(modelFreeCommandForCommand(command), screen, command);
  }
  // What no screen runs keeps no route: a clause-scoped return, releasing a cancelled checkout, a start the form cannot
  // express, a workspace's other repository, a configuration of another lead, test-policy steps the page has no choice
  // for, and an appeal it hands to chat.
  for (const command of ['singularity-flow reject build --work-id PAY-1 --to design --clause PAY-1:AC-001 --reason "<REASON>"',
    'singularity-flow cancel PAY-1 --release --apply --confirm PAY-1',
    'singularity-flow start PAY-2 --from-branch main --test-policy-confirm sha256:0123', 'singularity-flow start --title "<TITLE>"',
    'singularity-flow workspace use payments --repository api',
    'singularity-flow configuration approve sflow/proposals/people-1 --lead https://example.test/lead.git',
    'singularity-flow story test-policy repair --work-id PAY-1 --plan',
    'singularity-flow appeal prepare --phase build --add-location PAY-1:AC-001=src/a.mjs --reason "<REASON>"'
  ]) assert.equal(modelFreeCommandForCommand(command), null, command);
});
