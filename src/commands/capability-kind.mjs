/**
 * `singularity-flow capability kind [--capability ID] [--kind PROJECT=KIND]... [--confirm sha256:<DIGEST>] [--json]`: what
 * kind of software each project of this checkout is (web, backend, job, cli, library, mobile or artifact), recorded
 * once (software-kind-record.mjs). Without --confirm it is a read: the kinds and, while one is unconfirmed, the one line
 * a person answers, with its short confirmation code. With --confirm it records exactly the kinds that line showed;
 * the person types the code (/sf-confirm in chat, `singularity-flow confirm` in a terminal), never an agent.
 */
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['capability', 'kind', 'confirm', 'json']);

/** The routes a person answers the question with: Yes by its short code, No by naming the kind. */
async function answerRoutes(view) {
  if (!view.confirm) return view;
  const [{ copilotCommandForCommand }, { confirmCommandByCode }] = await Promise.all([import('../copilot-guidance.mjs'), import('../confirm-code.mjs')]);
  const confirm = { ...view.confirm, copilotCommand: copilotCommandForCommand(view.confirm.command), byCode: confirmCommandByCode(view.confirm.command) };
  return { ...view, confirm };
}

export async function runCapabilityKind({ positionals = [], options = {} } = {}) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key)).sort();
  if (unknown.length || positionals.length > 2) {
    throw new SingularityFlowError(`Use singularity-flow capability kind [--capability ID] [--kind PROJECT=KIND]... [--json]; a person confirms the line it shows with its short code.${unknown.length
      ? ` Not an option here: ${unknown.map((key) => `--${key}`).join(', ')}.` : ''}`, { code: 'SOFTWARE_KIND_USAGE', details: { nextAction: 'singularity-flow capability kind --json' } });
  }
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const record = await import('../software-kind-record.mjs');
  const capabilityId = optionString(options, 'capability', null);
  const overrides = optionStrings(options, 'kind');
  const digest = optionString(options, 'confirm', null);
  const result = digest ? await record.confirmSoftwareKinds(root, { capabilityId, digest, overrides })
    : await answerRoutes(await record.softwareKindsView(root, { capabilityId, overrides }));
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  for (const project of result.projects) {
    const name = project.root ? `${project.name ?? project.id} (${project.root})` : project.name ?? 'This repository';
    const state = project.confirmed ? 'confirmed' : project.kind ? 'not confirmed yet' : 'cannot tell';
    console.log(`${name}: ${project.kind ?? 'unknown'} (${state})${project.detectedNow ? `; its files now look like ${project.detectedNow}` : ''}.`);
  }
  if (result.recorded) console.log('Recorded. SFlow uses these kinds for this app\'s checks and does not ask again.');
  if (result.question) console.log(result.question);
  if (result.confirm) console.log(`- ${result.confirm.words} ${result.confirm.copilotCommand ?? result.confirm.byCode ?? result.confirm.command}${result.confirm.byCode ? ` (terminal: ${result.confirm.byCode})` : ''}`);
  if (result.correct) {
    console.log(`- ${result.correct.words}`);
    for (const choice of result.correct.choices) console.log(`  ${choice.kind}: ${choice.command.replace(/ --json$/u, '')}`);
  }
  for (const note of result.notes ?? []) console.log(note);
  return result;
}
