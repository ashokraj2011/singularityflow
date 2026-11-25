/**
 * `singularity-flow marketplace …`. `catalog [--kind KIND] [--marketplace ID] [--search TEXT] [--json]` is answered here:
 * every item of every trusted marketplace and what is installed here, like an app store (src/marketplace-catalog.mjs),
 * read only and with no model. list, browse, add and remove stay in the CLI monolith, which loads only for them.
 */
import { SingularityFlowError } from '../util.mjs';

const CATALOG_OPTIONS = Object.freeze(['json', 'kind', 'marketplace', 'search']);
const KINDS = Object.freeze(['skill', 'agent', 'workflow', 'template']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const legacy = () => import('./legacy.mjs');

/** The monolith's graph, loaded where the dispatcher times it, for every action but `catalog`. */
export async function load({ positionals = [] } = {}) {
  if (positionals[1] !== 'catalog') await (await legacy()).load();
}

export async function run(argv, { positionals, options }) {
  if (positionals[1] !== 'catalog') return (await legacy()).run(argv);
  return runMarketplaceCatalog({ positionals, options });
}

/** `marketplace catalog`'s own form: no positional, and only its four options. */
export function validateMarketplaceCatalogRequest({ positionals, options }) {
  const retry = { command: 'singularity-flow marketplace catalog', label: 'See every item of every trusted marketplace.' };
  const refuse = (message) => { throw new SingularityFlowError(message, { code: 'MARKETPLACE_CATALOG_USAGE', details: { nextAction: retry } }); };
  if (positionals.length !== 2) refuse('marketplace catalog takes no item. Narrow it with --kind, --marketplace or --search.');
  for (const key of Object.keys(options)) if (!CATALOG_OPTIONS.includes(key)) refuse(`marketplace catalog does not take --${key}; it takes --kind, --marketplace, --search and --json.`);
  if (options.json !== undefined && options.json !== true) refuse('--json does not take a value.');
  if (options.kind !== undefined && !KINDS.includes(options.kind)) refuse(`--kind takes one of ${KINDS.join(', ')}.`);
  if (options.marketplace !== undefined && (typeof options.marketplace !== 'string' || !ID.test(options.marketplace))) {
    refuse('--marketplace takes the ID of a marketplace this repository trusts, in lower-case kebab-case.');
  }
  if (options.search !== undefined && (typeof options.search !== 'string' || !options.search.trim() || options.search.length > 200)) {
    refuse('--search takes the words to look for, up to 200 characters.');
  }
}

export async function runMarketplaceCatalog({ positionals, options }) {
  validateMarketplaceCatalogRequest({ positionals, options });
  const [{ repoRoot }, { readMarketplaceCatalog, marketplaceCatalogLines }] = await Promise.all([import('../git.mjs'), import('../marketplace-catalog.mjs')]);
  const catalog = await readMarketplaceCatalog(repoRoot(), { marketplace: options.marketplace ?? null, kind: options.kind ?? null, search: options.search ?? null });
  if (options.json === true) return console.log(JSON.stringify(catalog, null, 2));
  for (const line of marketplaceCatalogLines(catalog)) console.log(line);
}
