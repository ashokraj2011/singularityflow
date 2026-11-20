/**
 * `workflow check [WORKFLOW] [--change-set FILE|-] [--json]` — explain each workflow in plain words
 * and list, with where to look, what does not make sense in it (src/workflow-check.mjs). Read-only:
 * with a Studio change set it checks the configuration as that change set would leave it, without
 * writing anything.
 *
 * It also says what each step is for and how sure SFlow is (step intents), and, without a change set, what kind
 * of software each project in the repository is (src/software-kinds.mjs). Both are reports: nothing uses them yet.
 */
import { readFile } from 'node:fs/promises';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString } from '../util.mjs';

const SEVERITY_WORDS = { problem: 'problem', warning: 'warning', note: 'note' };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const countWords = (counts) => ['problem', 'warning', 'note'].map((severity) => plural(counts[severity] ?? 0, severity)).join(', ');
const countsOf = (findings) => Object.fromEntries(['problem', 'warning', 'note'].map((severity) => [severity, findings.filter((entry) => entry.severity === severity).length]));
const where = (location) => (location ? `  (${location.file}${location.line ? `:${location.line}` : ''})` : '');

/** A finding's text; a fix that shows a table keeps its lines under the first. */
const block = (text, indent) => String(text).split('\n').join(`\n${indent}`);

function printFindings(findings, indent) {
  for (const entry of findings) {
    console.log(`${indent}${SEVERITY_WORDS[entry.severity].padEnd(8)} ${entry.title}${where(entry.location)}`);
    if (entry.detail && entry.detail !== entry.title) console.log(`${indent}         ${block(entry.detail, `${indent}         `)}`);
    if (entry.fix) console.log(`${indent}         Fix: ${block(entry.fix.text, `${indent}              `)}`);
  }
}

const SURE_WORDS = { certain: 'sure', likely: 'likely', unclear: 'not sure' };

/** One step's intent as a person reads it: "test (SFlow is sure: its output kind is test-evidence)". */
function intentWords(entry) {
  const reason = entry.source === 'declared' ? 'workflow.yml says so' : `${entry.confidence === 'certain' ? 'SFlow is sure' : SURE_WORDS[entry.confidence]}: ${entry.why}`;
  const differs = entry.inferred ? `; its settings look like ${entry.inferred.intent} (${entry.inferred.why})` : '';
  return `${entry.intent} (${reason}${differs})`;
}

/** Every step's intent on one line; a step SFlow is not sure about says so. */
function intentsLine(workflow) {
  const labels = new Map(workflow.explanation.steps.map((step) => [step.id, step.label]));
  return (workflow.intents ?? []).map((entry) => `${labels.get(entry.step) ?? entry.step}: ${entry.intent}${entry.confidence === 'certain' ? '' : ` (${SURE_WORDS[entry.confidence]})`}`).join(', ');
}

function printSoftware(software) {
  if (!software) return;
  if (software.unavailable) {
    console.log(`What kind of software this is: SFlow could not read the repository's files (${software.unavailable}).`);
    return;
  }
  console.log('What kind of software this is, from its files (nothing depends on it yet):');
  for (const project of software.projects) {
    const name = project.root ? `${project.name ?? project.id} (${project.root})` : 'This repository';
    const kind = project.kind ? `${project.kind}${project.confidence === 'certain' ? '' : ` (${SURE_WORDS[project.confidence]})`}` : 'cannot tell';
    const signals = project.signals.length ? `: ${project.signals.join('; ')}` : '';
    const also = project.also.length ? `. Also looks like ${project.also.join(', ')}` : '';
    console.log(`  ${name}: ${kind}${signals}${also}.`);
  }
  for (const note of software.notes ?? []) console.log(`  ${note}`);
}

function printSteps(explanation, intents = []) {
  const forStep = new Map(intents.map((entry) => [entry.step, entry]));
  for (const step of explanation.steps) {
    console.log(`  ${step.number}. ${step.label}: ${step.what}`);
    if (forStep.has(step.id)) console.log(`     For: ${intentWords(forStep.get(step.id))}.`);
    if (step.why) console.log(`     Why: ${step.why.text}`);
    console.log(`     Drafted by ${step.agent?.label ?? 'nobody yet'}${step.skills.length ? `, with ${step.skills.map((skill) => skill.label).join(', ')}` : ''}.`);
    if (step.reads.length) console.log(`     Reads ${step.reads.map((input) => `${input.label}${input.optional ? ' (if there)' : ''}`).join(', ')}.`);
    if (step.checksText) console.log(`     ${step.checksText}`);
    console.log(`     ${step.signOff}`);
    for (const line of step.then) console.log(`     ${line}`);
    // Who does what, where (src/workflow-step-people.mjs): one line per item.
    if (step.people) {
      console.log('     Who does what, where:');
      for (const line of step.people.lines) console.log(`       ${line}`);
    }
  }
}

