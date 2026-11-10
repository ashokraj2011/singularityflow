/**
 * Once a code step's generation is published with its required tests passing, the person is asked whether
 * to start the application and try it now (owner, 2026-11-10): "after the coding and testing is done it
 * should ask the user if it wants to start the application or not".
 *
 * The question is in the publication's own result, which a generation has once: a later read (next steps,
 * the step's entry) never asks it again. The agent never starts the application: "Start the application"
 * is the person's choice and /sf-run-app's to carry out; "Not now" goes on with the step. A checkout that
 * declares no application is told so in one line, with the route that declares one.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseHandoff } from './guide.mjs';

/** The question for a just-published code generation, or null for any other step or an unreadable checkout. */
export async function applicationStartOffer(root, workflow, phase) {
  if (!phase || !phaseRequiresCodeDelivery(phase)) return null;
  let context;
  try {
    context = await (await import('./capability-application-context.mjs')).resolveCapabilityApplication(root, { subjectPath: '' });
  } catch { return null; }
  if (!context.application?.start?.length) return { declared: false,
    words: 'This checkout declares no application to start; /sf-run-app suggest (singularity-flow app suggest) declares one.',
    route: { command: 'singularity-flow app suggest --json', copilotCommand: '/sf-run-app suggest' } };
  // Not now: the step's own next actions after publication, submit first and the next generation for a change.
  const onward = phaseHandoff(workflow, phase).filter((action) => action.command && !/ phase show /u.test(action.command)).slice(0, 2)
    .map(({ command, copilotCommand, reason }) => ({ command, copilotCommand: copilotCommand ?? null, reason: reason ?? null }));
  return { declared: true, workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
    question: `${phase.label ?? phase.id} generation ${phase.generation} is published and its tests pass. Start the application to try it now?`,
    choices: [
      { id: 'start', label: 'Start the application', copilotCommand: '/sf-run-app start', command: 'singularity-flow app plan --json',
        description: 'The person chooses: /sf-run-app starts it in the environment they pick, and reports its address.' },
      { id: 'not-now', label: 'Not now', routes: onward,
        description: onward.length > 1 ? 'Go on with the step: submit it, or start its next generation for a change.' : 'Go on with the step.' }
    ] };
}
