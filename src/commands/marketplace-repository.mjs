/**
 * `marketplace add <ID> --repo <URL|FOLDER> [--ref BRANCH|TAG]` and `marketplace browse <ID>` for a marketplace that
 * is a Git repository with an APM manifest at its root (src/marketplace-repository.mjs). Adding reads the repository
 * once, at `--ref` (else its default branch), to check it is a marketplace and to pin the commit it is read at; the
 * pin is a reviewed configuration change, made exactly as `marketplace add --index` makes one. Browsing reads it at
 * that pinned commit and lists its agents, each one a workflow, and its skills, each importable on its own.
 */
import path from 'node:path';
import { invocationDirectory, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

/** A `--repo` value as configuration holds it: a URL as given, a folder as its absolute path. */
export function repositoryArgument(value, base = invocationDirectory()) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new SingularityFlowError('--repo needs the marketplace\'s Git repository: an https or ssh URL, or a folder that holds a clone.', { code: 'MARKETPLACE_ADD_USAGE' });
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) || /^[^/@:\s]+@[^/:\s]+:/u.test(raw) || /^[A-Za-z]:[\\/]/u.test(raw)) return raw;
  return path.resolve(base, raw).replace(/[\\/]+$/u, '');
}

const counted = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Add: read the repository at `--ref`, then trust it at that commit through the reviewed configuration change. */
export async function addRepositoryMarketplace(root, id, options, { applyImportChangeSet, emitImportMutation }) {
  for (const key of ['index', 'allowed-origin']) {
    if (options[key] !== undefined) throw new SingularityFlowError(`A marketplace is a Git repository (--repo) or an index (--index), not both: leave out --${key}.`, { code: 'MARKETPLACE_ADD_USAGE' });
  }
  const [{ marketplaceRepositoryValue }, { readMarketplaceRepository }] = await Promise.all([import('../marketplace.mjs'), import('../marketplace-repository.mjs')]);
  const repository = marketplaceRepositoryValue(repositoryArgument(optionString(options, 'repo')), '--repo');
  const ref = optionString(options, 'ref') ?? null;
  const catalog = await readMarketplaceRepository({ id, repository, ref });
  // The same repository again moves its pin to the commit read now: trusting a newer commit is this same command.
  const { configuredMarketplaces } = await import('../marketplace.mjs');
  const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
  const current = (await withApprovedConfigurationRead(root, () => configuredMarketplaces(root), { preferAuthority: true }))[id] ?? null;
  const repin = current?.repository === repository;
  if (repin && current.commit === catalog.commit) {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'marketplace-unchanged', marketplace: current }, null, 2));
    return console.log(`Marketplace ${id} is already read at ${catalog.commit.slice(0, 12)}, the commit ${ref ?? 'its default branch'} is at now. Nothing changed.`);
  }
  const change = { op: 'marketplace.add', id, label: optionString(options, 'label') ?? current?.label ?? catalog.name ?? undefined, repository, ...(ref ? { ref } : {}),
    commit: catalog.commit, ...(repin ? { repin: true } : {}) };
  const { STUDIO_CHANGE_SET_SCHEMA } = await import('../workflow-studio.mjs');
  const result = await applyImportChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [change] }, options, {
    subject: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ? id : 'marketplace',
    message: `[configuration] trust marketplace ${id} (${repository} at ${catalog.commit.slice(0, 12)})`
  });
  const agents = catalog.packages.filter((entry) => entry.kind === 'agent').length;
  const skills = catalog.packages.filter((entry) => entry.kind === 'skill').length;
  // Reading a trusted marketplace's newest commit also says which workflows made from its agents changed there, so
  // their updates are reviewed now rather than found later (MCR §8). The person asked for this read.
  const updates = repin ? (await withApprovedConfigurationRead(root, async () => (await import('../asset-import.mjs')).marketplaceWorkflowChecks(root, id),
    { preferAuthority: true }).catch(() => [])).filter((row) => row.updateCommand) : [];
  if (!optionBoolean(options, 'json')) {
    console.log(`${catalog.name ?? id} at ${ref ?? 'its default branch'} (commit ${catalog.commit.slice(0, 12)}): ${counted(agents, 'agent')}, ${counted(skills, 'skill')}`
      + `${catalog.packages.length - agents - skills ? `, ${counted(catalog.packages.length - agents - skills, 'other package')}` : ''}.`);
    for (const problem of catalog.problems.slice(0, 10)) console.log(`  Note: ${problem}`);
    for (const row of updates) console.log(`  Workflow ${row.key.replace(/^workflow:/u, '')}: ${row.words ?? row.detail}. Review its update: ${row.updateCommand}`);
  }
  // What Workflow Studio's Trust form queues from a dry run: the label and the commit read now, with no second read.
  return emitImportMutation(root, { ...result, marketplace: { id, label: change.label ?? null, repository, ref, commit: catalog.commit, ...(repin ? { repin: true } : {}), agents, skills },
    ...(updates.length ? { updates } : {}) }, options, {
    operation: 'marketplace.add', messageId: 'marketplace.added', slots: { id }
  });
}

