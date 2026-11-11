/**
 * `workflow walk [WORKFLOW] [--shipped] [--step-seconds N] [--total-seconds N] [--keep] [--json]` —
 * a model-free dry run that drives a throwaway Story through every step of each workflow on an
 * isolated copy and reports every place it would stop that is not a real decision a person is meant
 * to make (src/workflow-walk/walk.mjs). It reads only this repository's workflow configuration; every
 * write is in its own temporary folder, which it removes (`--keep` leaves it and names it). Exits 1
 * when any step stops, 2 when nothing stopped but a step could not be judged, else 0.
 */
import { SingularityFlowError, optionBoolean, optionString } from '../util.mjs';

const OPTIONS = ['json', 'shipped', 'step-seconds', 'total-seconds', 'keep'];

function seconds(options, name, fallback, maximum) {
  const raw = optionString(options, name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 10 || value > maximum) {
    throw new SingularityFlowError(`--${name} takes a whole number of seconds from 10 to ${maximum}.`, { code: 'WORKFLOW_WALK_USAGE' });
  }
  return value;
}

const CLASS_WORDS = { 'expected-person-step': 'person', 'expected-review': 'review' };

/** The walk in plain text: per workflow, each step, what a person is asked there, and the stops. */
export function walkLines(result) {
  const lines = [];
  const source = result.source.kind === 'shipped' ? 'the shipped workflows'
    : result.source.kind === 'approved' ? `the approved configuration (${result.source.ref}${result.source.commit ? ` ${String(result.source.commit).slice(0, 12)}` : ''})`
      : "this checkout's workflow configuration";
  lines.push(`Walked ${result.counts.workflows} workflow(s) from ${source}, with no model, on a throwaway copy.`);
  if (result.actionsLeftOut?.length) {
    lines.push(`After-step actions were left out of the copy, so nothing was sent: ${result.actionsLeftOut.map((entry) => `${entry.where} (${entry.actions})`).join(', ')}.`);
  }
  for (const workflow of result.workflows) {
    lines.push('', `${workflow.label} (${workflow.id}): ${workflow.outcome}${workflow.reason ? `: ${workflow.reason}` : ''} in ${workflow.seconds} s`);
    for (const step of workflow.steps) {
      lines.push(`  ${step.label === step.id ? step.id : `${step.label} (${step.id})`}: ${step.outcome}`);
      for (const entry of step.people) lines.push(`    ${CLASS_WORDS[entry.class] ?? entry.class}: ${entry.ask}${entry.where ? ` [${entry.where}]` : ''}`);
      for (const note of step.notes) lines.push(`    note: ${note}`);
      for (const stop of step.stops) {
        lines.push(`    STOP ${stop.code ?? 'no code'} at ${stop.command}`, `      ${stop.message}`, `      Likely cause: ${stop.cause}`);
      }
      for (const entry of step.notJudged) lines.push(`    not judged (${entry.code}): ${entry.message}`);
    }
    if (workflow.folder) lines.push(`  Kept: ${workflow.folder}`);
  }
  const { counts } = result;
  lines.push('', `In all: ${counts.completed} completed, ${counts.stopped} stopped, ${counts.notJudged} not judged; ${counts.stops} stop(s), `
    + `${counts.expectedPersonSteps} person step(s), ${counts.expectedReviews} review(s).`);
  if (counts.stops) lines.push('Each stop is a place a real Story would halt that no person decision clears: fix it in the workflow before a team uses it (workflow check and workflow validate show the configuration).');
  return lines;
}

export async function run(argv, { positionals, options }) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.includes(key));
  if (unknown.length) throw new SingularityFlowError(`workflow walk does not take --${unknown[0]}.`, { code: 'WORKFLOW_WALK_USAGE' });
  if (positionals.length > 3) throw new SingularityFlowError('Name at most one workflow: singularity-flow workflow walk [WORKFLOW].', { code: 'WORKFLOW_WALK_USAGE' });
  const shipped = optionBoolean(options, 'shipped');
  const root = shipped ? process.cwd() : (await import('../git.mjs')).repoRoot();
  const { walkWorkflows } = await import('../workflow-walk/walk.mjs');
  const json = optionBoolean(options, 'json');
  const result = await walkWorkflows(root, {
    workflow: positionals[2] ?? null, shipped, keep: optionBoolean(options, 'keep'),
    stepSeconds: seconds(options, 'step-seconds', 240, 3600), totalSeconds: seconds(options, 'total-seconds', 3600, 86_400),
    onWorkflow: json ? null : (entry) => process.stderr.write(`workflow walk: ${entry.id} ${entry.outcome} (${entry.seconds} s)\n`)
  });
  process.exitCode = result.counts.stops ? 1 : result.ok ? 0 : 2;
  if (json) return console.log(JSON.stringify(result, null, 2));
  for (const line of walkLines(result)) console.log(line);
}
