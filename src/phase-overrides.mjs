/**
 * A phase as one work type runs it. The resolver, Studio and markup compiler share this rule:
 * nested contract settings merge key by key; explicitly named fields replace shared defaults.
 */
export function mergePhaseOverride(phase, override = {}) {
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
    comparison: { ...(phase.comparison ?? {}), ...(override.comparison ?? {}) }
  };
}
