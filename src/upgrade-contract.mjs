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
  'transition-publication-repair':
    'A phase transition finishes a Story\'s retained publication instead of refusing it.'
});

const guided = (healedBy = null) => Object.freeze({ resolution: 'guided', ...(healedBy ? { healedBy } : {}) });
const integrity = (reason) => Object.freeze({ resolution: 'integrity', reason });
const development = (reason) => Object.freeze({ resolution: 'development', reason });
const unrelated = (reason) => Object.freeze({ resolution: 'unrelated', reason });
// A step's version (SPEC-OSA v1.1): the numbered drafts of one step and the person's yes that opens the next one.
const stepVersion = (what) => unrelated(`${what}, a step's own version, not a build or schema version.`);

export const UPGRADE_CONTRACT = Object.freeze({
  // An installed build meets these at runtime: each has an exact step in refusal-remediation.
  SCHEMA_VERSION_FUTURE: guided('product-alignment'),
  SCHEMA_VERSION_ARCHIVED: guided(),
  DOCS_MANIFEST_MISMATCH: guided('product-alignment'),
  // The registered World Model and its commands were removed; the refusal points to the Repository brief.
  WMB_REMOVED: guided(),
  COMMAND_REMOVED: guided(),
  WFA_RUNTIME_INCOMPATIBLE: guided(),
  WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED: guided(),
  CONVERGENCE_LEGACY_MIGRATION_REQUIRED: guided(),
  GENERATION_PUBLICATION_MIGRATION_REQUIRED: guided(),
  LEGACY_PERSONA_MIGRATION_UNSAFE: guided(),
  REPOSITORY_ONBOARDING_MIGRATION_SOURCE_MISSING: guided(),
  PRODUCT_ALIGNMENT_INSTALL_ACTIVE: guided(),
  PRODUCT_ALIGNMENT_INSTALL_RECOVERY_PENDING: guided(),
  // A legacy installation receipt is upgraded only by a full source install with no recovery pending.
  INSTALL_RECEIPT_UPGRADE_NOT_ADMITTED: guided(),
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
  AUTO_CONTEXT_MANIFEST_MISMATCH: integrity('A model transport receipt differs from the admitted Auto prompt.'),

  // Development and release gates: never reached by an installed build at runtime.
  NARRATION_MIGRATION_INCOMPLETE: development('The narration ratchet, checked when the product is built.'),
  UNVERSIONED_ARGUMENT_SCHEMA: development('A gateway argument schema declared without a version.'),
  GDP_GA_MIGRATION_EXERCISES_MISSING: development('A release-qualification exercise set.'),
  SCHEMA_UPGRADE_REGISTRY_REQUIRED: development('An API misuse: the schema audit was called without a registry.'),
  SCHEMA_UPGRADE_OPTIONS_INVALID: development('An API misuse: invalid schema-upgrade options.'),

  // The name matches, the meaning does not.
  WORKSPACE_ARCHIVED: unrelated('An archived workspace, not an archived schema.'),
  WORKFLOW_ARCHIVED: unrelated('An archived workflow a new Story may not choose, not an archived schema.'),
  MODEL_SESSION_INCOMPATIBLE: unrelated('A prompt that differs from its model session\'s provider, model or tool policy, not a build or schema version.'),
  SPEC_DRAFT_VERSION_MISSING: unrelated('A saved version of a person\'s draft, not a build or schema version.'),
  SPEC_ORIGIN_VERSION_CONFLICT: unrelated('Two versions of a parent specification chosen at once, not a build or schema version.'),
  PHASE_VERSION_BEING_WRITTEN: stepVersion('A step whose next version is being written'),
  REVIEW_DELEGATION_VERSION_MISMATCH: stepVersion('A review delegated for another version of the step than the one kept'),
  VERSION_CONSENT_DECLINED: stepVersion('The person did not say yes to starting the next version'),
  VERSION_CONSENT_EXPIRED: stepVersion('The person\'s yes to starting the next version expired'),
  VERSION_CONSENT_PRINCIPAL_CHANGED: stepVersion('Another person gave the yes to starting the next version'),
  // An opening an older build kept on one checkout only meets this too; its refusal names the step's preview, which asks
  // the person, so it is guided by its own route [OSA:REQ-030].
  VERSION_CONSENT_REQUIRED: stepVersion('The next version opens only on the person\'s yes'),
  VERSION_CONSENT_UNVERIFIED: stepVersion('A yes to the next version that did not reach SFlow on this machine'),
  VERSION_CONSENT_WRONG_TARGET: stepVersion('A yes given for another proposal than the next version as it is now'),
  VERSION_OPENING_CONFLICT: stepVersion('Another checkout changed the shared branch before this opening of the next version'),
  VERSION_OPENING_NOT_SHARED: stepVersion('An opening commit of the next version that is no longer on the branch'),
  VERSION_QUESTION_NOT_TYPED: stepVersion('"Just a question" for a next version proposed for something the person did not type')
});

/** Transition refusals raised by a sequence gate rather than a code. */
export const UPGRADE_TRANSITION_GATES = Object.freeze({
  publicationPending: Object.freeze({ resolution: 'guided', healedBy: 'transition-publication-repair' })
});
