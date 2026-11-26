/**
 * `workflow from-agent <FOLDER | MARKETPLACE/AGENT> [--answer STEP=INTENT]... [--out BUNDLE.json | --propose] [--json]`:
 * an agent of a Git repository marketplace (marketplace add --repo) as an SFlow workflow, every step with what it is
 * for (src/agent-workflow.mjs), or an agent folder on this computer (src/agent-folder.mjs), with the steps SFlow needs
 * that the agent has no stage for added (src/workflow-needs.mjs), compiled into a portable workflow bundle (src/agent-workflow-bundle.mjs).
 *
 * - Without --out or --propose it changes nothing: it shows the steps, why each is what it is, the questions the
 *   person answers at the first step, what each step's intent gives it, and the version 4 workflow it writes.
 * - --out writes the bundle; `workflow import` brings it into a repository through its own review.
 * - --propose writes the bundle to SFlow's private folder and shows its import as a configuration proposal, with the
 *   one command that makes it: the person confirms the import, and a person activates the proposal.
 * - A stage SFlow cannot classify is asked about once, with 2 to 4 choices, each a whole command with --answer.
 * - --review shows the conversion review (src/conversion-review.mjs, MCR §4) in place of the plain listing: where it came
 *   from, each stage and the step it became, what SFlow changed, what needs an answer, the checks, and the feedback for
 *   the marketplace. --json always carries it as `review`, with its `feedbackDocument` when the marketplace owns a finding.
 * - --feedback FILE writes that feedback as Markdown (MCR §6) and names the new-issue page that takes it, which the person
 *   opens and submits; SFlow never posts it.
 * - --update (MCR §8) converts the agent at its marketplace's newest commit with the answers its import recorded, and the
 *   review shows only what changed since that import; a stage whose own words changed is asked again. With --propose
 *   its import is reviewed like any other. A workflow imported before its source was recorded is compared with the
 *   marketplace's pinned commit, and making it records its source.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { commandLineFile, optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['answer', 'out', 'propose', 'json', 'review', 'feedback', 'update']);
const TARGET = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9][a-z0-9._-]{0,99})$/u;

function usage(message, details = undefined) {
  return new SingularityFlowError(message, { code: 'WORKFLOW_FROM_AGENT_USAGE', ...(details ? { details } : {}) });
}

function parseAnswers(values) {
  const answers = {};
  for (const value of values) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)=([a-z]+)$/u.exec(String(value).trim());
    if (!match) throw usage(`--answer takes STEP=INTENT, for example --answer product-hand-off=report: '${value}'.`);
    answers[match[1]] = match[2];
  }
  return answers;
}

const quoted = (value) => (/^[\w./:@%+=-]+$/u.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`);
const command = (argv) => argv.map(quoted).join(' ');

/** The person's whole command again, with `answers` and the same output choice. */
function again(target, answers, { out = null, propose = false } = {}) {
  return command(['singularity-flow', 'workflow', 'from-agent', target, ...Object.entries(answers).flatMap(([step, intent]) => ['--answer', `${step}=${intent}`]),
    ...(out ? ['--out', out] : []), ...(propose ? ['--propose'] : [])]);
}

/** Each choice of the first open stage as a whole command. */
function questionRoutes(conversion, target, answers, output) {
  const first = conversion.open[0];
  return first ? first.choices.map((choice) => ({ label: choice.label, command: again(target, { ...answers, [first.step]: choice.intent }, output) })) : [];
}

