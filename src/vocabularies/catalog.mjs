import { defineVocabulary } from './definition.mjs';

const governing = (value, description) => ({
  value,
  class: 'core-governing',
  since: 1,
  status: 'active',
  writeAllowed: true,
  unknownRead: 'preserve-and-restrict',
  description
});

const observational = (value, description) => ({
  value,
  class: 'core-observational',
  since: 1,
  status: 'active',
  writeAllowed: true,
  unknownRead: 'preserve-opaque',
  description
});

/** The sole owner of first-party Story and Initiative lifecycle event members. */
export const LIFECYCLE_EVENT_VOCABULARY = defineVocabulary({
  id: 'lifecycle-event-type',
  version: 3,
  defaultClass: 'core-observational',
  entries: {
    BINDING: governing('binding', 'Binds a governed subject to its lifecycle identity and branch.'),
    CONFIGURATION_CHANGED: governing('configuration-changed', 'Records an authoritative workflow configuration transition.'),
    ARTIFACT_GENERATED: governing('artifact-generated', 'Publishes one governed artifact generation.'),
    APPROVAL_REQUESTED: governing('approval-requested', 'Submits an exact generation for governed approval.'),
    PHASE_APPROVED: governing('phase-approved', 'Records an authorized approval against exact generation evidence.'),
    PHASE_REJECTED: governing('phase-rejected', 'Records an authorized phase rejection.'),
    INTENT_AMENDMENT_PROPOSED: governing('intent-amendment-proposed', 'Proposes an amendment to governed intent.'),
    INTENT_AMENDMENT_APPROVED: governing('intent-amendment-approved', 'Approves a governed intent amendment.'),
    INTENT_AMENDMENT_REJECTED: governing('intent-amendment-rejected', 'Rejects a governed intent amendment.'),
    INTENT_AMENDMENT_ACKNOWLEDGED: governing('intent-amendment-acknowledged', 'Acknowledges the outcome of a governed intent amendment.'),
    WORKFLOW_REOPENED: governing('workflow-reopened', 'Reopens a completed or previously decided workflow boundary.'),
    REWORK_ROLLED_FORWARD: {
      ...governing('rework-rolled-forward', 'Abandons a returned rework cone and restores its exact forward checkpoint.'),
      since: 3
    },
    SEQUENCE_OVERRIDE: governing('sequence-override', 'Records an authorized workflow sequence override.'),
    EVIDENCE_RECORDED: observational('evidence-recorded', 'Records bounded evidence without independently advancing lifecycle authority.'),
    EXTERNAL_SYNCHRONIZED: observational('external-synchronized', 'Records synchronization with an external system.'),
    BRANCH_LINKED: governing('branch-linked', 'Binds an additional governed branch relationship.'),
    TELEMETRY_RECORDED: observational('telemetry-recorded', 'Records bounded telemetry evidence.'),
    PROJECTION_RECONCILED: observational('projection-reconciled', 'Records deterministic projection reconciliation.'),
    IMPACT_CLASSIFIED: governing('impact-classified', 'Records the governed impact classification.'),
    IMPACT_OPTED_OUT: governing('impact-opted-out', 'Records an authorized impact-analysis opt-out.'),
    IMPACT_EXPOSURE_RECORDED: observational('impact-exposure-recorded', 'Records impact exposure evidence.'),
    IMPACT_EVIDENCE_COLLECTED: observational('impact-evidence-collected', 'Records locally collected impact evidence.'),
    IMPACT_EVIDENCE_IMPORTED: observational('impact-evidence-imported', 'Records imported impact evidence.'),
    IMPACT_FINALIZED: governing('impact-finalized', 'Finalizes the governed impact decision.'),
    WORK_CANCELLED: governing('work-cancelled', 'Cancels governed work without claiming completion.'),
    WORK_COMPLETED: governing('work-completed', 'Records governed work completion.'),
    DESIGN_SOURCE_PROMOTED: {
      ...governing('design-source-promoted', 'Promotes a reviewed design source and invalidates dependent authority.'),
      since: 2
    }
  }
});

export const LIFECYCLE_EVENT = LIFECYCLE_EVENT_VOCABULARY.symbols;
