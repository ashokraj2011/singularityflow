/** Shared author/reviewer rubric. Guidance only: never a semantic verdict or mutation authority. */
export const REQUIREMENT_COVERAGE = Object.freeze({
  revision: 'requirement-coverage-v1',
  mapping: 'source-obligation -> REQ/AC -> observable assertion -> verification intent',
  surfaces: Object.freeze(['UI', 'API', 'event/message', 'batch/job', 'CLI', 'library', 'mixed']),
  acceptanceCriteriaCount: true,
  pinnedConstraintsTakePrecedence: true,
  separateRequirementPerObligation: false,
  coverageIsExecution: false,
  repair: 'current editable draft; returned repairLoop budget and authority',
  reviewerEditsArtifact: false
});

export const REQUIREMENT_AUTHORING_PROTOCOL = [
  '- Requirement completeness: read pinned sources, attachments and recorded answers; split compound requests into independently observable obligations before drafting. Identify only the affected interfaces supported by that evidence: UI, API, event/message, batch/job, CLI, library or mixed. Observable means a specified response, state change, event, file, job result or UI behavior, not necessarily a screen. Do not invent interfaces, controls, endpoints, error wording, limits or evidence requirements.',
  '- Obligation coverage: record a compact source obligation -> REQ/AC -> observable assertion -> verification intent mapping in the artifact\'s existing traceability/scenario sections. Every requested behavior, explicit interface commitment, constraint and evidence obligation needs coverage or an authorized human decision. Existing acceptance criteria count; related obligations may share a clause unless the pinned contract requires separation. Honor explicit pinned constitution/template constraints. No duplicate REQ, separate scenario per noun or new mandatory table is required by this rubric. A control mentioned only as an action precondition may leave its required availability implicit: check the whole normative specification before adding anything.',
  '- Self-check and repair: could an implementation satisfy this draft while omitting something explicitly requested? Repair clear omissions in this editable draft before prepublish; update affected clauses, scenarios and verification intent together. Reuse settled answers. For a material ambiguity or scope change, follow the pinned clarification/decision route, never invent a disposition. Do not repair application code in a requirements-only phase or edit a published/earlier artifact; use its authorized successor or upstream route.',
  '- Repair continuation: follow the returned repairLoop.protocol and configured budget; recheck changed content and continue the returned next action when ready. Never retry unchanged content, restart a spent automation budget or treat preparation as completion. On exhaustion preserve the draft and report remaining findings with the exact recovery route; manual repair remains available under the existing policy. Coverage is not execution: tests/screenshots are requirements until genuine results exist. Keep the mapping in the artifact, not a pasted document or code dump in chat.'
].join('\n');

export const REQUIREMENT_REVIEW_PROTOCOL = [
  '- Requirement review calibration: assess each explicit source obligation against the whole normative artifact, including acceptance criteria and pinned answers. Honor explicit pinned constitution, template and review constraints; never waive them. Otherwise related obligations may share clauses; do not invent duplicate REQs, a separate scenario per noun or particular wording. Use the source-supported interface (UI, API, event/message, batch/job, CLI, library or mixed), not a universal UI/API checklist.',
  '- Material findings: before calling an obligation missing, identify the exact source commitment, consider the existing REQ/AC coverage, and explain how an implementation could satisfy that coverage yet violate the request. A genuine omission, contradiction or unverifiable obligation remains blocking; clearer wording without a changed required outcome is advisory. A screenshot/test obligation is not execution evidence. Remain independent: never rewrite the reviewed artifact or waive real gaps; repair only your own report-format/citation errors within the returned budget.'
].join('\n');

function appendOnce(text, protocol) {
  return typeof text !== 'string' || text.includes(protocol) ? text : `${text.trimEnd()}\n\n${protocol}\n`;
}

/** Old pinned/cached prompts gain current guidance at delivery, without rewriting their bytes. */
export function withRequirementAuthoringProtocol(text, enabled = true) {
  return enabled ? appendOnce(text, REQUIREMENT_AUTHORING_PROTOCOL) : text;
}

export function withRequirementReviewProtocol(text) {
  return appendOnce(text, REQUIREMENT_REVIEW_PROTOCOL);
}

/** Initiative producers declare scope through outputs, not a familiar phase name. */
export function initiativeGathersRequirements(phase) {
  return Boolean(phase?.outputs?.some(output => ['requirements', 'requirements-specification', 'nfr-specification'].includes(output.id)
    || ['requirements', 'implementation-spec'].includes(output.kind)));
}