function printConversion(conversion) {
  const { source } = conversion;
  console.log(`${conversion.workflow.label}: a workflow from ${source.agent}${source.version ? ` ${source.version}` : ''}`
    + (source.marketplace ? ` in marketplace ${source.marketplace} (commit ${String(source.commit ?? '').slice(0, 12)})` : ` in folder ${source.folder}`)
    + `${source.lifecycleRecord?.word ?? source.lifecycleState ? `, ${source.lifecycleRecord?.word ?? source.lifecycleState}` : ''}${source.owner?.name ? `, owned by ${source.owner.name}` : ''}.`);
  if (conversion.questions.length) {
    console.log(`The person answers at ${conversion.steps[0].label}, before any work:`);
    for (const question of conversion.questions) console.log(`  ${question.topic}`);
    const value = conversion.storyValue;
    if (value) {
      console.log(`  The answer is the Story value ${value.name}, recorded when ${conversion.steps[0].label} is submitted (--decision ${value.name}=<${value.values.join('|')}>);`
        + ' each later step is given only the skills for that answer.');
    }
  }
  console.log('Steps, each with what it is for:');
  conversion.steps.forEach((step, index) => {
    console.log(step.addedBySflow ? `  ${index + 1}. ${step.label}  ${step.intent}, added by SFlow: ${step.why}`
      : `  ${index + 1}. ${step.label}  ${step.intent ?? 'not known yet'}${step.intent ? `, ${step.confidence}` : ''}: ${step.why}`);
    if (step.folded.length) console.log(`       It also runs ${step.folded.map((entry) => `stage ${entry.number}, ${entry.title}`).join(' and ')}, when needed.`);
    if (step.personApproval) {
      console.log(`       A person approves it: the agent's ${step.personApproval.gate} gate${step.personApproval.derived ? ` (${step.personApproval.derived})` : ' (kept with its reason)'}.`);
    }
    if (step.skills.length) console.log(`       Skills: ${step.skills.map((entry) => `${entry.skill}${entry.use ? ` ${entry.use}` : ''}`).join('; ')}`);
  });
  for (const note of conversion.notes) console.log(`Note: ${note}`);
}

function printQuestions(conversion, routes) {
  const count = conversion.open.length;
  console.log(`SFlow cannot tell what ${count === 1 ? '1 stage is' : `${count} stages are`} for: ${conversion.open.map((entry) => entry.stage).join(', ')}.`);
  const first = conversion.open[0];
  console.log(`${first.question} (step ${first.step}; ${first.why})`);
  for (const route of routes) {
    console.log(`  ${route.label}`);
    console.log(`    ${route.command}`);
  }
  if (count > 1) console.log('Then SFlow asks about the next one.');
}

function printDerived(resolved, walk = null) {
  if (walk && !walk.stops.length) console.log(`Walked with no Story: ${walk.paths} path(s) and ${walk.routes} route(s) on ${walk.hosts.join(' and ')}, no loop and no stop.`);
  for (const stop of walk?.stops ?? []) console.log(`Stop: ${stop.title}\n  Why: ${stop.detail}\n  Fix: ${stop.fix.text}`);
  console.log('What each step\'s intent gives it:');
  for (const step of resolved) {
    const parts = [
      step.kind, step.changesSource ? 'changes code' : 'changes no code',
      step.approval === 'person' ? 'a person approves it' : step.approval === 'none' ? 'no approval' : 'SFlow approves it when clean',
      `questions ${step.questions}`,
      ...(step.repositoryTests === 'run' ? ['runs the repository\'s tests'] : []),
      ...(step.testEvidenceFrom ? [`cites ${step.testEvidenceFrom}'s test results`] : []),
      ...(step.reads.length ? [`reads ${step.reads.join(', ')}`] : [])
    ];
    console.log(`  ${step.step}: ${parts.join(' · ')}`);
  }
}

/**
 * An update (MCR §8): the record the workflow's import wrote, the agent at that commit (or, with no record, at the
 * marketplace's pinned commit), the answers to keep, and `summary(conversion)`, what changed for the review.
 */
