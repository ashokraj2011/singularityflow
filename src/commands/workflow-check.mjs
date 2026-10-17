/**
 * `workflow check [WORKFLOW] [--change-set FILE|-] [--json]` — explain each workflow in plain words
 * and list, with where to look, what does not make sense in it (src/workflow-check.mjs). Read-only:
 * with a Studio change set it checks the configuration as that change set would leave it, without
 * writing anything.
 */
import { readFile } from 'node:fs/promises';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString } from '../util.mjs';

const SEVERITY_WORDS = { problem: 'problem', warning: 'warning', note: 'note' };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const countWords = (counts) => ['problem', 'warning', 'note'].map((severity) => plural(counts[severity] ?? 0, severity)).join(', ');
const where = (location) => (location ? `  (${location.file}${location.line ? `:${location.line}` : ''})` : '');

function printFindings(findings, indent) {
  for (const entry of findings) {
    console.log(`${indent}${SEVERITY_WORDS[entry.severity].padEnd(8)} ${entry.title}${where(entry.location)}`);
    if (entry.detail && entry.detail !== entry.title) console.log(`${indent}         ${entry.detail}`);
    if (entry.fix) console.log(`${indent}         Fix: ${entry.fix.text}`);
  }
}

function printSteps(explanation) {
  for (const step of explanation.steps) {
    console.log(`  ${step.number}. ${step.label}: ${step.what}`);
    if (step.why) console.log(`     Why: ${step.why.text}`);
    console.log(`     Drafted by ${step.agent?.label ?? 'nobody yet'}${step.skills.length ? `, with ${step.skills.map((skill) => skill.label).join(', ')}` : ''}.`);
    if (step.reads.length) console.log(`     Reads ${step.reads.map((input) => `${input.label}${input.optional ? ' (if there)' : ''}`).join(', ')}.`);
    console.log(`     ${step.signOff}`);
    for (const line of step.then) console.log(`     ${line}`);
  }
}

export function printWorkflowCheck(result, { steps = false } = {}) {
  if (!result.configuration.valid) {
    console.log(result.changeSet ? 'These changes cannot be applied yet, so nothing else was checked:' : 'The workflow configuration cannot be read, so nothing else was checked:');
    printFindings(result.repository.findings, '  ');
    return;
  }
  for (const workflow of result.workflows) {
    console.log(`${workflow.label} (${workflow.id}): ${workflow.explanation.summary}`);
    if (workflow.explanation.description) console.log(`  ${workflow.explanation.description}`);
    if (steps) printSteps(workflow.explanation);
    if (workflow.findings.length) printFindings(workflow.findings, '  ');
    else console.log('  Nothing to fix.');
  }
  if (result.repository.findings.length) {
    console.log(`Agents, skills and instructions: ${countWords(result.repository.counts)}`);
    printFindings(result.repository.findings, '  ');
  }
  console.log(`In all: ${countWords(result.counts)}.`);
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
    // Saved drafts go out with the Studio's own batch, so they are part of what is checked.
    const { changeSet } = await import('../configuration-drafts.mjs').then(({ withSavedDrafts }) => withSavedDrafts(root, changes));
    const plan = await withApprovedConfigurationRead(root, () => planStudioChangeSet(root, changeSet,
      { inspect: (candidateRoot) => checkWorkflowConfiguration(candidateRoot, { workflows: only }) }), { preferAuthority: true });
    if (plan.valid) result = { ...plan.inspection, changeSet: { valid: true, summary: plan.summary } };
    else {
      const findings = plan.problems.map((problem) => ({
        id: `change-${plan.problems.indexOf(problem) + 1}`, code: problem.code, area: 'flow', severity: 'problem',
        title: String(problem.message).split(/(?<=[.!?])\s+/u)[0], detail: problem.message,
        subject: problem.subject ? { [problem.subject.kind === 'phase' ? 'step' : problem.subject.kind]: problem.subject.id } : {},
        ...(problem.located?.[0]?.line ? { location: { file: problem.located[0].file, line: problem.located[0].line } } : {})
      }));
      const counts = { problem: findings.length, warning: 0, note: 0 };
      result = { schemaVersion: 1, resultType: 'workflow-check', configuration: { valid: false }, changeSet: { valid: false, summary: plan.summary },
        counts, workflows: [], repository: { counts, findings } };
    }
  } else {
    result = await withApprovedConfigurationRead(root, () => checkWorkflowConfiguration(root, { workflows: only }), { preferAuthority: true });
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  printWorkflowCheck(result, { steps: Boolean(only) });
}
