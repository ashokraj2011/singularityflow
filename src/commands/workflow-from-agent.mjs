/**
 * `workflow from-agent <MARKETPLACE>/<AGENT> [--answer STEP=INTENT]... [--out BUNDLE.json | --propose] [--json]`:
 * an agent of a Git repository marketplace (marketplace add --repo) as an SFlow workflow, every step with what it is
 * for (src/agent-workflow.mjs), compiled into a portable workflow bundle (src/agent-workflow-bundle.mjs).
 *
 * - Without --out or --propose it changes nothing: it shows the steps, why each is what it is, the questions the
 *   person answers at the first step, what each step's intent gives it, and the version 4 workflow it writes.
 * - --out writes the bundle; `workflow import` brings it into a repository through its own review.
 * - --propose writes the bundle to SFlow's private folder and shows its import as a configuration proposal, with the
 *   one command that makes it: the person confirms the import, and a person activates the proposal.
 * - A stage SFlow cannot classify is asked about once, with 2 to 4 choices, each a whole command with --answer.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { commandLineFile, optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['answer', 'out', 'propose', 'json']);
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
  console.log(`${conversion.workflow.label}: a workflow from ${source.agent}${source.version ? ` ${source.version}` : ''} in marketplace ${source.marketplace}`
    + ` (commit ${String(source.commit ?? '').slice(0, 12)})${source.lifecycleState ? `, ${source.lifecycleState}` : ''}.`);
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
    console.log(`  ${index + 1}. ${step.label}  ${step.intent ?? 'not known yet'}${step.intent ? `, ${step.confidence}` : ''}: ${step.why}`);
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

/** Where --propose keeps the bundle: SFlow's private folder beside the workflow builds, one file per bundle. */
async function privateBundlePath(bundle, workflowId, env = process.env) {
  const { workflowBuildStateRoot } = await import('../workflow-build/store.mjs');
  const directory = path.join(path.dirname(workflowBuildStateRoot(env)), 'marketplace-workflows');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${workflowId}-${String(bundle.bundleSha256).replace(/^sha256:/u, '').slice(0, 12)}.json`);
}

export async function run(argv, { positionals, options }) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key));
  if (unknown.length) throw usage(`workflow from-agent does not take --${unknown[0]}.`);
  const target = String(positionals[2] ?? '');
  const match = TARGET.exec(target);
  if (!match || positionals.length > 3) {
    throw usage('Name one agent as MARKETPLACE/AGENT. singularity-flow marketplace browse lists each agent with its command.', { nextAction: 'singularity-flow marketplace list' });
  }
  const out = optionString(options, 'out') ?? null;
  const propose = optionBoolean(options, 'propose');
  if (out && propose) throw usage('Write the bundle (--out FILE) or show its import as a proposal (--propose), not both.');
  const json = optionBoolean(options, 'json');
  const answers = parseAnswers(optionStrings(options, 'answer'));
  const [{ repoRoot }, { withApprovedConfigurationRead }, { configuredMarketplaces, requireMarketplace }, { readMarketplaceAgent }, { convertAgent }] = await Promise.all([
    import('../git.mjs'), import('../approved-configuration-reader.mjs'), import('../marketplace.mjs'), import('../marketplace-repository.mjs'), import('../agent-workflow.mjs')
  ]);
  const root = repoRoot();
  const marketplace = requireMarketplace(await withApprovedConfigurationRead(root, () => configuredMarketplaces(root), { preferAuthority: true }), match[1]);
  if (!marketplace.repository) {
    throw usage(`Marketplace '${marketplace.id}' is an index of files. An agent becomes a workflow from a marketplace that is a Git repository: add that one with marketplace add --repo.`,
      { nextAction: 'singularity-flow marketplace list' });
  }
  const { listing, agent, skills } = await readMarketplaceAgent(marketplace, match[2]);
  const conversion = convertAgent({ marketplace: { ...marketplace, commit: listing.commit }, agent, skills, answers });
  const output = { out, propose };

  if (!conversion.ready) {
    const routes = questionRoutes(conversion, target, answers, output);
    if (json) console.log(JSON.stringify({ ...conversion, routes }, null, 2));
    else { printConversion(conversion); printQuestions(conversion, routes); }
    if (out || propose) {
      throw new SingularityFlowError(`Nothing was written: SFlow asks what ${conversion.open[0].stage} is for. Answer with one of the commands above.`, {
        code: 'AGENT_WORKFLOW_QUESTION_OPEN', details: { open: conversion.open, routes, nextAction: routes[0]?.command ?? null }
      });
    }
    return;
  }

  const { compileAgentWorkflow } = await import('../agent-workflow-bundle.mjs');
  const compiled = await compileAgentWorkflow(conversion, { agentText: agent.text, skillTexts: new Map(skills.map((entry) => [entry.name, entry.text])) });
  const { writeWorkflowBundle, readWorkflowBundle } = await import('../workflow-transfer.mjs');
  const result = { ...conversion, bundleSha256: compiled.bundle.bundleSha256, workflowYaml: compiled.workflowYaml, derived: compiled.resolved, walk: compiled.walk };

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
