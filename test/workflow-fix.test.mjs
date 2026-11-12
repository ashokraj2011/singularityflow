/**
 * `workflow fix`: every finding `workflow check` / `workflow validate` can raise has a fixer or a
 * declared question (the ratchet), template fixes add only placeholders the kernel reads, the
 * fmly-qa-test-automation findings are drafted into one change set `workflow check --change-set`
 * finds clean, nothing changes until it is proposed, and a person's answers become changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(packageRoot, 'src');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Fix Tester' };

function run(command, args, cwd, { input = '', allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const json = (root, args, options) => JSON.parse(flow(root, [...args, '--json'], options).stdout);

const WORKFLOW = 'fmly-qa-test-automation';
const REQUIREMENTS = ['# {{work.id}} — QA test automation requirements', '', '## Problem', '', 'TODO: State the problem in one or two sentences.', '',
  '## Requirements', '', 'TODO: List what the tests must cover.', '', '## Acceptance criteria', '', 'TODO: List how a person knows it works.', '',
  '## Out of scope', '', 'TODO: State what stays unchanged.', ''].join('\n');
const SKILL = (extra = []) => ['---', 'name: fmly-e2e-test-generation-source', 'description: Generates end-to-end tests from the team source.', '---', '',
  '# E2E test generation', '', 'Read [the page object guide](references/page-objects.md) before writing a page object.',
  'Follow [selectors](references/selectors.md) and [fixtures](references/fixtures.md#setup).',
  'See [naming](references/naming.md), [data](references/test-data.md) and [the overview](README.md).', ...extra, ''].join('\n');

/**
 * A team's custom workflow as the owner met it (2026-11-11): its clause step's template has no clause
 * anchors and no planned-claims table, its skill links five reference files that are not there, and
 * none of its four steps says what it is for.
 */
async function fmlyRepository({ skillLines = [], security = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fix-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Fix Tester'], root); run('git', ['config', 'user.email', 'fix@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Fix\n');
  flow(root, ['init']);
  const files = {
    'singularity/templates/fmly/requirements.md': REQUIREMENTS,
    'singularity/templates/fmly/code.md': '# {{work.id}} — Test code\n\n## Agent brief\n\nTODO: Summarize what changed and why.\n\n## Changed components\n\nTODO: List each changed file.\n',
    'singularity/templates/fmly/testing.md': '# {{work.id}} — Test evidence\n\n## Agent brief\n\nTODO: Summarize the test verdict.\n\n## Test results\n\nTODO: Cite the test receipts.\n',
    'singularity/skill-library/fmly-e2e-test-generation-source/SKILL.md': SKILL(skillLines),
    'singularity/skill-library/fmly-e2e-test-generation-source/README.md': '# Overview\n\nWhat this skill covers.\n',
    'singularity/skill-library/fmly-e2e-test-generation-source/docs/naming.md': '# Naming\n\nName tests after the behaviour.\n',
    '.github/agents/fmly-delivery.agent.md': ['---', 'name: fmly-delivery', 'description: Drafts the QA team\'s requirements, code and testing steps.', 'model: [auto]',
      'tools: [read, search, edit, execute, bash, ask_user]', 'metadata:', '  sflow-label: "QA delivery"', '  sflow-phases: "fmly-requirements,fmly-code,fmly-testing,fmly-review"',
      '  sflow-default-for: "fmly-requirements,fmly-code,fmly-testing,fmly-review"', '  sflow-model-task: "code"', '---', '', '# QA delivery agent', '',
      'Draft the step you are given from its template and the approved inputs.', '',
      '## Attached skills', '', '| Skill | Phases | When to use it |', '|---|---|---|', '| fmly-e2e-test-generation-source | fmly-code | - |', ''].join('\n')
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  const file = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8'));
  const step = (label, template, artifact, kind, approval, extra = {}) => ({ label, defaultTemplate: template,
    artifact: { path: artifact, kind, minimumBytes: 200 }, clarification: { mode: 'off' }, writeScope: 'artifact-only', approval, ...extra });
  // Its scope step asks the person first, as a team's workflow should: the fixes here are the template, links and descriptions.
  config.phases['fmly-requirements'] = step('QA requirements', 'fmly/requirements.md', 'artifacts/fmly-requirements/requirements.md', 'requirements',
    { authorities: ['product-approvers'], minimum: 1, rejectTo: ['fmly-requirements'] },
    { clarification: { mode: 'required', maxQuestions: 5, topics: ['scope', 'acceptance criteria', 'constraints'] } });
  config.phases['fmly-code'] = step('Test code', 'fmly/code.md', 'artifacts/fmly-code/implementation-summary.md', 'implementation-summary',
    { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['fmly-requirements', 'fmly-code'] }, { generation: { task: 'code' }, writeScope: 'source-and-artifact', qualityCommands: [] });
  config.phases['fmly-testing'] = step('Test evidence', 'fmly/testing.md', 'artifacts/fmly-testing/test-evidence.md', 'test-evidence',
    { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['fmly-code', 'fmly-testing'] }, { testEvidenceFrom: 'fmly-code' });
  config.phases['fmly-review'] = step('QA review', 'fmly/testing.md', 'artifacts/fmly-review/review.md', 'review',
    { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['fmly-testing', 'fmly-review'] });
  config.workTypes[WORKFLOW] = { label: 'QA test automation', phases: ['fmly-requirements', 'fmly-code', 'fmly-testing', 'fmly-review'],
    phaseOverrides: { 'fmly-code': { inputs: ['fmly-requirements'] }, 'fmly-testing': { inputs: ['fmly-requirements', 'fmly-code'] }, 'fmly-review': { inputs: ['fmly-testing'] } } };
  if (security) config.approvalSecurity = { ...config.approvalSecurity, ...security };
  await writeFile(file, YAML.stringify(config));
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'team workflow'], root);
  return root;
}

