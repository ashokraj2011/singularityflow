export { isTemplateReference, parseTemplateReference, normalizeTemplateCatalog, resolveTemplate, templatePath, templateReferences } from './kernel/configuration-policy.mjs';
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
