/**
 * Artifact templates as named things, independent of the phases that use them.
 *
 * A template used to exist only as a path written inside a phase record — `defaultTemplate:
 * common/intake.md`. That works, and it means a template has no identity: two phases sharing one
 * template share a string, nothing can be renamed without editing every phase that mentions it, and
 * a template cannot carry a label or a kind of its own. Templates were the only authored asset in
 * the product with no name.
 *
 * The catalog gives them one. `templates:` declares each template once, with an id, and phases and
 * work types reference the id instead of repeating the path.
 *
 * Three forms are accepted where a template is named, and the reference form is why this composes
 * rather than replaces:
 *
 *   - `template:<id>`  — a catalog entry, resolved here
 *   - `agent:<agent>/<id>` — a remote template locked to an agent, resolved by `agents.mjs`
 *   - `common/intake.md` — a repository-relative path, exactly as before
 *
 * The third is not deprecated and does not warn. Every existing repository is full of them, they
 * are unambiguous, and a migration that forces a rewrite of every phase to gain a feature nobody
 * asked for yet is a tax, not an upgrade. A repository adopts the catalog when it wants one.
 */
import { SingularityFlowError } from './util.mjs';

const REFERENCE = /^template:(?<id>[a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Whether a value names a catalog entry rather than a path or an agent template. */
export function isTemplateReference(value) {
  return typeof value === 'string' && value.startsWith('template:');
}

export function parseTemplateReference(value, label = 'Template reference') {
  const match = REFERENCE.exec(String(value ?? ''));
  if (!match) {
    throw new SingularityFlowError(
      `${label} '${value}' must be template:<id>, where the id is lower-case kebab-case.`,
      { code: 'TEMPLATE_REFERENCE_INVALID', details: { value } }
    );
  }
  return match.groups.id;
}

function assertRelativePath(value, label) {
  if (!value || typeof value !== 'string' || value.startsWith('/') || value.split(/[\\/]/).includes('..')) {
    throw new SingularityFlowError(`${label} must be a repository-relative path without '..'.`, { code: 'TEMPLATE_PATH_INVALID' });
  }
  return value;
}

/**
 * Normalize the `templates:` catalog.
 *
 * An entry is a path or an object; the object form is what lets a template carry the things a path
 * cannot — a human label for the designer, and the artifact kind it produces.
 */
export function normalizeTemplateCatalog(value, { label = 'templates' } = {}) {
  if (value == null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object of template id to definition.`, { code: 'TEMPLATE_CATALOG_INVALID' });
  }
  const catalog = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new SingularityFlowError(`${label} id '${id}' must be lower-case kebab-case.`, { code: 'TEMPLATE_CATALOG_INVALID' });
    }
    const source = typeof entry === 'string' ? { path: entry } : entry;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new SingularityFlowError(`${label}.${id} must be a path or an object.`, { code: 'TEMPLATE_CATALOG_INVALID' });
    }
    for (const key of Object.keys(source)) {
      if (!['path', 'label', 'kind', 'description'].includes(key)) {
        throw new SingularityFlowError(`${label}.${id} contains unknown field '${key}'.`, { code: 'TEMPLATE_CATALOG_INVALID' });
      }
    }
    catalog[id] = Object.freeze({
      id,
      path: assertRelativePath(source.path, `${label}.${id}.path`),
      label: source.label ?? id,
      kind: source.kind ?? null,
      description: source.description ?? null
    });
  }
  return Object.freeze(catalog);
}

/**
 * Turn whatever a phase or work type named into the thing that will actually be read.
 *
 * One resolver, because the alternative is each of the five readers deciding for itself what a
 * template value means — and the moment two of them disagree, a phase renders from one file while
 * the designer reports another.
 *
 * Agent references are returned unresolved on purpose: they need the network and a locked digest,
 * which is `materializeAgentTemplate`'s job and not something a configuration read should trigger.
 */
export function resolveTemplate(definition, value, { label = 'Template' } = {}) {
  if (value == null) return null;
  if (isTemplateReference(value)) {
    const id = parseTemplateReference(value, label);
    const entry = definition?.templates?.[id];
    if (!entry) {
      const known = Object.keys(definition?.templates ?? {});
      throw new SingularityFlowError(
        `${label} references template '${id}', which the catalog does not declare.`
        + (known.length ? ` Declared: ${known.sort().join(', ')}.` : ' No templates are declared.'),
        { code: 'TEMPLATE_UNKNOWN', details: { id, known } }
      );
    }
    return { source: 'catalog', id, path: entry.path, label: entry.label, kind: entry.kind };
  }
  if (typeof value === 'string' && value.startsWith('agent:')) {
    return { source: 'agent', id: null, path: null, reference: value, label: value, kind: null };
  }
  return { source: 'path', id: null, path: value, label: value, kind: null };
}

/** The path a template value resolves to, or null when only an agent can produce it. */
export function templatePath(definition, value, options = {}) {
  return resolveTemplate(definition, value, options)?.path ?? null;
}

/**
 * Everything that names a template, for the designer and for the rename/delete guard.
 *
 * Both stores are walked, because a template declared once is exactly the kind of asset that ends
 * up referenced from a place its author forgot about.
 */
export function templateReferences(definition, value) {
  const references = [];
  const matches = (candidate) => candidate === value
    || (isTemplateReference(candidate) && definition?.templates?.[parseTemplateReference(candidate)]?.path === value);
  for (const [phaseId, phase] of Object.entries(definition?.phases ?? {})) {
    if (matches(phase?.defaultTemplate)) references.push(`phase ${phaseId}`);
  }
  for (const [workTypeId, workType] of Object.entries(definition?.workTypes ?? {})) {
    for (const [phaseId, candidate] of Object.entries(workType?.templateOverrides ?? {})) {
      if (matches(candidate)) references.push(`workflow ${workTypeId}/${phaseId}`);
    }
  }
  return references;
}