async function updateOf(root, marketplace, agentName, newest, given, withApprovedConfigurationRead) {
  const [{ loadImportsLedger }, { configurationReadRoot }, { readMarketplaceAgent }, { convertAgent, parseAgentDocument },
    { piecesDifferences, differencesWords, sourcePieces }, { lineChanges }] = await Promise.all([
    import('../imports-ledger.mjs'), import('../configuration-read-scope.mjs'), import('../marketplace-repository.mjs'), import('../agent-workflow.mjs'),
    import('../agent-workflow-provenance.mjs'), import('../conversion-review.mjs')]);
  const ledger = await withApprovedConfigurationRead(root, () => loadImportsLedger(configurationReadRoot(root)), { preferAuthority: true }).catch(() => ({ imports: {} }));
  const record = Object.values(ledger.imports ?? {}).find((entry) => entry?.kind === 'workflow' && entry.source?.kind === 'marketplace-agent'
    && entry.source.marketplace === marketplace.id && entry.source.agent === agentName) ?? null;
  const from = record?.source.commit ?? marketplace.commit ?? null;
  const previous = from ? await readMarketplaceAgent({ ...marketplace, commit: from }, agentName).catch(() => null) : null;
  const recorded = { ...(record?.source.answers ?? {}) };
  // A recorded answer stands only for a stage whose own words did not change; the person is asked again about the rest.
  const stagesOf = (text) => new Map(parseAgentDocument(text).stages.map((stage) => [stage.title, `${stage.title}\n${stage.body ?? ''}`.trim()]));
  const before = previous ? stagesOf(previous.agent.text) : new Map();
  const after = stagesOf(newest.agent.text);
  const earlier = previous ? convertAgent({ marketplace: { ...marketplace, commit: from }, agent: previous.agent, skills: previous.skills, answers: {} }) : null;
  const titleOf = new Map((earlier?.steps ?? []).map((step) => [step.id, step.label]));
  const current = new Set(convertAgent({ marketplace: { ...marketplace, commit: newest.listing.commit }, agent: newest.agent, skills: newest.skills, answers: {} }).steps.map((step) => step.id));
  const dropped = Object.keys(recorded).filter((step) => !current.has(step) || !titleOf.has(step) || before.get(titleOf.get(step)) !== after.get(titleOf.get(step)));
  for (const step of dropped) delete recorded[step];
  const answers = { ...recorded, ...given };
  const summary = (conversion) => {
    const was = record?.pieces ?? (previous ? sourcePieces(previous.agent, previous.skills) : null);
    const difference = was ? piecesDifferences(was, sourcePieces(newest.agent, newest.skills)) : null;
    const previousConversion = previous ? convertAgent({ marketplace: { ...marketplace, commit: from }, agent: previous.agent, skills: previous.skills, answers: record?.source.answers ?? {} }) : null;
    const stepsBefore = new Map((previousConversion?.steps ?? []).map((step) => [step.id, step]));
    const stepsAfter = new Map(conversion.steps.map((step) => [step.id, step]));
    const findingKey = (entry) => `${entry.class}\u0000${entry.words}`;
    const findingsBefore = new Set((previousConversion?.findings ?? []).map(findingKey));
    const findingsAfter = new Set(conversion.findings.map(findingKey));
    const skillText = (read, name) => read?.skills.find((entry) => entry.name === name)?.text ?? '';
    const skills = difference ? [...difference.skills.changed, ...difference.skills.added, ...difference.skills.removed]
      .map((name) => ({ skill: name, change: difference.skills.added.includes(name) ? 'added' : difference.skills.removed.includes(name) ? 'removed' : 'changed',
        lines: lineChanges(skillText(previous, name), skillText(newest, name)) })) : [];
    const steps = {
      added: [...stepsAfter.keys()].filter((id) => !stepsBefore.has(id)),
      removed: [...stepsBefore.keys()].filter((id) => !stepsAfter.has(id)),
      reclassified: [...stepsAfter.values()].filter((step) => stepsBefore.has(step.id) && stepsBefore.get(step.id).intent && step.intent && stepsBefore.get(step.id).intent !== step.intent)
        .map((step) => ({ step: step.id, from: stepsBefore.get(step.id).intent, to: step.intent }))
    };
    const nothing = Boolean(difference?.unchanged) && !steps.added.length && !steps.removed.length && !steps.reclassified.length;
    return {
      recorded: Boolean(record), from, to: newest.listing.commit, version: { from: record?.source.version ?? previous?.agent.version ?? null, to: newest.agent.version ?? null },
      read: Boolean(previous), words: difference ? differencesWords(difference) : 'what it was imported from could not be read',
      difference, agent: previous && difference?.agent ? lineChanges(previous.agent.text, newest.agent.text) : [], skills, steps,
      findings: { added: conversion.findings.filter((entry) => !findingsBefore.has(findingKey(entry))).map((entry) => entry.words),
        resolved: (previousConversion?.findings ?? []).filter((entry) => !findingsAfter.has(findingKey(entry))).map((entry) => entry.words) },
      askedAgain: dropped.filter((step) => step in (record?.source.answers ?? {})), nothingChanged: nothing
    };
  };
  return { answers, summary };
}

