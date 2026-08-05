import {
  commitAndPublish, loadWorkflow, resolveWorkItem, saveWorkflow, syncPublication, validateWorkflow,
  workflowPath
} from './state.mjs';
import {
  commitInitiativeChange, initiativeStatePath, loadInitiative, saveInitiative, syncInitiativePublication
} from './initiative-state.mjs';
import {
  appendLedgerIntent, ledgerStatus, reconcileLedger, verifyLedger
} from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { createHash } from 'node:crypto';
import { branch, head } from './git.mjs';
import {
  activateWorkspaceContext, readActiveWorkspaceContext
} from './workspace-context.mjs';
import { loadSession } from './session.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function subjectRevision(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function revision(root, aggregate, statePath) {
  return {
    branch: branch(root),
    head: head(root),
    subjectRevision: subjectRevision(aggregate),
    statePath
  };
}

export const STATE_REVISION = Symbol.for('singularity-flow.state-revision');

function attachRevision(aggregate, value) {
  if (aggregate && typeof aggregate === 'object') {
    Object.defineProperty(aggregate, STATE_REVISION, { value, configurable: true, writable: true, enumerable: false });
  }
  return aggregate;
}

/**
 * Narrow Story state boundary. Story semantics remain in state.mjs; callers that
 * orchestrate multiple state planes depend on this surface instead of duplicating
 * filesystem and publication details.
 */
export class StoryStateStore {
  constructor(root, definition) {
    this.root = root;
    this.definition = definition;
  }

  async load(id) {
    const aggregate = await loadWorkflow(this.root, this.definition, id);
    const resolvedId = aggregate.workItem?.id;
    const current = revision(this.root, aggregate, workflowPath(this.root, this.definition, resolvedId));
    attachRevision(aggregate, current);
    return { aggregate, revision: current };
  }
  async loadAggregate(id) { return (await this.load(id)).aggregate; }
  resolve(reference, options) { return resolveWorkItem(this.root, this.definition, reference, options); }
  save(workflow) { return saveWorkflow(this.root, this.definition, workflow); }
  publish(workflow, event, message, paths = []) {
    return commitAndPublish(this.root, this.definition, workflow, event, message, paths);
  }
  sync(workflow) { return syncPublication(this.root, this.definition, workflow); }
  validate(workflow, options) { return validateWorkflow(this.root, this.definition, workflow, options); }
}

/**
 * Initiative state has different evidence, approval, invalidation, and concurrency
 * rules and therefore deliberately has its own interface.
 */
export class InitiativeStateStore {
  constructor(root, portfolio) {
    this.root = root;
    this.portfolio = portfolio;
  }

  async load(id) {
    const loaded = await loadInitiative(this.root, id, this.portfolio);
    const aggregate = loaded.initiative;
    const definition = this.portfolio ?? loaded.portfolio;
    this.portfolio ??= definition;
    const current = revision(
      this.root,
      aggregate,
      initiativeStatePath(this.root, definition, id)
    );
    attachRevision(aggregate, current);
    return { aggregate, revision: current, definition };
  }
  async loadAggregate(id) { return (await this.load(id)).aggregate; }
  save(initiative) { return saveInitiative(this.root, this.portfolio, initiative); }
  publish(initiative, event, message, options) {
    return commitInitiativeChange(this.root, this.portfolio, initiative, event, message, options);
  }
  sync(initiative) { return syncInitiativePublication(this.root, this.portfolio, initiative); }
}

/**
 * Local selection is deliberately not lifecycle authority. It only chooses which
 * governed aggregate a surface should open next.
 */
export class LocalContextStore {
  constructor(root, { registryFile = null, selectionFile = null } = {}) {
    this.root = root;
    this.registryFile = registryFile;
    this.selectionFile = selectionFile;
  }

  session(options) { return loadSession(this.root, options); }
  workspace(options) {
    if (!this.registryFile || !this.selectionFile) return Promise.resolve(null);
    return readActiveWorkspaceContext(this.selectionFile, this.registryFile, options);
  }
  selectWorkspace(reference, options) {
    if (!this.registryFile || !this.selectionFile) throw new Error('Workspace registry and selection files are required.');
    return activateWorkspaceContext(this.registryFile, this.selectionFile, reference, options);
  }
}

export async function loadStoryAggregate(root, definition, id) {
  return new StoryStateStore(root, definition).loadAggregate(id);
}

export async function loadInitiativeAggregate(root, id, portfolio = null) {
  const loaded = await new InitiativeStateStore(root, portfolio).load(id);
  // Preserve the established Initiative helper contract used by CLI/editor
  // orchestration while the store itself exposes the aggregate directly.
  return {
    portfolio: loaded.definition,
    initiative: loaded.aggregate,
    revision: loaded.revision
  };
}

/**
 * Append-only sink shared by both stores. Disabled configurations are a true no-op.
 */
export class LedgerSink {
  constructor(root, config = {}) {
    this.root = root;
    this.config = normalizeLedgerConfig(config);
  }

  append(intent, publishedCommit) {
    if (!this.config.enabled) return Promise.resolve({ enabled: false, skipped: true });
    return appendLedgerIntent(this.root, this.config, intent, publishedCommit);
  }
  reconcile(options) { return reconcileLedger(this.root, this.config, options); }
  status() { return ledgerStatus(this.root, this.config); }
  verify() {
    if (!this.config.enabled) return Promise.resolve({ enabled: false, valid: true, skipped: true });
    return verifyLedger(this.root, this.config);
  }
}

// Application surfaces import lifecycle operations through this gateway. The
// domain engines remain separate aggregates; this export boundary prevents CLI,
// doctor, and editor orchestration from reaching around the stores and silently
// reintroducing a second state-access path.
export {
  commitAndPublish, loadWorkflow, resolveWorkItem, saveWorkflow, syncPublication,
  validateWorkflow, workflowPath
};
export {
  approvePhase, assertNoPendingPublication, cancelWorkflow, CONFIG_PATH, createWorkflow, currentPhase,
  loadConfig, preparePhase, preparePhaseInputs, publishGeneration,
  reconcilePhaseTelemetry, registerArtifact, rejectPhase, reopenWorkflow, scanArtifacts,
  storyPublicationPending, submitPhase, validateId, workflowBranchAllowed,
  workflowPublicationBranch, workDir
} from './state.mjs';
export {
  commitInitiativeChange, initiativeStatePath, loadInitiative, saveInitiative,
  syncInitiativePublication
};
export {
  availableInitiativeOutputs, createInitiative, initiativeApplicabilityState,
  initiativeProgress, initiativeStartPreflight, listInitiatives,
  prepareInitiativePhase, restartInitiative, secureInitiativePath,
  selectInitiativePhaseOutputs, setInitiativeApplicability, validateInitiativeId
} from './initiative-state.mjs';
