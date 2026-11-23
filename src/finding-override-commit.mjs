/**
 * Recording a person's override of a check's blocking finding, and the findings the decision list offers for it
 * (finding-overrides.mjs has the rules; owner, 2026-11-23). One function records it for `decision override-finding`,
 * the decision list's `decisions record`, the Decide card and /sf-decide, so every surface checks the same things:
 * - the finding is one the step's own check raises now, and one a person may override;
 * - the person is someone the step's approval rules name;
 * - the reason is their own words.
 */
import { findingOverrideBar, overrideGeneration, overriddenWords, recordFindingOverride } from './finding-overrides.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';

const refused = (message, details = undefined) => { throw new SingularityFlowError(message, { code: 'FINDING_OVERRIDE_INVALID', ...(details ? { details } : {}) }); };
const stepName = (phase) => phase?.label ?? phase?.id;

/** The step's blocking findings now and those already overridden, as its own draft check reads them. */
async function currentFindings(root, config, workflow, phase) {
  const [{ phaseDraftCheck }, { loadSession }] = await Promise.all([import('./phase-draft-check.mjs'), import('./session.mjs')]);
  const check = await phaseDraftCheck(root, config, workflow, phase, { session: await loadSession(root, { required: false }) });
  return { findings: check.findings ?? [], overridden: check.overridden ?? [] };
}

/**
 * What the decision list offers: the current step's blocking findings a person may override, while it is being written,
 * and those already overridden. Null when nothing applies. A code step's findings have their own dispute; a step that
 * is not worked on now has none to override.
 */
export async function findingOverrideFacts(root, config, workflow, phase) {
  try {
    if (!phase || workflow?.status !== 'in_progress' || workflow.currentPhase !== phase.id || phase.status !== 'in_progress') return null;
    const { phaseRequiresCodeDelivery } = await import('./code-delivery-policy.mjs');
    if (phaseRequiresCodeDelivery(phase)) return null;
    const { findings, overridden } = await currentFindings(root, config, workflow, phase);
    const offered = findings.filter((finding) => finding.override?.key).slice(0, 5);
    if (!offered.length && !overridden.length) return null;
    const shape = (finding) => ({ key: finding.override?.key ?? finding.overriddenBy?.key, code: finding.code, path: finding.path ?? null, line: finding.line ?? null,
      value: finding.details?.clauseId ?? finding.value ?? finding.clauseId ?? null, message: String(finding.message ?? '').replace(/\s+/gu, ' ').slice(0, 400) });
    return { phase: phase.id, generation: overrideGeneration(workflow, phase), findings: offered.map(shape),
      overridden: overridden.map((finding) => ({ ...shape(finding), by: finding.overriddenBy?.by ?? null, reason: finding.overriddenBy?.reason ?? null })) };
  } catch { return null; }
}

/** Record the override of `key` on step `phaseId` with the person's reason, in its own Story commit, and say what it changes. */
export async function commitFindingOverride(root, config, workflow, { phaseId, key, reason }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const phase = workflow.phases?.[phaseId] ?? null;
  const list = { command: `singularity-flow decisions ${id}`, label: 'See the findings you may override, on the decision list' };
  if (workflow.status !== 'in_progress' || !phase) {
    refused(`Story ${id} is ${workflow.status}${phase ? '' : ` and has no step '${phaseId}'`}; a finding is overridden while its step is worked on.`, { nextAction: list });
  }
  if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress') {
    refused(`${stepName(phase)} is not the step being worked on now (it is ${phase.status}), so none of its findings is overridden from here. Its approvers may still return it.`, { nextAction: list });
  }
  const named = String(key ?? '').trim();
  const { findings, overridden } = await currentFindings(root, config, workflow, phase);
  const done = overridden.find((entry) => entry.overriddenBy?.key === named);
  if (done) refused(`${overriddenWords(done)} Nothing else to record.`, { nextAction: list });
  const finding = findings.find((entry) => entry.override?.key === named);
  if (!finding) {
    const offered = findings.filter((entry) => entry.override?.key).map((entry) => `${entry.override.key} (${entry.code})`);
    const barred = findings.filter((entry) => !entry.override?.key).map((entry) => `${entry.code}: ${findingOverrideBar(entry) ?? 'its own route'}`);
    refused(`${stepName(phase)} has no blocking finding ${named || '(none named)'} now.${offered.length ? ` Its findings you may override: ${offered.join(', ')}.` : ' None of its findings is one you override here.'}`
      + `${barred.length ? ` Not overridden here: ${barred.slice(0, 5).join('; ')}.` : ''}`, { findings: offered, nextAction: list });
  }
  // The step's approval rules decide who may override its check: never an identity they do not name.
  const [{ requireApprovalAuthority }, { LIFECYCLE_EVENT }, { actorKey, assertNoPendingPublication, transactStory }] = await Promise.all([
    import('./approval-authority.mjs'), import('./lifecycle-event.mjs'), import('./state-stores.mjs')]);
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const request = { phase: phase.id, generation: overrideGeneration(workflow, phase), finding: { key: named, code: finding.code, path: finding.path ?? null,
    value: finding.details?.clauseId ?? finding.value ?? finding.clauseId ?? null, message: finding.message },
  reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null };
  // Checked before anything is written, so a refusal changes nothing.
  recordFindingOverride(structuredClone(workflow), { ...request, at: nowIso() });
  const { value: record, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: phase.id, generation: request.generation,
    actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'finding-override' }
  }, `[${id}][phase:${phase.id}][finding-override] ${named}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'override a finding');
    const recorded = recordFindingOverride(aggregate, { ...request, at: nowIso() });
    aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'finding_overridden', phase: phase.id,
      detail: `${recorded.id}: ${recorded.code}${recorded.path ? ` on ${recorded.path}` : ''} overridden for version ${recorded.generation}. ${recorded.reason}` });
    return recorded;
  }, {
    exactWorkItemPaths: [],
    eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'finding-override', record: recorded.id, reviewPacketSha256: null } })
  });
  const words = `${overriddenWords({ code: record.code, path: record.path, value: record.value }, { by: record.actor, reason: record.reason })} `
    + `It no longer blocks version ${record.generation} of ${stepName(phase)}; ${stepName(phase)}'s approvers see it with your reason, and may still return the step.`;
  return { schemaVersion: 1, resultType: 'finding-override', workId: id, phase: phase.id, generation: record.generation, id: record.id, finding: named,
    record, words, commit: publication?.sha ?? null, pushed: publication?.pushed ?? false,
    effects: { decisionRecorded: true, phaseAdvanced: false, approvalRecorded: false } };
}
