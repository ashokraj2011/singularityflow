/**
 * A phase as one work type runs it. The resolver, Studio and markup compiler share this rule:
 * nested contract settings merge key by key; explicitly named fields replace shared defaults.
 * `because` (why a step sets a framework setting itself, step intents spec §7.1) merges key by key too, so a
 * workflow's reason for one setting keeps the shared step's reasons for the others; a phase without one keeps its shape.
 */
export function mergePhaseOverride(phase, override = {}) {
  const because = phase?.because != null || override?.because != null
    ? { because: { ...(phase?.because ?? {}), ...(override?.because ?? {}) } } : {};
  return {
    ...phase,
    ...override,
    artifact: { ...(phase.artifact ?? {}), ...(override.artifact ?? {}) },
    worldModel: { ...(phase.worldModel ?? {}), ...(override.worldModel ?? {}) },
    approval: override.approval === undefined
      ? phase.approval
      : typeof override.approval === 'string'
        ? override.approval
        : { ...(phase.approval ?? {}), ...override.approval },
    generation: override.generation === undefined
      ? phase.generation
      : typeof override.generation === 'string'
        ? override.generation
        : { ...(phase.generation ?? {}), ...override.generation },
    comparison: { ...(phase.comparison ?? {}), ...(override.comparison ?? {}) },
    ...because
  };
}
