import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { branch, head } from './git.mjs';
import { ledgerStatus } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { readPendingPublication } from './publication-pending.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { LocalContextStore, StoryStateStore, InitiativeStateStore } from './state-stores.mjs';
import { statusPath, storyStatusMarkdown } from './state.mjs';
import { initiativeDir, initiativeStatusMarkdown } from './initiative-state.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { exists, writeText } from './util.mjs';

async function projectionState(file, expected) {
  const actual = await exists(file) ? await readFile(file, 'utf8') : null;
  return { path: file, exists: actual != null, current: actual === expected, expected };
}

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
  let projection;
  if (context.kind === 'story') {
    loaded = await new StoryStateStore(root, definition).load(context.id);
    projection = await projectionState(
      statusPath(root, definition, context.id),
      storyStatusMarkdown(loaded.aggregate)
    );
  } else {
    loaded = await new InitiativeStateStore(root, portfolio).load(context.id);
    projection = await projectionState(
      path.join(initiativeDir(root, portfolio, context.id), 'STATUS.md'),
      initiativeStatusMarkdown(loaded.aggregate)
    );
  }
  const ledgerConfig = normalizeLedgerConfig(
    context.kind === 'story' ? definition?.ledger : portfolio?.ledger
  );
  const [pending, ledger] = await Promise.all([
    readPendingPublication(root, { kind: context.kind, id: context.id }),
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
      status: {
        path: path.relative(root, projection.path).split(path.sep).join('/'),
        exists: projection.exists,
        current: projection.current
      }
    },
    healthy: !pending && projection.current && !ledger.error
      && (!ledgerConfig.enabled || ((ledger.outbox ?? 0) === 0 && (ledger.pending?.length ?? 0) === 0))
  };
}

export async function reconcileStateProjections(root, options = {}) {
  const planes = await inspectStatePlanes(root, options);
  if (planes.projections.status.current || !options.repair) {
    return { repaired: false, planes };
  }
  const index = await buildRepositorySubjectIndex(root, {
    definition: options.definition,
    portfolio: options.portfolio
  });
  const context = resolveContext(index, {
    reference: options.reference ?? branch(root),
    kind: options.kind,
    required: true
  });
  let file;
  let content;
  if (context.kind === 'story') {
    const workflow = await new StoryStateStore(root, options.definition).loadAggregate(context.id);
    file = statusPath(root, options.definition, context.id);
    content = storyStatusMarkdown(workflow);
  } else {
    const initiative = await new InitiativeStateStore(root, options.portfolio).loadAggregate(context.id);
    file = path.join(initiativeDir(root, options.portfolio, context.id), 'STATUS.md');
    content = initiativeStatusMarkdown(initiative);
  }
  await writeText(file, content);
  return {
    repaired: true,
    repairedPath: path.relative(root, file).split(path.sep).join('/'),
    planes: await inspectStatePlanes(root, options)
  };
}