export function printWorkflowCheck(result, { steps = false } = {}) {
  if (!result.configuration.valid && !result.workflows.length) {
    console.log(result.changeSet ? 'These changes cannot be applied yet, so nothing else was checked:' : 'The workflow configuration cannot be read, so nothing else was checked:');
    printFindings(result.repository.findings, '  ');
    return;
  }
  if (!result.configuration.valid) {
    console.log('The workflow configuration cannot be read until every step has exactly one agent that drafts it. The workflows were checked without agents:');
    printFindings(result.repository.findings.filter((entry) => entry.blocksStart), '  ');
  }
  for (const workflow of result.workflows) {
    console.log(`${workflow.label} (${workflow.id}): ${workflow.explanation.summary}`);
    if (workflow.explanation.description) console.log(`  ${workflow.explanation.description}`);
    if (workflow.changeImpact) console.log(`  ${workflow.changeImpact.text}.`);
    if (steps) printSteps(workflow.explanation, workflow.intents);
    else if (workflow.intents?.length) console.log(`  What each step is for: ${intentsLine(workflow)}.`);
    if (workflow.findings.length) printFindings(workflow.findings, '  ');
    else console.log('  Nothing to fix.');
  }
  const others = result.configuration.valid ? result.repository.findings : result.repository.findings.filter((entry) => !entry.blocksStart);
  if (others.length) {
    console.log(`Agents, skills and instructions: ${countWords(result.configuration.valid ? result.repository.counts : countsOf(others))}`);
    printFindings(others, '  ');
  }
  printSoftware(result.software);
  console.log(`In all: ${countWords(result.counts)}.`);
}

/**
 * The kind of software of each project in the checkout at `root`, from its committed files (step intents spec
 * §12.1). A report only: a checkout whose files cannot be read says so and changes nothing else.
 */
async function softwareReport(root) {
  try {
    const [{ checkoutFilesWithText }, { detectSoftwareKinds, softwareKindTextFiles }] = await Promise.all([
      import('../repository-projects-source.mjs'), import('../software-kinds.mjs')]);
    const read = checkoutFilesWithText(root, (files) => softwareKindTextFiles(files));
    return detectSoftwareKinds(read);
  } catch (error) {
    return { unavailable: String(error?.message ?? error).split(/(?<=[.!?])\s+/u)[0] };
  }
}

export async function run(argv, { positionals, options }) {
  const unknown = Object.keys(options).filter((key) => !['change-set', 'json'].includes(key));
  if (unknown.length) throw new SingularityFlowError(`workflow check does not take --${unknown[0]}.`, { code: 'WORKFLOW_CHECK_USAGE' });
  if (positionals.length > 3) throw new SingularityFlowError('Name at most one workflow: singularity-flow workflow check [WORKFLOW].', { code: 'WORKFLOW_CHECK_USAGE' });
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const only = positionals[2] ? [positionals[2]] : null;
  const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
  const { checkWorkflowConfiguration } = await import('../workflow-check.mjs');
  const source = optionString(options, 'change-set');
  let result;
  if (source) {
    const { readStdinText } = await import('../read-stdin.mjs');
    const { planStudioChangeSet, readStudioChangeSet } = await import('../workflow-studio.mjs');
    const changes = readStudioChangeSet(source === '-' ? await readStdinText() : await readFile(commandLineFile(root, source, { reads: true }), 'utf8'));
    // Saved drafts go out with the Studio's own batch, so they are part of what is checked; one
    // approved elsewhere or in conflict is left out and named, never a blocker for this batch.
    const [drafts, { approvedConfigurationPlanner }] = await Promise.all([import('../configuration-drafts.mjs'), import('./configuration-drafts.mjs')]);
    const { result: plan, leftOut } = await drafts.runWithDrafts(root, changes, (changeSet) => withApprovedConfigurationRead(root, () => planStudioChangeSet(root, changeSet,
      { inspect: (candidateRoot) => checkWorkflowConfiguration(candidateRoot, { workflows: only }) }), { preferAuthority: true }),
    { planner: approvedConfigurationPlanner(root), preview: true });
    if (leftOut.length && !optionBoolean(options, 'json')) for (const entry of leftOut) console.log(drafts.leftOutLine(entry));
    const leftOutDrafts = leftOut.length ? { draftsLeftOut: leftOut.map((entry) => ({ draftId: entry.draftId, number: entry.number,
      description: entry.description, standing: entry.standing, problem: entry.problem ?? null, discard: entry.discard ?? null })) } : {};
    if (plan.valid) result = { ...plan.inspection, changeSet: { valid: true, summary: plan.summary, ...leftOutDrafts } };
    else {
      const findings = plan.problems.map((problem) => ({
        id: `change-${plan.problems.indexOf(problem) + 1}`, code: problem.code, area: 'flow', severity: 'problem',
        title: String(problem.message).split(/(?<=[.!?])\s+/u)[0], detail: problem.message, blocksStart: true,
        subject: problem.subject ? { [problem.subject.kind === 'phase' ? 'step' : problem.subject.kind]: problem.subject.id } : {},
        ...(problem.located?.[0]?.line ? { location: { file: problem.located[0].file, line: problem.located[0].line } } : {})
      }));
      const counts = { problem: findings.length, warning: 0, note: 0 };
      result = { schemaVersion: 1, resultType: 'workflow-check', configuration: { valid: false }, changeSet: { valid: false, summary: plan.summary, ...leftOutDrafts },
        counts, workflows: [], repository: { counts, findings } };
    }
  } else {
    result = await withApprovedConfigurationRead(root, () => checkWorkflowConfiguration(root, { workflows: only }), { preferAuthority: true });
    // The repository's own files, not its configuration: what a change set would leave does not change them.
    result.software = await softwareReport(root);
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  printWorkflowCheck(result, { steps: Boolean(only) });
}