/** Browse: the agents and skills at the pinned commit, with what each one's own apm.yml says. */
export async function browseRepositoryMarketplace(marketplace, options) {
  const { marketplaceRepositoryView, readMarketplaceRepository } = await import('../marketplace-repository.mjs');
  const kind = optionString(options, 'kind') ?? null;
  if (kind && !['agent', 'skill', 'prompt', 'instructions', 'hybrid', 'other', 'unknown'].includes(kind)) {
    throw new SingularityFlowError(`--kind is agent or skill (or prompt, instructions, hybrid): '${kind}'.`, { code: 'MARKETPLACE_BROWSE_USAGE' });
  }
  const catalog = await readMarketplaceRepository(marketplace);
  // Each entry also as an index entry reads (id, label, importable), so Workflow Studio's list shows it as it is. An agent
  // becomes a workflow; a skill is imported on its own, into the skill master, through the same preview and review as any
  // import (`import preview "market:<id>/<skill>" --as skill`, read at the pinned commit).
  const entries = marketplaceRepositoryView(catalog, { kind, search: optionString(options, 'search') }).map((entry) => {
    const importable = entry.kind === 'skill' && Boolean(entry.document);
    const reference = `market:${marketplace.id}/${entry.name}`;
    return {
      ...entry, id: entry.name, label: entry.name, importable,
      ...(importable ? { importReference: reference, previewCommand: `singularity-flow import preview ${JSON.stringify(reference)} --as skill` } : {}),
      ...(entry.kind === 'agent' ? { workflowCommand: `singularity-flow workflow from-agent ${marketplace.id}/${entry.name}` } : {})
    };
  });
  if (optionBoolean(options, 'json')) {
    return console.log(JSON.stringify({
      schemaVersion: 1, resultType: 'marketplace-entries',
      marketplace: { ...marketplace, name: catalog.name, description: catalog.description, owner: catalog.owner, commit: catalog.commit, channel: catalog.channel ?? null,
        channels: catalog.channels ?? {} },
      entries, problems: catalog.problems
    }, null, 2));
  }
  console.log(`${catalog.name ?? marketplace.label}${catalog.owner ? ` by ${catalog.owner}` : ''} (${marketplace.repository} at ${catalog.commit.slice(0, 12)}`
    + `${catalog.channel ? `, its ${catalog.channel} channel` : ''}): ${counted(entries.length, 'entry', 'entries')}.`);
  for (const entry of entries) {
    console.log(`  ${entry.kind.padEnd(6)} ${entry.name}${entry.version ? `@${entry.version}` : ''}${entry.lifecycleState ? ` [${entry.lifecycleState}]` : ''}`);
    if (entry.description) console.log(`         ${entry.description}`);
    const facts = [
      entry.type && entry.type !== entry.kind ? `type ${entry.type}` : null,
      entry.pdlcPhases.length ? `phases ${entry.pdlcPhases.join(', ')}` : null,
      entry.pdlcTasks.length ? `tasks ${entry.pdlcTasks.join(', ')}` : null,
      entry.tags.length ? `tags ${entry.tags.join(', ')}` : null,
      entry.skills.length ? `skills ${entry.skills.join(', ')}` : null
    ].filter(Boolean);
    if (facts.length) console.log(`         ${facts.join(' · ')}`);
    // Its owner and its lifecycle, with who and when [OMK:REQ-015].
    const lifecycle = entry.lifecycleRecord;
    console.log(`         ${[entry.owner?.words, lifecycle ? `Lifecycle: ${lifecycle.words}` : 'No lifecycle recorded', lifecycle?.guardWords].filter(Boolean).join(' · ')}`);
    for (const finding of (entry.findings ?? []).slice(0, 3)) console.log(`         For the marketplace: ${finding.words}`);
    if (entry.workflowCommand) console.log(`         As a workflow: ${entry.workflowCommand}`);
    if (entry.previewCommand) console.log(`         As a skill on its own: ${entry.previewCommand}`);
  }
  for (const problem of catalog.problems.slice(0, 10)) console.log(`Note: ${problem}`);
}