const sourceFiles = async (directory) => (await readdir(directory, { withFileTypes: true, recursive: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
const literals = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);

test('every finding code workflow check or validate can raise has a fixer or a declared question', async () => {
  const { WORKFLOW_FIXERS, CONFIGURATION_FIXER, fixerFor } = await import('../src/workflow-fix/index.mjs');
  const { AGENT_MAPPING_CODES } = await import('../src/workflow-check.mjs');
  const read = (relative) => readFile(path.join(src, relative), 'utf8');
  // Check codes (CHECK_*) wherever a module of the check raises them, templates included.
  const checks = new Set();
  for (const file of await sourceFiles(src)) for (const code of literals(await readFile(file, 'utf8'), /'(CHECK_[A-Z0-9_]+)'/gu)) checks.add(code);
  const routes = new Set(literals(await read('workflow-route-simulation.mjs'), /code: '(WORKFLOW_[A-Z0-9_]+)'/gu));
  const topology = new Set(literals(await read('phase-semantics.mjs'), /add\('(WORKFLOW_[A-Z0-9_]+)'/gu));
  const obligations = new Set(literals(await read('evidence/obligation-compiler.mjs'), /finding\('(OBLIGATION_[A-Z0-9_]+)'/gu));
  assert.ok(checks.size >= 27 && routes.size >= 8 && topology.size >= 5 && obligations.size >= 8,
    `the enumeration found too few codes to trust: ${checks.size} check, ${routes.size} route, ${topology.size} topology, ${obligations.size} obligation`);
  const raised = [...checks, ...routes, ...topology, ...obligations, ...AGENT_MAPPING_CODES];
  const missing = raised.filter((code) => !WORKFLOW_FIXERS[code]);
  assert.deepEqual(missing, [], 'add each to WORKFLOW_FIXERS in src/workflow-fix/registry.mjs: a fixer, or a question with why it is a person\'s');
  for (const [code, entry] of Object.entries(WORKFLOW_FIXERS)) {
    assert.ok(['change', 'question', 'change-or-question'].includes(entry.resolves), `${code} resolves by change, question or change-or-question`);
    assert.equal(typeof entry.fix, 'function', `${code} has a fixer function`);
    assert.equal(typeof entry.order, 'number', `${code} has an order`);
    if (entry.resolves !== 'change') assert.ok(String(entry.why ?? '').length >= 30, `${code} says why its question is a person's`);
  }
  // A configuration that does not load reports its validator's own codes; one fixer takes them all.
  assert.equal(fixerFor({ code: 'YAML_BAD_INDENT' }, { configurationLoads: false }), CONFIGURATION_FIXER);
  assert.equal(fixerFor({ code: 'CHECK_NOT_A_CODE' }, { configurationLoads: true }), null);
  const agentCodes = new Set(literals(await read('agents.mjs'), /code: '(AGENT_[A-Z0-9_]+)'/gu));
  const stale = Object.keys(WORKFLOW_FIXERS).filter((code) => !raised.includes(code) && !agentCodes.has(code));
  assert.deepEqual(stale, [], 'a fixer for a code nothing raises any more');
});

test('template fixes add only placeholders, in the forms the kernel reads', async () => {
  const { withClauseAnchors, withPlannedTable, rebuiltPlannedTable, withSupportedTokens, withStepsColumn, renumberedAnchors, templateAnchors } = await import('../src/workflow-fix/templates.mjs');
  const { extractClauses, inspectPlannedClaimMap } = await import('../src/specifications.mjs');
  const owned = new Set(['header', 'divider', 'row', 'clause', 'fulfillment', 'steps', 'observableResult']);
  const kernelReads = (text) => {
    const rendered = text.replaceAll('{{work.id}}', 'CHECK-1');
    const clauses = extractClauses(rendered).map((clause) => clause.id);
    const diagnostics = inspectPlannedClaimMap(rendered, { clauseIds: clauses }).diagnostics.filter((entry) => owned.has(entry.field));
    return { clauses, diagnostics };
  };
  const fixed = withPlannedTable(withClauseAnchors(REQUIREMENTS).text).text;
  assert.deepEqual(kernelReads(fixed), { clauses: ['CHECK-1:REQ-001', 'CHECK-1:AC-001'], diagnostics: [] });
  const before = REQUIREMENTS.split('\n');
  const after = fixed.split('\n');
  let cursor = 0;
  for (const line of before) { cursor = after.indexOf(line, cursor); assert.ok(cursor >= 0, `the template keeps "${line}" in order`); }
  const added = after.filter((line) => !before.includes(line) && line.trim() && !/^#{1,6} /u.test(line) && !/^\|(?:---\|)+$/u.test(line) && !/^\| Clause \|/u.test(line));
  assert.ok(added.length >= 4 && added.every((line) => /\bTODO\b/u.test(line)), `every added line is a TODO placeholder:\n${added.join('\n')}`);
  assert.match(fixed, /^## Requirements\n\nTODO: List what the tests must cover\.\n\n- TODO: one observable requirement per line\. \[\{\{work\.id\}\}:REQ-001\]$/mu);
  assert.match(fixed, /^- TODO: one testable criterion per line\. \[\{\{work\.id\}\}:AC-001\]\n\n## Planned implementation evidence\n\n\| Clause \| Expected paths \| Planned tests \| Fulfillment \| Observable result \|$/mu);
  assert.ok(fixed.indexOf('## Planned implementation evidence') < fixed.indexOf('## Out of scope'), 'new sections go before the closing ones');

  // No Requirements or Acceptance criteria section: each is added, the title is not used for one.
  const bare = withClauseAnchors('# {{work.id}} — Payments requirements\n\n## Problem\n\nTODO\n\n## Out of scope\n\nTODO\n');
  assert.deepEqual(bare.added, ['Requirements', 'Acceptance criteria']);
  assert.match(bare.text, /^# \{\{work\.id\}\} — Payments requirements\n\n## Problem\n\nTODO\n\n## Requirements\n\n- TODO: one observable requirement per line\. \[\{\{work\.id\}\}:REQ-001\]\n\n## Acceptance criteria\n\n- TODO/u);

  // A table the kernel refuses (columns out of order) is rebuilt with what its rows had.
  const refused = '# Plan\n\n## Plan\n\n| Clause ID | Planned tests | Expected paths |\n|---|---|---|\n| `{{work.id}}:REQ-001` | `test/a.test.js` | `src/a.js` |\n\nAfter.\n';
  const rebuilt = rebuiltPlannedTable(refused, 5);
  assert.match(rebuilt, /^\| `\{\{work\.id\}\}:REQ-001` \| `src\/a\.js` \| `test\/a\.test\.js` \| new \| TODO: what a person can observe when it works \|$/mu);
  assert.deepEqual(inspectPlannedClaimMap(rebuilt.replaceAll('{{work.id}}', 'CHECK-1'), { clauseIds: ['CHECK-1:REQ-001'] }).diagnostics.filter((entry) => owned.has(entry.field)), []);
  assert.match(rebuilt, /\n\nAfter\.\n$/u);
  assert.match(withStepsColumn(fixed), /^\| Clause \| Expected paths \| Planned tests \| Fulfillment \| Steps \| Observable result \|$/mu);
  assert.deepEqual(kernelReads(withStepsColumn(fixed)).diagnostics, []);

  // Anchors defined twice, or again after an earlier step, are numbered once each.
  assert.deepEqual(templateAnchors(renumberedAnchors('- a [X:REQ-001]\n- b [X:REQ-001]\n`[X:REQ-001]` stays\n', [{ type: 'REQ', number: '001' }])).map((anchor) => anchor.id),
    ['{{work.id}}:REQ-002', '{{work.id}}:REQ-003']);
  assert.deepEqual(withSupportedTokens('{{ work.id }} {{workTitle}} {{story.owner}} {{inputs}}').text, '{{work.id}} {{work.title}} TODO (story.owner) {{inputs}}');
});

test('the fmly-qa-test-automation findings: one change set that leaves nothing to fix, and nothing changes until it is proposed', async () => {
  const root = await fmlyRepository();
  const checked = json(root, ['workflow', 'check', WORKFLOW]);
  assert.deepEqual([checked.counts.problem, checked.counts.warning, checked.counts.note], [2, 5, 1], JSON.stringify(checked.counts));
  const original = await readFile(path.join(root, 'singularity/templates/fmly/requirements.md'), 'utf8');
  const validated = JSON.parse(flow(root, ['workflow', 'validate', WORKFLOW, '--json'], { allowFailure: true }).stdout);
  assert.equal(validated.nextAction.draftCommand, `singularity-flow workflow fix ${WORKFLOW} --write`);
  const result = json(root, ['workflow', 'fix', WORKFLOW, '--write']);
  assert.equal(result.draft.path, validated.fixDraft.changeSetPath, 'the same private draft file /sf-fix-workflow proposes');
  assert.equal(result.resultType, 'workflow-fix');
  assert.equal(result.counts.questions, 0, JSON.stringify(result.questions));
  assert.equal(result.counts.unhandled, 0);
  assert.ok(result.findings.length === 8 && result.findings.every((finding) => finding.resolution === 'change' && /^c-\d+$/u.test(finding.change)), JSON.stringify(result.findings));
  assert.deepEqual(result.changes.map((change) => change.code).sort(),
    ['CHECK_LINK_BROKEN', 'CHECK_STEPS_UNDESCRIBED', 'CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE']);
  assert.deepEqual(result.after.counts, { problem: 0, warning: 0, note: 0 }, JSON.stringify(result.after));
  assert.equal(result.draft.written, true);
  assert.deepEqual(JSON.parse(await readFile(result.draft.path, 'utf8')), result.changeSet);
  assert.equal(result.changeSet.schema, 'sflow-studio-change-set@1');
  assert.ok(result.changeSet.base?.workflowSha256, 'the change set is pinned to the configuration it was drafted against');

  // What was drafted: placeholders in the template, the links mended, the steps described.
  const template = result.changeSet.changes.find((change) => change.op === 'template.update' && change.path === 'fmly/requirements.md');
  assert.equal(result.changeSet.changes.filter((change) => change.op === 'template.update').length, 1, 'two fixes to one template are one change');
  for (const line of template.content.split('\n').filter((entry) => /\[\{\{work\.id\}\}:|^\| `/u.test(entry))) assert.match(line, /\bTODO\b/u, line);
  for (const line of original.split('\n').filter(Boolean)) assert.ok(template.content.includes(line), `the template keeps "${line}"`);
  const skill = result.changeSet.changes.find((change) => change.op === 'skill.update');
  assert.equal(skill.id, 'fmly-e2e-test-generation-source');
  assert.match(skill.instructions, /^Read the page object guide before writing a page object\.$/mu);
  assert.match(skill.instructions, /^Follow selectors and fixtures\.$/mu);
  assert.match(skill.instructions, /^See \[naming\]\(docs\/naming\.md\), data and \[the overview\]\(README\.md\)\.$/mu, 'a file of the same name in the skill folder is linked instead');
  const links = result.changes.find((change) => change.code === 'CHECK_LINK_BROKEN');
  assert.match(links.summary, /references\/naming\.md now points at docs\/naming\.md/u);
  assert.equal(links.findings.length, 5, 'five broken links, one change for their file');
  const described = result.changeSet.changes.filter((change) => change.op === 'phase.update' && change.description);
  assert.deepEqual(described.map((change) => change.id), ['fmly-requirements', 'fmly-code', 'fmly-testing', 'fmly-review']);
  assert.match(described[0].description, /^Writes a document \(artifacts\/fmly-requirements\/requirements\.md\), from the fmly\/requirements\.md template\.$/u);

  // workflow check confirms the written change set; the repository is as it was until a proposal is applied.
  const confirmed = json(root, ['workflow', 'check', WORKFLOW, '--change-set', result.draft.path]);
  assert.deepEqual([confirmed.counts.problem, confirmed.counts.warning, confirmed.counts.note], [0, 0, 0]);
  assert.equal(confirmed.changeSet.valid, true);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
  assert.equal(await readFile(path.join(root, 'singularity/templates/fmly/requirements.md'), 'utf8'), original);

  // The text says the same, with the next commands.
  const text = flow(root, ['workflow', 'fix', WORKFLOW]).stdout;
  assert.match(text, /^fmly-qa-test-automation: 2 problems, 5 warnings, 1 note; 4 changes drafted, 0 questions for a person\.$/mu);
  assert.match(text, /^After these changes: 0 problems, 0 warnings, 0 notes \(checked on a copy; nothing was written\)\.$/mu);
  assert.match(text, /Propose for review: singularity-flow workflow studio apply --change-set .+ --propose$/mu);
});

test('a template whose clause anchors carry a fixed name, as /sf-fix-workflow once wrote [NS:AC-001], is fixed to each Story\'s Work ID [office, 2026-11-12]', async () => {
  const root = await fmlyRepository();
  const file = path.join(root, 'singularity/templates/fmly/requirements.md');
  // What the office's workflow held: guidance naming NS, anchors under NS and the planned-claims row citing one; a
  // library's clause is another namespace's and stays.
  const fixedName = REQUIREMENTS.replace('TODO: List what the tests must cover.\n', '<!-- sflow:guidance Write requirements such as `[NS:REQ-001]`; keep every anchor as `NS:REQ-nnn`. -->\nTODO: List what the tests must cover.\n\n- TODO: one observable requirement per line. [NS:REQ-001]\n')
    .replace('TODO: List how a person knows it works.\n', 'TODO: List how a person knows it works.\n\n- TODO: one testable criterion per line. [NS:AC-001]\n\n<!-- e.g. [NS:AC-009] -->\n\nFollows `CQF:REQ-043` of the code-quality library.\n\n'
      + '## Planned implementation evidence\n\n| Clause | Expected paths | Planned tests | Fulfillment | Observable result |\n|---|---|---|---|---|\n'
      + '| `NS:AC-001` | TODO: path | TODO: test | implemented | TODO: what a person sees |\n');
  await writeFile(file, fixedName);
  run('git', ['commit', '-qam', 'anchors under a fixed name'], root);

  const checked = json(root, ['workflow', 'check', WORKFLOW]);
  const findingsOf = (result) => (result.workflows ?? []).flatMap((entry) => entry.findings ?? []);
  const found = findingsOf(checked).filter((finding) => finding.code === 'CHECK_TEMPLATE_CLAUSE_NAMESPACE');
  assert.equal(found.length, 1, JSON.stringify(findingsOf(checked).map((finding) => finding.code)));
  assert.equal(found[0].severity, 'problem');
  assert.match(found[0].detail, /\[NS:REQ-001\] and 1 more under the name NS/u);
  assert.match(found[0].detail, /instead of its own \(<WORK-ID>:REQ-001\)/u);
  assert.equal(found[0].location.line, fixedName.split('\n').findIndex((line) => line.startsWith('- TODO') && line.includes('[NS:REQ-001]')) + 1,
    'the line that defines it, not the guidance that mentions it');

  const result = json(root, ['workflow', 'fix', WORKFLOW, '--write']);
  const change = result.changes.find((entry) => entry.code === 'CHECK_TEMPLATE_CLAUSE_NAMESPACE');
  assert.match(change.summary, /now opens with \{\{work\.id\}\}/u);
  const template = result.changeSet.changes.find((entry) => entry.op === 'template.update' && entry.path === 'fmly/requirements.md');
  assert.match(template.content, /^- TODO: one observable requirement per line\. \[\{\{work\.id\}\}:REQ-001\]$/mu);
  assert.match(template.content, /^- TODO: one testable criterion per line\. \[\{\{work\.id\}\}:AC-001\]$/mu);
  assert.match(template.content, /^\| `\{\{work\.id\}\}:AC-001` \|/mu, 'the planned row cites the renamed clause');
  assert.match(template.content, /^<!-- sflow:guidance Write requirements such as `\[\{\{work\.id\}\}:REQ-001\]`; keep every anchor as `\{\{work\.id\}\}:REQ-nnn`\. -->$/mu,
    'its guidance no longer teaches the fixed name');
  assert.ok(template.content.includes('<!-- e.g. [{{work.id}}:AC-009] -->'));
  assert.ok(template.content.includes('`CQF:REQ-043`'), 'a citation of another namespace\'s clause stays');
  assert.doesNotMatch(template.content, /\bNS:/u);
  assert.equal(result.after.counts.problem, 0, JSON.stringify(result.after));

  // A workflow that names one namespace for all its Stories is not flagged.
  const config = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  config.workTypes[WORKFLOW].spec = { ...(config.workTypes[WORKFLOW].spec ?? {}), namespace: 'NS' };
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(config));
  run('git', ['commit', '-qam', 'one namespace for the workflow'], root);
  const named = json(root, ['workflow', 'check', WORKFLOW]);
  assert.ok(findingsOf(named).length > 0, 'the check still reads the workflow');
  assert.ok(!findingsOf(named).some((finding) => finding.code === 'CHECK_TEMPLATE_CLAUSE_NAMESPACE'), JSON.stringify(findingsOf(named).map((finding) => finding.code)));
});

test('what only a person can decide is asked, and the answers become changes', async () => {
  const root = await fmlyRepository({ skillLines: ['', 'Always squash commits before merging.', 'Never squash commits.'], security: { autoEnrollNewIdentities: false } });
  const result = json(root, ['workflow', 'fix', WORKFLOW]);
  const people = result.questions.find((question) => question.code === 'CHECK_GROUP_BLOCKED' && /Product approvers/u.test(question.ask));
  assert.ok(people, JSON.stringify(result.questions.map((question) => question.ask)));
  assert.match(people.why, /Who may sign off is the team's decision/u);
  assert.deepEqual(people.choices.map((choice) => [choice.id, choice.needs]), [['people', 'people']]);
  const conflict = result.questions.find((question) => question.code === 'CHECK_GUIDANCE_CONFLICT');
  assert.deepEqual(conflict.choices.map((choice) => choice.id), ['first', 'second', 'keep']);
  assert.ok(result.findings.filter((finding) => finding.code === 'CHECK_GROUP_BLOCKED').every((finding) => finding.resolution === 'question'));

  const answers = path.join(root, '..', `${path.basename(root)}-answers.json`);
  await writeFile(answers, JSON.stringify({ answers: { [people.id]: { choice: 'people', people: ['qa-lead', 'qa.owner@example.com'] }, [conflict.id]: { choice: 'first' } } }));
  const answered = json(root, ['workflow', 'fix', WORKFLOW, '--answers', answers]);
  assert.deepEqual(answered.answered.sort(), [people.id, conflict.id].sort());
  const group = answered.changeSet.changes.find((change) => change.op === 'group.update' && change.id === 'product-approvers');
  assert.deepEqual(group.members, [{ githubLogin: 'qa-lead' }, { email: 'qa.owner@example.com' }]);
  const skill = answered.changeSet.changes.find((change) => change.op === 'skill.update');
  assert.match(skill.instructions, /^Always squash commits before merging\.$/mu);
  assert.doesNotMatch(skill.instructions, /Never squash commits/u);
  assert.ok(!answered.after.findings.some((finding) => finding.code === 'CHECK_GROUP_BLOCKED' && /Product approvers/u.test(finding.title)));
  assert.ok(!answered.questions.some((question) => question.id === people.id));

  await writeFile(answers, JSON.stringify({ answers: { 'q-0000000000': { choice: 'people' } } }));
  const unknown = flow(root, ['workflow', 'fix', WORKFLOW, '--answers', answers, '--json'], { allowFailure: true });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /WORKFLOW_FIX_ANSWER_UNKNOWN|There is no question 'q-0000000000'/u);
  await writeFile(answers, JSON.stringify({ answers: { [people.id]: { choice: 'people' } } }));
  const incomplete = flow(root, ['workflow', 'fix', WORKFLOW, '--answers', answers], { allowFailure: true });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stdout + incomplete.stderr, /needs the people/u);
});

test('a configuration that does not load is fixed first, then what it hid, in rounds of one change set', async () => {
  const root = await fmlyRepository();
  const add = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  await add('.github/agents/idle.agent.md', '---\nname: idle\ndescription: Does nothing.\ntools: [read]\nmetadata:\n  sflow-label: "Idle"\n  sflow-phases: "no-such-step"\n---\n\n# Idle\n\nNothing.\n');
  await add('singularity/skill-library/orphan/SKILL.md', '---\nname: orphan\ndescription: Nobody uses this.\n---\n\nDo the orphan thing.\n');
  await add('singularity/instruction-library/lonely/INSTRUCTIONS.md', '---\nname: lonely\ndescription: Placed nowhere.\n---\n\nBe lonely.\n');
  const file = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8'));
  config.phases['fmly-review'].label = 'Test evidence';
  config.workTypes[WORKFLOW].sourceReview = { phases: ['fmly-review'] };
  await writeFile(file, YAML.stringify(config));
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'more findings'], root);
  assert.equal(json(root, ['workflow', 'check', WORKFLOW]).configuration.valid, false);

  const result = json(root, ['workflow', 'fix', WORKFLOW]);
  assert.ok(result.counts.rounds >= 2, `rounds: ${result.counts.rounds}`);
  const ops = result.changeSet.changes.map((change) => `${change.op} ${change.id ?? change.path ?? ''}`.trim());
  for (const expected of ['agent.remove idle', 'skill.remove orphan', 'instruction.remove lonely', 'template.update fmly/requirements.md', 'skill.update fmly-e2e-test-generation-source']) {
    assert.ok(ops.includes(expected), `${expected} in ${ops.join(', ')}`);
  }
  const review = result.changeSet.changes.find((change) => change.op === 'workflow.update' && change.id === WORKFLOW);
  assert.equal(review.sourceReview, null, 'the superseded review list goes');
  assert.ok(result.changeSet.changes.some((change) => change.op === 'phase.update' && change.label === 'Test evidence (fmly-review)'));
  assert.ok(result.findings.some((finding) => finding.round === 2 && finding.code === 'CHECK_TEMPLATE_CLAUSE_ANCHORS'), 'a finding the broken configuration hid is fixed in a later round');
  assert.equal(result.after.counts.problem, 0, JSON.stringify(result.after));
  assert.deepEqual(result.after.counts, { problem: 0, warning: 0, note: 0 }, JSON.stringify(result.after.findings));

  // Workflow Studio refuses to remove an agent that still drafts steps.
  const refused = json(root, ['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run'],
    { input: JSON.stringify({ schema: 'sflow-studio-change-set@1', changes: [{ op: 'agent.remove', id: 'fmly-delivery' }] }), allowFailure: true });
  assert.equal(refused.valid, false);
  assert.match(refused.problems[0].message, /still drafts/u);
});

test('a workflow.yml a YAML 1.1 writer broke is repaired as text, through configuration save', async () => {
  const root = await fmlyRepository();
  const file = path.join(root, 'singularity/workflow.yml');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/^(\s+signing:) off$/mu, '$1 false').replace(/^(\s+build:) off$/mu, '$1 false'));
  run('git', ['commit', '-am', 'saved by a YAML 1.1 writer'], root);
  assert.equal(json(root, ['workflow', 'check', WORKFLOW]).configuration.valid, false);
  const result = json(root, ['workflow', 'fix', WORKFLOW, '--write']);
  assert.equal(result.changeSet, null, 'Workflow Studio cannot read a configuration that does not load');
  assert.equal(result.configurationFiles.length, 1);
  assert.equal(result.configurationFiles[0].path, 'singularity/workflow.yml');
  assert.equal(result.configurationFiles[0].content, text, 'false is off again, and nothing else changed');
  assert.equal(result.after.configurationLoads, true, JSON.stringify(result.after));
  assert.equal(await readFile(result.configurationFiles[0].written, 'utf8'), text);
  assert.match(result.next[0], /^Propose for review: singularity-flow configuration save singularity\/workflow\.yml --propose < /u);
  assert.notEqual(await readFile(file, 'utf8'), text, 'the repository keeps its file until the proposal is applied');
});

test('a questions-setting finding is fixed from the check\'s own fix data, for one workflow when the step is shared', async () => {
  const root = await fmlyRepository();
  const file = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8'));
  config.phases['fmly-code'].clarification = { mode: 'required', maxQuestions: 3, topics: ['implementation blockers'] };
  config.workTypes['fmly-copy'] = { label: 'QA copy', phases: ['fmly-requirements', 'fmly-code'], phaseOverrides: { 'fmly-code': { inputs: ['fmly-requirements'] } } };
  await writeFile(file, YAML.stringify(config));
  run('git', ['commit', '-am', 'a shared code step that always asks'], root);
  const { fixContext, WORKFLOW_FIXERS } = await import('../src/workflow-fix/index.mjs');
  const { FixDraft } = await import('../src/workflow-fix/draft.mjs');
  const { planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const ctx = await fixContext(root);
  const fresh = () => { ctx.draft = new FixDraft({ configRoot: ctx.configRoot, templatesRoot: ctx.templatesRoot, raw: ctx.raw, agents: ctx.model.agents }); };
  const at = ['phases', 'fmly-code', 'clarification'];
  const data = (extra) => ({ step: 'fmly-code', workflow: WORKFLOW, file: 'singularity/workflow.yml',
    setting: { path: at, line: 1, scope: 'step', sharedWith: ['fmly-copy'], workflowPath: ['workTypes', WORKFLOW, 'phaseOverrides', 'fmly-code', 'clarification'] },
    alternatives: [], question: null, ...extra });
  // The fixer decides: when-needed, for this workflow alone, starting from the step's own setting.
  fresh();
  const finding = { id: 'f-1', code: 'CHECK_CODE_STEP_ALWAYS_ASKS', title: 'Test code stops for a person\'s answer before every change', subject: { workflow: WORKFLOW, step: 'fmly-code' },
    fix: { text: 'Set it to when-needed.', data: data({ decidedBy: 'fixer', edits: [{ path: [...at, 'mode'], line: 1, from: 'required', to: 'when-needed' }] }) } };
  await ctx.draft.record(() => WORKFLOW_FIXERS.CHECK_CODE_STEP_ALWAYS_ASKS.fix([finding], ctx));
  const ops = ctx.draft.studioChanges();
  assert.deepEqual(ops, [{ op: 'phase.update', id: 'fmly-code', workflow: WORKFLOW, clarification: { mode: 'when-needed', maxQuestions: 3, topics: ['implementation blockers'] } }]);
  const plan = await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: ops });
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  const written = plan.files.find((entry) => entry.path === 'singularity/workflow.yml').diff;
  assert.match(written, /^\+ {8}clarification:\n\+ {10}mode: when-needed$/mu, 'the override is this workflow\'s own');
  assert.doesNotMatch(written, /^-.*mode: required/mu, 'the step\'s own setting, which QA copy uses, stays');
  // A second finding on the same step in the same round waits for the next round's check.
  await ctx.draft.record(() => WORKFLOW_FIXERS.CHECK_QUESTIONS_SETTLED_BY_SCOPE.fix([{ ...finding, code: 'CHECK_QUESTIONS_SETTLED_BY_SCOPE',
    fix: { data: data({ decidedBy: 'fixer', edits: [{ path: [...at, 'topics'], to: ['approved deviations'] }] }) } }], ctx));
  assert.equal(ctx.draft.studioChanges().length, 1);
  // A person decides: the question and its choices are the check's own.
  fresh();
  const { value } = await ctx.draft.record(() => WORKFLOW_FIXERS.CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED.fix([{ ...finding, code: 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED',
    fix: { data: data({ decidedBy: 'person', edits: [], question: { text: 'Should Test code always confirm its reading first?',
      choices: [{ id: 'required', label: 'Yes', edits: [{ path: [...at, 'mode'], to: 'required' }] }, { id: 'when-needed', label: 'No', edits: [] }] } }) } }], ctx));
  assert.equal(ctx.draft.studioChanges().length, 0, 'nothing changes until a person answers');
  const [question] = value.questions;
  assert.equal(question.ask, 'Should Test code always confirm its reading first?');
  assert.deepEqual(question.choices.map((choice) => choice.id), ['required', 'when-needed']);
  assert.match(question.why, /team's choice/u);
  question.choices[0].apply(ctx.draft, {});
  assert.equal(ctx.draft.studioChanges()[0].clarification.mode, 'required');
});

test('every fixer runs on a finding of its code, and every question it asks has choices and says why', async () => {
  const root = await fmlyRepository();
  const { fixContext, WORKFLOW_FIXERS, CONFIGURATION_FIXER } = await import('../src/workflow-fix/index.mjs');
  const { FixDraft } = await import('../src/workflow-fix/draft.mjs');
  const { checkWorkflowConfiguration } = await import('../src/workflow-check.mjs');
  const ctx = await fixContext(root);
  ctx.check = await checkWorkflowConfiguration(root, { workflows: [WORKFLOW] });
  const subject = { workflow: WORKFLOW, step: 'fmly-code', group: 'product-approvers', skill: 'fmly-e2e-test-generation-source', agent: 'fmly-delivery',
    instruction: 'none', file: 'singularity/skill-library/fmly-e2e-test-generation-source/SKILL.md', template: 'fmly/requirements.md' };
  for (const [code, entry] of [...Object.entries(WORKFLOW_FIXERS), ['YAML_BAD_INDENT', CONFIGURATION_FIXER]]) {
    ctx.draft = new FixDraft({ configRoot: ctx.configRoot, templatesRoot: ctx.templatesRoot, raw: ctx.raw, agents: ctx.model.agents });
    const finding = { id: 'f-000000000001', code, severity: 'problem', title: `A ${code} finding`, detail: `Something about ${code}.`, subject,
      location: { file: 'singularity/workflow.yml', line: 3 }, fix: { text: 'Fix it.' } };
    const { value } = await ctx.draft.record(() => entry.fix([finding], ctx));
    for (const question of value?.questions ?? []) {
      assert.ok(question.ask && question.why && question.choices.length, `${code}: ${JSON.stringify(question)}`);
      assert.ok(question.choices.every((choice) => choice.id && choice.label && typeof choice.apply === 'function'), `${code}: every choice applies`);
    }
  }
});

test('workflow fix is a read that never crosses the model boundary', async () => {
  const { resolveOperation } = await import('../src/command-registry.mjs');
  for (const options of [{}, { write: true }, { answers: '-' }]) {
    const operation = resolveOperation({ requestedCommand: 'workflow', positionals: ['workflow', 'fix'], options });
    assert.deepEqual([operation.id, operation.classification, operation.modelPolicy], ['workflow.fix', 'read', 'never']);
  }
  const { HELP } = await import('../src/help-text.mjs');
  assert.match(HELP, /workflow fix \[WORKFLOW\] \[--answers FILE\|-\] \[--write\] \[--json\]/u);
});
