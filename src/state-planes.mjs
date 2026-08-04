import { branch, head } from './git.mjs';
import { ledgerStatus } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { readPendingPublication } from './publication-pending.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { LocalContextStore, StoryStateStore, InitiativeStateStore } from './state-stores.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { inspectProjections, repairProjections } from './projectors.mjs';

export async function inspectStatePlanes(root, {
  definition,
  portfolio = null,
  reference = null,
  kind = null,
  offline = true
} = {}) {
  const index = await buildRepositorySubjectIndex(root, { definition, portfolio });
  const context = resolveContext(index, {
    reference: reference ?? branch(root),
    kind,
    required: true
  });
  const local = new LocalContextStore(root, {
    registryFile: workspaceRegistryFile(),
    selectionFile: activeWorkspaceFile()
  });
  const [session, workspace] = await Promise.all([
    local.session({ required: false }),
    local.workspace({ refresh: false }).catch(() => null)
  ]);
  let loaded;
  if (context.kind === 'story') {
    loaded = await new StoryStateStore(root, definition).load(context.id);
  } else {
    loaded = await new InitiativeStateStore(root, portfolio).load(context.id);
  }
  const projectionItems = await inspectProjections(root, {
    kind: context.kind,
    aggregate: loaded.aggregate,
    definition,
    portfolio
  });
  const staleProjections = projectionItems.filter((item) => !item.current);
  const projectionSummaries = projectionItems.map(({ content: _content, ...item }) => item);
  const ledgerConfig = normalizeLedgerConfig(
    context.kind === 'story' ? definition?.ledger : portfolio?.ledger
  );
  const [pending, ledger] = await Promise.all([
    // The configured roots, so this agrees with the mutation paths. Without them `state planes`
    // reported healthy while every mutation refused, and `doctor` printed both verdicts at once.
    readPendingPublication(root, {
      kind: context.kind,
      id: context.id,
      roots: { workItemRoot: definition?.workItemRoot, initiativeRoot: portfolio?.initiativeRoot },
      migrate: false
    }),
    ledgerStatus(root, ledgerConfig, { offline }).catch((error) => ({
      enabled: ledgerConfig.enabled,
      error: error.message,
      config: ledgerConfig
    }))
  ]);
  return {
    schemaVersion: 1,
    subject: {
      kind: context.kind,
      id: context.id,
      canonicalBranch: context.canonicalBranch,
      selectedBranch: context.selectedBranch
    },
    lifecycle: {
      authority: 'lifecycle-branch',
      branch: branch(root),
      head: head(root),
      statePath: loaded.revision.statePath,
      revision: loaded.revision
    },
    localContext: {
      authority: 'selection-only',
      session: session ? { workId: session.workId ?? null, agent: session.agent ?? null } : null,
      workspace: workspace ? {
        workspaceId: workspace.workspaceId,
        repositoryId: workspace.repositoryId,
        storyId: workspace.storyId ?? null
      } : null
    },
    publicationRecovery: {
      authority: 'local-control-plane',
      pending: Boolean(pending),
      record: pending?.record ?? null
    },
    ledger: {
      authority: 'proof-and-mirror',
      ...ledger
    },
    projections: {
      authority: 'derived',
      status: projectionSummaries.find((item) => item.id === 'status'),
      total: projectionItems.length,
      current: projectionItems.length - staleProjections.length,
      stale: staleProjections.length,
      items: projectionSummaries
    },
    healthy: !pending && staleProjections.length === 0 && !ledger.error
      && (!ledgerConfig.enabled || ((ledger.outbox ?? 0) === 0 && (ledger.pending?.length ?? 0) === 0))
  };
}

export async function reconcileStateProjections(root, options = {}) {
  const planes = await inspectStatePlanes(root, options);
  if (planes.projections.stale === 0 || !options.repair) return { repaired: false, repairedPaths: [], planes };
  const index = await buildRepositorySubjectIndex(root, {
    definition: options.definition,
    portfolio: options.portfolio
  });
  const context = resolveContext(index, {
    reference: options.reference ?? branch(root),
    kind: options.kind,
    required: true
  });
  let loaded;
  if (context.kind === 'story') {
    loaded = await new StoryStateStore(root, options.definition).load(context.id);
  } else {
    loaded = await new InitiativeStateStore(root, options.portfolio).load(context.id);
  }
  const items = await inspectProjections(root, {
    kind: context.kind,
    aggregate: loaded.aggregate,
    definition: options.definition,
    portfolio: options.portfolio
  });
  const repairedPaths = await repairProjections(root, items);
  return {
    repaired: repairedPaths.length > 0,
    repairedPaths,
    repairedPath: repairedPaths.length === 1 ? repairedPaths[0] : null,
    planes: await inspectStatePlanes(root, options)
  };
}
