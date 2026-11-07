/** Execute a consented plan through trusted effects, preserving confirmed and remaining records. */
import {planBatches} from '../kernel/decision-plan.mjs';

export async function runDecisionPlan(plan, apply) {
  const recorded = [];
  const batches = planBatches(plan);
  const after = (index) => batches.slice(index + 1).flat().flatMap((later) => later.effects.map((entry) => ({ item: later.item, kind: entry.kind, effect: entry })));
  for (const [batchIndex, batch] of batches.entries()) {
    if (batch.length > 1) {
      const effect = { kind: 'plan-amendment', changes: batch.map((step) => step.effects[0].change) };
      try {
        const record = await apply(effect, batch[0], {});
        recorded.push(...batch.map((step) => ({ item: step.item, kind: effect.kind, record })));
      } catch (error) {
        return { recorded, failed: { item: batch[0].item, kind: effect.kind, error }, remaining: [...batch.map((step) => ({ item: step.item, kind: effect.kind, effect: step.effects[0] })), ...after(batchIndex)] };
      }
      continue;
    }
    const [step] = batch;
    const produced = {};
    for (const [effectIndex, effect] of step.effects.entries()) {
      try {
        const record = await apply(effect, step, produced);
        if (effect.kind === 'upstream-issue') produced.issue = record?.id ?? null;
        recorded.push({ item: step.item, kind: effect.kind, record });
      } catch (error) {
        return { recorded, failed: { item: step.item, kind: effect.kind, error },
          remaining: [...step.effects.slice(effectIndex).map((entry) => ({ item: step.item, kind: entry.kind, effect: entry })), ...after(batchIndex)] };
      }
    }
  }
  return { recorded, failed: null, remaining: [] };
}
