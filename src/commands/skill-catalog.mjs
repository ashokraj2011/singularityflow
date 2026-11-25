/**
 * `singularity-flow skill catalog [--marketplace ID] [--json]`: every skill in this repository's skill library and in
 * the marketplaces it trusts, with what each is for, who uses it, which look alike and which steps none covers
 * (src/skill-catalog.mjs). Read only, with no model.
 */
import { validateSkillCatalogRequest } from './skill-request.mjs';

export async function runSkillCatalog({ positionals, options }) {
  validateSkillCatalogRequest({ positionals, options });
  const [{ repoRoot }, { readSkillCatalog, skillCatalogLines }] = await Promise.all([import('../git.mjs'), import('../skill-catalog.mjs')]);
  const catalog = await readSkillCatalog(repoRoot(), { marketplace: options.marketplace ?? null });
  if (options.json === true) return console.log(JSON.stringify(catalog, null, 2));
  for (const line of skillCatalogLines(catalog)) console.log(line);
}
