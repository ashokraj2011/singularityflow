/**
 * A workflow bundle an HTTPS index marketplace lists [owner, 2026-11-26]: `workflow import "market:<ID>/<ENTRY>"` fetches
 * it, checks it, and saves it where `workflow import` reads a bundle, so the existing import review (--dry-run, then the
 * person's --confirm, with --propose for an approved configuration) is the only way it reaches configuration.
 *
 * - Only a marketplace the approved configuration trusts is read, through its index (marketplace.mjs, which refuses an
 *   entry served from an origin the trust does not allow) and the hardened HTTPS reader (remote-fetch.mjs): public HTTPS,
 *   every request and redirect on those same origins, at most the entry's own byte count and never past the reader's
 *   hard limit.
 * - The bytes must be the ones the index pins (its SHA-256); anything else is refused and nothing is saved.
 * - The bytes are data: parsed as a workflow bundle (its own digest checked) and never run. They are kept, exactly as
 *   fetched, in SFlow's private folder beside the bundles a marketplace agent's workflow is made into, one folder per
 *   digest, so the same bundle is the same file and the review names it.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError } from './util.mjs';

/** `market:<ID>/<ENTRY>[@VERSION]`, as `import preview` names a marketplace entry. */
export const MARKETPLACE_REFERENCE = /^market:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:@[0-9A-Za-z][0-9A-Za-z.+-]{0,63})?$/u;
export const isMarketplaceReference = (value) => MARKETPLACE_REFERENCE.test(String(value ?? ''));

const refusal = (message, code, nextAction, details = {}) => new SingularityFlowError(message, { code, details: { ...details, nextAction } });

/** Where a fetched bundle is kept: SFlow's private folder for marketplace workflows, one folder per digest. */
async function bundleFile(sha256, entryId, env) {
  const { workflowBuildStateRoot } = await import('./workflow-build/store.mjs');
  const directory = path.join(path.dirname(workflowBuildStateRoot(env)), 'marketplace-workflows', sha256);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${entryId}.workflow.json`);
}

/**
 * Fetch the workflow bundle `text` names (`market:<ID>/<ENTRY>[@VERSION]`) from the marketplace `root`'s configuration
 * trusts, check it, and save it: `{ file, reference, marketplace: { id, label }, entry: { id, label, version } }`.
 * Read in the approved configuration's scope, as `import preview` reads a marketplace.
 */
export async function fetchMarketplaceWorkflowBundle(root, text, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const [{ parseImportReference, resolveMarketplaceReference }, { configuredMarketplaces }, { fetchRemoteBytes, HARD_REMOTE_MAX_BYTES, REMOTE_ORIGIN_REFUSED, REMOTE_TOO_LARGE },
    { readWorkflowBundle }] = await Promise.all([import('./asset-import.mjs'), import('./marketplace.mjs'), import('./remote-fetch.mjs'), import('./workflow-transfer.mjs')]);
  const reference = parseImportReference(text);
  const catalog = { command: `singularity-flow marketplace catalog --marketplace ${reference.marketplace}`, label: 'See what that marketplace lists now.' };
  const trusted = (await configuredMarketplaces(root))[reference.marketplace];
  if (trusted?.repository) {
    throw refusal(`Marketplace ${reference.marketplace} is a Git repository: its agents become workflows through their conversion review, not as a bundle.`,
      'MARKETPLACE_REPOSITORY_NOT_INDEX', { command: `singularity-flow marketplace browse ${reference.marketplace} --kind agent`, label: 'See its agents, each with the command that makes its workflow.' });
  }
  const { marketplace, entry } = await resolveMarketplaceReference(root, reference, { fetchImpl });
  const name = marketplace.label && marketplace.label !== marketplace.id ? `${marketplace.label} (${marketplace.id})` : marketplace.id;
  if (entry.kind !== 'workflow') {
    throw refusal(`${entry.id} in marketplace ${name} is ${entry.kind === 'agent' ? 'an agent' : `a ${entry.kind}`}, not a workflow.`, 'IMPORT_KIND_INVALID', catalog,
      { kind: entry.kind });
  }
  const maxBytes = Math.min(entry.bytes ?? HARD_REMOTE_MAX_BYTES, HARD_REMOTE_MAX_BYTES);
  const origins = [new URL(marketplace.index).origin, ...marketplace.allowedOrigins];
  let fetched;
  try {
    fetched = await fetchRemoteBytes(entry.url, { maxBytes, fetchImpl, label: `Workflow ${entry.id} of marketplace ${marketplace.id}`, accept: 'application/json', allowedOrigins: origins });
  } catch (error) {
    if (error?.code === REMOTE_ORIGIN_REFUSED) {
      throw refusal(`Workflow ${entry.id} of marketplace ${name} is served from ${error.details.origin}, which this repository does not allow that marketplace to use, so nothing was saved.`,
        'MARKETPLACE_ORIGIN_REFUSED', catalog, { origin: error.details.origin });
    }
    if (error?.code === REMOTE_TOO_LARGE) {
      throw refusal(`Workflow ${entry.id} of marketplace ${name} is larger than ${maxBytes} bytes${entry.bytes ? ', the size its index gives' : ', the most SFlow reads'}, so nothing was saved.`,
        'MARKETPLACE_WORKFLOW_TOO_LARGE', catalog, { maxBytes });
    }
    throw error;
  }
  if (fetched.sha256 !== entry.sha256) {
    throw refusal(`Workflow ${entry.id} ${entry.version} of marketplace ${name} is not the bundle its index pins, so nothing was saved or imported. Tell the marketplace's owner.`,
      'MARKETPLACE_CONTENT_MISMATCH', catalog);
  }
  const file = await bundleFile(fetched.sha256, entry.id, env);
  const partial = `${file}.${process.pid}.partial`;
  await writeFile(partial, fetched.bytes, { mode: 0o600 });
  await rename(partial, file);
  try {
    await readWorkflowBundle(file);
  } catch (error) {
    // The folder is this digest's alone, so nothing of a bundle that cannot be imported is kept.
    await rm(path.dirname(file), { recursive: true, force: true });
    throw refusal(`Workflow ${entry.id} of marketplace ${name} is not a workflow bundle SFlow can import, so nothing was kept: ${String(error?.message ?? error).split('\n')[0]}`,
      'MARKETPLACE_WORKFLOW_INVALID', catalog);
  }
  return { file, reference: reference.display, marketplace: { id: marketplace.id, label: marketplace.label ?? marketplace.id },
    entry: { id: entry.id, label: entry.label ?? entry.id, version: entry.version } };
}
