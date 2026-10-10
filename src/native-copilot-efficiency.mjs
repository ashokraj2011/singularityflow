import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';

const LOOKUP = /^(?:singularity-flow )?(?:pause status|session current|status|clarification status|story references verify)(?:\s|$)/u;

/** Observational exported host trace; not a receipt, gate waiver or provider accounting source. */
export function summarizeNativeCopilotTrace(trace, { oversizedBytes = 16384 } = {}) {
  if (trace?.schemaVersion !== 1 || !Array.isArray(trace.events) || trace.events.length > 10000) { // schema-transient: exported host transport, never a durable product record
    throw new Error('Expected schemaVersion 1 and at most 10000 exported tool events.');
  }
  const phases = new Map(), packets = [], duplicates = [], reads = new Map(), lookups = new Set();
  let responseBytes = 0, durationMsSum = 0, timedEvents = 0, usageEvents = 0, inputTokens = 0, outputTokens = 0, documentReads = 0;
  for (const [index, event] of trace.events.entries()) {
    if (!event || typeof event !== 'object' || typeof event.command !== 'string'
        || !Number.isSafeInteger(event.responseBytes) || event.responseBytes < 0) {
      throw new Error(`Invalid tool event ${index}: command and nonnegative responseBytes are required.`);
    }
    const phase = event.phase ?? 'unbound';
    const row = phases.get(phase) ?? { phase, toolCalls: 0, responseBytes: 0 };
    row.toolCalls++; row.responseBytes += event.responseBytes; phases.set(phase, row);
    responseBytes += event.responseBytes;
    if (Number.isFinite(event.durationMs) && event.durationMs >= 0) { durationMsSum += event.durationMs; timedEvents++; }
    if (Number.isSafeInteger(event.usage?.inputTokens) && event.usage.inputTokens >= 0
        && Number.isSafeInteger(event.usage?.outputTokens) && event.usage.outputTokens >= 0) {
      inputTokens += event.usage.inputTokens; outputTokens += event.usage.outputTokens; usageEvents++;
    }
    if (event.responseBytes > oversizedBytes) packets.push({ index, phase, bytes: event.responseBytes,
      exactReviewMaterial: event.exactReviewMaterial === true });
    // Only an explicit unchanged binding within one invocation can be called redundant.
    if (event.invocationId && event.bindingKey && event.freshnessRequired !== true && LOOKUP.test(event.command)) {
      const key = JSON.stringify([event.invocationId, event.bindingKey, event.command]);
      if (lookups.has(key)) duplicates.push({ index, phase, kind: 'repeated-lookup', candidateBytes: event.responseBytes });
      lookups.add(key);
    }
    if (event.document) documentReads++;
    // Multiple portions of one document are not duplicate reads. Only explicitly complete
    // reads can establish reuse; this observation never grants approval display consent.
    if (event.invocationId && event.document?.displayBinding && event.document?.sha256
        && event.document.complete === true) {
      const key = JSON.stringify([event.invocationId, event.document.displayBinding, event.document.sha256]);
      if (reads.has(key) && event.freshnessRequired !== true) duplicates.push({ index, phase,
        kind: 'repeated-document-read', candidateBytes: event.responseBytes });
      reads.set(key, index);
    }
  }
  const expected = trace.phaseOrder;
  const completed = trace.completedPhases;
  return { schemaVersion: 1, resultType: 'native-copilot-efficiency-observation',
    workId: trace.workId ?? null, workflow: trace.workflow ?? null,
    completeStoryReported: trace.lifecycleStatus === 'completed' && Array.isArray(expected) && expected.length > 0
      && new Set(expected).size === expected.length && Array.isArray(completed)
      && JSON.stringify(expected) === JSON.stringify(completed),
    toolCalls: trace.events.length, responseBytes, durationMsSum, timedEvents,
    phases: [...phases.values()], documentReads, completeDocumentBindings: reads.size,
    oversizedPackets: packets, duplicateCandidates: duplicates,
    providerUsage: usageEvents ? { inputTokens, outputTokens, usageEvents,
      complete: usageEvents === trace.events.length, source: 'exported-host-trace' } : null,
    billedSavings: null,
    limitations: ['Completion and usage are reported by the exported trace, not independently attested.',
      'Response bytes are not provider tokens; summed tool durations are not wall-clock Story latency.',
      'Duplicate candidates require review; fresh bindings, exact review material and consent must not be skipped.'] };
}

export async function readNativeCopilotTrace(file) {
  const limit = 16 * 1024 * 1024;
  const initial = await lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > limit) throw new Error('Trace must be a regular file of at most 16 MiB.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Trace must be a regular file of at most 16 MiB.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('Trace exceeded the 16 MiB bound.');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}
