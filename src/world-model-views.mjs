export const WORLD_MODEL_VIEW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function addReference(index, view, reference) {
  if (!view || !WORLD_MODEL_VIEW_ID.test(view)) return;
  const references = index.get(view) ?? [];
  if (!references.includes(reference)) references.push(reference);
  index.set(view, references);
}

export function markdownWorldModelViews(content) {
  const views = new Set();
  for (const match of String(content ?? '').matchAll(/(?:^|[^a-zA-Z0-9_-])views\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md\b/g)) views.add(match[1]);
  return [...views].sort();
}

export function structuredWorldModelViewReferences(definition) {
  const references = new Map();
  for (const [phaseId, phase] of Object.entries(definition.phases ?? {})) {
    for (const view of phase.worldModel?.views ?? []) addReference(references, view, `phase '${phaseId}'`);
  }
  for (const [personaId, persona] of Object.entries(definition.personas ?? {})) {
    for (const view of persona.worldModelViews ?? []) addReference(references, view, `persona '${personaId}' prompt`);
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes ?? {})) {
    for (const [phaseId, override] of Object.entries(workType.phaseOverrides ?? {})) {
      for (const view of override.worldModel?.views ?? []) addReference(references, view, `workflow '${workTypeId}' phase '${phaseId}' override`);
    }
  }
  for (const [index, rule] of (definition.worldModel?.injection?.rules ?? []).entries()) {
    for (const include of rule.include ?? []) {
      const match = String(include).match(/^views\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
      if (match) addReference(references, match[1], `world-model injection rule ${index + 1}`);
    }
  }
  return references;
}

export function worldModelViewCatalog(definition, promptViews = []) {
  const configured = definition.worldModel?.views;
  if (configured) return [...configured];
  return [...new Set([...structuredWorldModelViewReferences(definition).keys(), ...promptViews])].sort();
}

export function worldModelViewReferences(definition, view, promptReferences = []) {
  return [...(structuredWorldModelViewReferences(definition).get(view) ?? []), ...promptReferences];
}

export function addWorldModelView(definition, view) {
  const id = String(view ?? '').trim();
  if (!WORLD_MODEL_VIEW_ID.test(id)) throw new Error('World-model view ID must be lower-case kebab-case.');
  const next = structuredClone(definition);
  next.worldModel ??= {};
  const views = next.worldModel.views ?? worldModelViewCatalog(next);
  if (views.includes(id)) throw new Error(`World-model view '${id}' already exists.`);
  next.worldModel.views = [...views, id];
  return next;
}

export function removeWorldModelView(definition, view, promptReferences = []) {
  const configured = worldModelViewCatalog(definition);
  if (!configured.includes(view)) throw new Error(`World-model view '${view}' does not exist.`);
  const references = worldModelViewReferences(definition, view, promptReferences);
  if (references.length) throw new Error(`World-model view '${view}' is still used by ${references.join(', ')}. Remove those references first.`);
  const next = structuredClone(definition);
  next.worldModel ??= {};
  next.worldModel.views = configured.filter((id) => id !== view);
  return next;
}
