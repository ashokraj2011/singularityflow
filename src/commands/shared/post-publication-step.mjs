/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { redactDiagnosticText } from '../../git-remote-diagnostics.mjs';
import { printCommandRoutes } from './print-command-routes.mjs';

/**
 * A governed commit is the lifecycle outcome; presentation and local-session refresh are a tail.
 * Once the commit has landed, a tail failure must not turn success into a red lifecycle refusal
 * that invites a duplicate mutation. Report it as bounded local recovery and keep exit status 0.
 */
export async function postPublicationStep(label, workId, operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    console.warn(`Warning: governed publication succeeded, but ${label} could not be completed: ${redactDiagnosticText(error?.message ?? String(error))}`);
    printCommandRoutes(`singularity-flow resume ${workId} --fetch`, {
      label: 'Refresh local phase/session state'
    });
    return { ok: false, value: null, error };
  }
}
