/** Presentation-independent, bounded results for every composed command. No command is retried. */
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

const MARKER = '--- singularity-flow structured refusal v1 ---';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function capturedStepResult(result) {
  const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
  let value = null;
  try { value = JSON.parse(stdout); } catch { /* Successful human output is not JSON. */ }
  if (!value && result.status !== 0) {
    const at = stderr.lastIndexOf(MARKER);
    if (at >= 0) {
      const tail = stderr.slice(at + MARKER.length).trim();
      try { value = JSON.parse(tail); } catch {
        // Debug stack output can follow the single-line machine envelope.
        try { value = JSON.parse(tail.split(/\r?\n/u)[0]); } catch { /* Preserve a safe text diagnostic below. */ }
      }
    }
  }
  return { ok: result.status === 0 && !result.error, status: result.status, value,
    stdout, stderr, signal: result.signal ?? null,
    timedOut: result.timedOut === true || result.error?.code === 'ETIMEDOUT',
    ...(result.error ? { processError: { code: result.error.code ?? null,
      message: redactDiagnosticText(result.error.message ?? '').slice(0, 2000) } } : {}) };
}

export function stepFailureSummary(result) {
  const lines = String(result.stderr || result.stdout || '').split(/\r?\n/u).map(line => line.trim());
  const reason = lines.find(line => /^(?:Singularity Flow error:|Error:|fatal:|error:)/iu.test(line))
    ?? lines.find(line => line && !/^(?:Then:|Shell:|Copilot:|VS Code:|[-*] )/u.test(line))
    ?? result.processError?.message ?? 'No diagnostic was returned.';
  return redactDiagnosticText(reason).slice(0, 4000);
}

export function stepRefusal(result) {
  // Narrated CommandResult failures have outcome/why/next instead of an error object.
  return object(result.value) ? result.value : null;
}