/** Problems reading the agent's source, each a finding the marketplace (or the folder's owner) fixes. */
function sourceProblems(conversion, problems) {
  for (const problem of problems ?? []) {
    const words = String(problem);
    conversion.findings.push({ id: `F${String(conversion.findings.length + 1).padStart(2, '0')}`, class: 'marketplace-metadata', owner: 'marketplace', words,
      fix: 'Correct it where the agent is kept, as the sentence says.' });
    conversion.notes.push(words);
  }
}

/** Where --propose keeps the bundle: SFlow's private folder beside the workflow builds, one file per bundle. */
async function privateBundlePath(bundle, workflowId, env = process.env) {
  const { workflowBuildStateRoot } = await import('../workflow-build/store.mjs');
  // One folder per bundle, so the file a person sees (the import review's title) is named after the workflow alone.
  const directory = path.join(path.dirname(workflowBuildStateRoot(env)), 'marketplace-workflows', String(bundle.bundleSha256).replace(/^sha256:/u, ''));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${workflowId}.workflow.json`);
}

export async function run(argv, { positionals, options }) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key));
  if (unknown.length) throw usage(`workflow from-agent does not take --${unknown[0]}.`);
  const target = String(positionals[2] ?? '');
  const { isAgentFolder, readAgentFolder } = await import('../agent-folder.mjs');
  // An agent folder on this computer, read as it is; else MARKETPLACE/AGENT [owner, 2026-11-22].
  const folder = positionals.length === 3 && await isAgentFolder(target);
  const match = folder ? null : TARGET.exec(target);
  if ((!folder && !match) || positionals.length > 3) {
    throw usage('Name one agent: its folder on this computer (the one holding agent.md), or MARKETPLACE/AGENT. singularity-flow marketplace browse lists each marketplace agent with its command.',
      { nextAction: 'singularity-flow marketplace list' });
  }
  const out = optionString(options, 'out') ?? null;
  const propose = optionBoolean(options, 'propose');
  if (out && propose) throw usage('Write the bundle (--out FILE) or show its import as a proposal (--propose), not both.');
  const json = optionBoolean(options, 'json');
  let answers = parseAnswers(optionStrings(options, 'answer'));
  const update = optionBoolean(options, 'update');
  if (update && folder) throw usage('--update reads a marketplace agent at its newest commit: name it as MARKETPLACE/AGENT.');
  const [{ repoRoot }, { withApprovedConfigurationRead }, { configuredMarketplaces, requireMarketplace }, { readMarketplaceAgent }, { convertAgent }] = await Promise.all([
    import('../git.mjs'), import('../approved-configuration-reader.mjs'), import('../marketplace.mjs'), import('../marketplace-repository.mjs'), import('../agent-workflow.mjs')
  ]);
  const root = repoRoot();
  let conversion; let agent; let skills; let updated = null;
  if (folder) {
    const read = await readAgentFolder(target);
    ({ agent, skills } = read);
    conversion = convertAgent({ marketplace: null, folder: read.folder, agent, skills, answers });
    sourceProblems(conversion, read.problems);
  } else {
  const marketplace = requireMarketplace(await withApprovedConfigurationRead(root, () => configuredMarketplaces(root), { preferAuthority: true }), match[1]);
  if (!marketplace.repository) {
    throw usage(`Marketplace '${marketplace.id}' is an index of files. An agent becomes a workflow from a marketplace that is a Git repository: add that one with marketplace add --repo.`,
      { nextAction: 'singularity-flow marketplace list' });
  }
  const read = await readMarketplaceAgent(update ? { ...marketplace, commit: null } : marketplace, match[2]);
  ({ agent, skills } = read);
  if (update) {
    updated = await updateOf(root, marketplace, match[2], read, answers, withApprovedConfigurationRead);
    answers = updated.answers;
  }
  conversion = convertAgent({ marketplace: { ...marketplace, commit: read.listing.commit }, agent, skills, answers });
  if (updated) {
    conversion.update = updated.summary(conversion);
    // Its import moves the commit this repository trusts to the one read now (workflow-transfer.mjs trust).
    if (marketplace.commit !== read.listing.commit) conversion.update.trusts = { marketplace: marketplace.id, from: marketplace.commit ?? null, to: read.listing.commit };
  }
  // What the marketplace's own listing says is wrong with this agent or the skills it uses.
  const own = [agent.name, ...skills.map((entry) => entry.name)];
  sourceProblems(conversion, (read.listing.problems ?? []).filter((problem) => own.some((name) => String(problem).startsWith(`${name}:`) || String(problem).startsWith(`${name} `))));
  }
  const { conversionReview, conversionReviewMarkdown, feedbackDocument } = await import('../conversion-review.mjs');
  // The review as data and as the Markdown a Copilot turn shows as written (MCR §9).
  const withMarkdown = (value) => ({ ...value, markdown: conversionReviewMarkdown(value, { forPerson: true }) });
  const reviewed = (extra = {}) => {
    const value = conversionReview({ ...conversion, ...extra });
    const document = feedbackDocument(value);
    return withMarkdown(document ? { ...value, feedbackDocument: document } : value);
  };
  const review = optionBoolean(options, 'review');
  const feedback = optionString(options, 'feedback') ?? null;
  if (feedback) {
    if (out || propose) throw usage('Write the feedback (--feedback FILE) on its own, not with --out or --propose.');
    const { conversionFeedbackMarkdown } = await import('../conversion-review.mjs');
    const value = reviewed();
    const { writeText } = await import('../util.mjs');
    const file = commandLineFile(root, feedback);
    await writeText(file, value.feedbackDocument?.markdown ?? conversionFeedbackMarkdown(value));
    const issue = value.feedbackDocument?.issue ?? null;
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-conversion-feedback', feedbackPath: file, findings: value.feedback.length, issue }, null, 2));
    console.log(`Wrote the feedback for the marketplace to ${file}: ${value.feedback.length ? `${value.feedback.length} finding${value.feedback.length === 1 ? '' : 's'}` : 'nothing to fix'}.`);
    if (issue) console.log(`Open an issue with it${issue.bodyInUrl ? ', filled in' : ' (paste the file into it)'}; you submit it: ${issue.url}`);
    return;
  }
  const output = { out, propose };

  if (!conversion.ready) {
    const routes = questionRoutes(conversion, target, answers, output);
    if (json) console.log(JSON.stringify({ ...conversion, routes, review: reviewed() }, null, 2));
    else if (review) { process.stdout.write(conversionReviewMarkdown(reviewed())); printQuestions(conversion, routes); }
    else { printConversion(conversion); printQuestions(conversion, routes); }
    if (out || propose) {
      throw new SingularityFlowError(`Nothing was written: SFlow asks what ${conversion.open[0].stage} is for. Answer with one of the commands above.`, {
        code: 'AGENT_WORKFLOW_QUESTION_OPEN', details: { open: conversion.open, routes, nextAction: routes[0]?.command ?? null }
      });
    }
    return;
  }

  const { compileAgentWorkflow } = await import('../agent-workflow-bundle.mjs');
  const compiled = await compileAgentWorkflow(conversion, { agentText: agent.text, skillTexts: new Map(skills.map((entry) => [entry.name, entry.text])),
    provenance: { agent, skills, answers } });
  const { writeWorkflowBundle, readWorkflowBundle } = await import('../workflow-transfer.mjs');
  const result = { ...conversion, bundleSha256: compiled.bundle.bundleSha256, workflowYaml: compiled.workflowYaml, derived: compiled.resolved, walk: compiled.walk };
  result.review = (() => { const value = conversionReview(result); const document = feedbackDocument(value); return withMarkdown(document ? { ...value, feedbackDocument: document } : value); })();

  // A Story of it would loop or stop: the preview shows each stop and its fix, and nothing is written.
  if ((out || propose) && compiled.walk.stops.length) {
    const preview = again(target, answers);
    throw new SingularityFlowError(`Nothing was written: a Story of ${conversion.workflow.label} would ${compiled.walk.stops.some((stop) => stop.class === 'loop') ? 'loop' : 'stop'} on its way.\n`
      + `${compiled.walk.stops.map((stop) => `- ${stop.title}\n  Fix: ${stop.fix.text}`).join('\n')}\nThe preview shows each stop with its steps and the --answer choices that change them.`, {
      code: 'AGENT_WORKFLOW_WALK_STOPPED', details: { stops: compiled.walk.stops, nextAction: { label: 'Preview the workflow and its stops', command: preview } } });
  }
  if (!out && !propose) {
    const suggested = `${conversion.workflow.id}.workflow.json`;
    const next = [{ label: 'Write it as a workflow bundle', command: again(target, answers, { out: suggested }) },
      { label: 'Show its import as a configuration proposal', command: again(target, answers, { propose: true }) }];
    if (json) return console.log(JSON.stringify({ ...result, next }, null, 2));
    if (review) {
      process.stdout.write(conversionReviewMarkdown(result.review));
      console.log('Nothing was written. Next:');
      for (const route of next) console.log(`  ${route.label}: ${route.command}`);
      return;
    }
    printConversion(conversion);
    printDerived(compiled.resolved, compiled.walk);
    console.log('The version 4 workflow it writes (singularity/workflow.yml):');
    for (const line of compiled.workflowYaml.trimEnd().split('\n')) console.log(`  ${line}`);
    console.log('Nothing was written. Next:');
    for (const route of next) console.log(`  ${route.label}: ${route.command}`);
    return;
  }

  if (out) {
    const written = await writeWorkflowBundle(compiled.bundle, commandLineFile(root, out));
    const reread = await readWorkflowBundle(written);
    const importCommand = command(['singularity-flow', 'workflow', 'import', written, '--dry-run', '--propose']);
    if (json) return console.log(JSON.stringify({ ...result, outputPath: written, bundleSha256: reread.bundleSha256, next: [{ label: 'Preview its import', command: importCommand }] }, null, 2));
    printConversion(conversion);
    printDerived(compiled.resolved, compiled.walk);
    console.log(`Wrote the workflow bundle ${written}.`);
    console.log(`Next, preview its import as a configuration proposal: ${importCommand}`);
    return;
  }

  // --propose: the bundle in SFlow's private folder, and its import previewed as a configuration proposal.
  const file = await privateBundlePath(compiled.bundle, conversion.workflow.id);
  const existing = await readFile(file).then(() => readWorkflowBundle(file), () => null);
  if (!existing) await writeWorkflowBundle(compiled.bundle, file);
  else if (existing.bundleSha256 !== compiled.bundle.bundleSha256) throw usage(`${file} holds another bundle; remove it, then run the same command again.`);
  if (json) {
    const [{ planWorkflowImport }] = await Promise.all([import('../workflow-transfer.mjs')]);
    const plan = await withApprovedConfigurationRead(root, () => planWorkflowImport(root, compiled.bundle, {}), { preferAuthority: true });
    return console.log(JSON.stringify({ ...result, bundlePath: file, importPlan: plan }, null, 2));
  }
  printConversion(conversion);
  printDerived(compiled.resolved, compiled.walk);
  console.log(`The workflow bundle is ${file}. Its import as a configuration proposal:`);
  await (await import('./legacy.mjs')).run(['workflow', 'import', file, '--dry-run', '--propose']);
}
