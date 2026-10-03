/**
 * No version issue: every refusal an upgrade or a phase transition can reach is either repaired
 * automatically or guided to one exact next step.
 *
 * Version-sensitive codes are found mechanically: every error code in src/ whose name says it is
 * about a version, a migration, an upgrade, or an earlier or newer build. Each one is classified
 * here. test/upgrade-contract.test.mjs fails for a code that is not classified, and for a guided
 * code whose remediation has no exact step, so a new version-sensitive refusal cannot ship as a
 * bare error.
 */

export const VERSION_SENSITIVE_CODE = /(VERSION|MIGRATION|UPGRADE|NEWER|EARLIER_BUILD|COMPATIB|OUTDATED|FUTURE|ARCHIVED|MANIFEST_MISMATCH)/u;

/** Repairs that remove a condition before it becomes a refusal. */
export const AUTOMATIC_UPGRADE_REPAIRS = Object.freeze({
  'product-alignment':
    'Every product surface is brought to the installed build on a new build\'s first run and in VS Code.',
  'reviewed-registry-admission':
    'A World Model from an earlier reviewed build stays readable, and current when every change since was mechanical.',
  'transition-publication-repair':
    'A phase transition finishes a Story\'s retained publication instead of refusing it.'
});

const guided = (healedBy = null) => Object.freeze({ resolution: 'guided', ...(healedBy ? { healedBy } : {}) });
const integrity = (reason) => Object.freeze({ resolution: 'integrity', reason });
const development = (reason) => Object.freeze({ resolution: 'development', reason });
const unrelated = (reason) => Object.freeze({ resolution: 'unrelated', reason });

export const UPGRADE_CONTRACT = Object.freeze({
  // An installed build meets these at runtime: each has an exact step in refusal-remediation.
  SCHEMA_VERSION_FUTURE: guided('product-alignment'),
  SCHEMA_VERSION_ARCHIVED: guided(),
  DOCS_MANIFEST_MISMATCH: guided('product-alignment'),
  WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE: guided('reviewed-registry-admission'),
  WMB_MIGRATION_REQUIRED: guided(),
  WMB_VIEW_VERSION_UNSUPPORTED: guided(),
  WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED: guided(),
  CONVERGENCE_LEGACY_MIGRATION_REQUIRED: guided(),
  GENERATION_PUBLICATION_MIGRATION_REQUIRED: guided(),
  LEGACY_PERSONA_MIGRATION_UNSAFE: guided(),
  REPOSITORY_ONBOARDING_MIGRATION_SOURCE_MISSING: guided(),
  PRODUCT_ALIGNMENT_INSTALL_ACTIVE: guided(),
  PRODUCT_ALIGNMENT_INSTALL_RECOVERY_PENDING: guided(),
  PRODUCT_ALIGNMENT_STEP_FAILED: guided(),
  PRODUCT_ALIGNMENT_VERIFICATION_FAILED: guided(),
  // A governance rebuild archived the Story on purpose; the refusal says what to do instead.
  STORY_ARCHIVED_BY_REBUILD: guided(),

  // Integrity: the stored bytes do not verify. Failing closed is the product working.
  SCHEMA_MIGRATION_SOURCE_CORRUPT: integrity('The stored record does not verify; migrating it would launder corruption.'),
  SCHEMA_MIGRATION_INVALID: integrity('A registered migration produced an invalid record; this is a product defect, never data to heal.'),
  SCHEMA_MIGRATION_NONDETERMINISTIC: integrity('A registered migration is not deterministic; this is a product defect.'),
  SCHEMA_VERSION_MISSING: integrity('A durable record without a schema version cannot be classified.'),
  SCHEMA_VERSION_INVALID: integrity('A schema census finding for a record whose version is not an integer.'),
  WMB_MIGRATION_RECEIPT_INVALID: integrity('A legacy World-Model migration receipt does not verify.'),
  WMB_MIGRATION_SOURCE_INVALID: integrity('A legacy World-Model migration source does not verify.'),
  AUTO_CONTEXT_MANIFEST_MISMATCH: integrity('A model transport receipt differs from the admitted Auto prompt.'),

  // Development and release gates: never reached by an installed build at runtime.
  NARRATION_MIGRATION_INCOMPLETE: development('The narration ratchet, checked when the product is built.'),
  UNVERSIONED_ARGUMENT_SCHEMA: development('A gateway argument schema declared without a version.'),
  GDP_GA_MIGRATION_EXERCISES_MISSING: development('A release-qualification exercise set.'),
  SCHEMA_UPGRADE_REGISTRY_REQUIRED: development('An API misuse: the schema audit was called without a registry.'),
  SCHEMA_UPGRADE_OPTIONS_INVALID: development('An API misuse: invalid schema-upgrade options.'),

  // The name matches, the meaning does not.
  WORKSPACE_ARCHIVED: unrelated('An archived workspace, not an archived schema.')
});

/** Transition refusals raised by a sequence gate rather than a code. */
export const UPGRADE_TRANSITION_GATES = Object.freeze({
  publicationPending: Object.freeze({ resolution: 'guided', healedBy: 'transition-publication-repair' })
});
