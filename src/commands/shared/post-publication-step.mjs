/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { redactDiagnosticText } from '../../git-remote-diagnostics.mjs';
import { commandRouteLines, safeCommandGuidance } from '../../safe-command-guidance.mjs';

/**
 * A governed commit is the lifecycle outcome; presentation and local-session refresh are a tail.
 * Once the commit has landed, a tail failure must not turn success into a red lifecycle refusal
 * that invites a duplicate mutation. Report it as bounded local recovery and keep exit status 0.
 */
export async function postPublicationStep(label, workId, operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    // The route goes on stderr with its warning: stdout is the command's own result, one JSON object under --json.
    console.warn(`Warning: publication succeeded, but ${label} could not be completed: ${redactDiagnosticText(error?.message ?? String(error))}`);
    console.warn('Refresh local phase/session state:');
    for (const line of commandRouteLines(safeCommandGuidance({ command: `singularity-flow resume ${workId} --fetch`, skill: null }) ?? {}, '')) console.warn(line);
    return { ok: false, value: null, error };
  }
}
