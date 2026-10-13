/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { refusalFingerprint, assertRefusalChanged, forgetRefusal, rememberRefusal } from '../../evidence/refusal-memory.mjs';
import { nowIso } from '../../util.mjs';

/**
 * Run a transition that can end a Story, answering an unchanged retry of a gate refusal from memory
 * instead of running its checks again [E2G-024]. Success forgets the refusal.
 */
export async function withRefusalMemory(root, subject, transition) {
  const fingerprint = await refusalFingerprint(root, subject);
  await assertRefusalChanged(root, subject.workId, fingerprint);
  try {
    const value = await transition();
    await forgetRefusal(root, subject.workId);
    return value;
  } catch (error) {
    if (error?.details?.gate) await rememberRefusal(root, subject.workId, fingerprint, error.details.gate, nowIso());
    throw error;
  }
}
