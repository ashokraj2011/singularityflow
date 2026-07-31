import {
  commitAndPublish, loadWorkflow, resolveWorkItem, saveWorkflow, syncPublication, validateWorkflow
} from './state.mjs';
import {
  commitInitiativeChange, loadInitiative, saveInitiative, syncInitiativePublication
} from './initiative-state.mjs';
import {
  appendLedgerIntent, ledgerStatus, reconcileLedger, verifyLedger
} from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';

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

  load(id) { return loadWorkflow(this.root, this.definition, id); }
  resolve(reference, options) { return resolveWorkItem(this.root, this.definition, reference, options); }
  save(workflow) { return saveWorkflow(this.root, this.definition, workflow); }
  publish(workflow, message, paths = []) {
    return commitAndPublish(this.root, this.definition, workflow, message, paths);
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

  load(id) { return loadInitiative(this.root, id, this.portfolio); }
  save(initiative) { return saveInitiative(this.root, this.portfolio, initiative); }
  publish(initiative, message, options) {
    return commitInitiativeChange(this.root, this.portfolio, initiative, message, options);
  }
  sync(initiative) { return syncInitiativePublication(this.root, this.portfolio, initiative); }
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
