/**
 * Recording a person's override of a check's blocking finding, and the findings the decision list offers for it
 * (finding-overrides.mjs has the rules; owner, 2026-11-23). One function records it for `decision override-finding`,
 * the decision list's `decisions record`, the Decide card and /sf-decide, so every surface checks the same things:
 * - the finding is one the step's own check raises now, and one a person may override;
 * - the person is someone the step's approval rules name;
 * - the reason is their own words.
 */
import { checkReportText, checkWrongBar, findingOverrideBar, overrideGeneration, overriddenWords, recordFindingOverride } from './finding-overrides.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';

const refused = (message, details = undefined) => { throw new SingularityFlowError(message, { code: 'FINDING_OVERRIDE_INVALID', ...(details ? { details } : {}) }); };
const stepName = (phase) => phase?.label ?? phase?.id;

/**
 * The step's blocking findings now and those already overridden, as its own draft check reads them, with each page its
 * browser check could not capture that SFlow saved a screenshot of (the browser gate, mcp-evidence.mjs) [owner, 2026-11-28].
 */
async function currentFindings(root, config, workflow, phase) {
  const [{ phaseDraftCheck }, { loadSession }] = await Promise.all([import('./phase-draft-check.mjs'), import('./session.mjs')]);
  const check = await phaseDraftCheck(root, config, workflow, phase, { session: await loadSession(root, { required: false }) });
  const browser = phase?.mcp?.evidence?.length ? await browserPages(root, config, workflow, phase) : { signOffs: [], signed: [] };
  return { findings: [...(check.findings ?? []), ...browser.signOffs], overridden: [...(check.overridden ?? []), ...browser.signed] };
}

async function browserPages(root, config, workflow, phase) {
  try {
    const [{ verifyPhaseMcpRequirements }, { storyLocation }] = await Promise.all([import('./mcp-evidence.mjs'), import('./story-paths.mjs')]);
    const location = storyLocation(root, [config, workflow], workflow.workItem.id);
    const read = await verifyPhaseMcpRequirements(root, workflow, phase, { itemDirectory: location.directory, targetGeneration: overrideGeneration(workflow, phase) });
    // The screenshot as the checkout names it, so a card opens it beside the row.
    const named = (offer) => (offer.override?.screenshot?.path ? { ...offer, override: { ...offer.override,
      screenshot: { ...offer.override.screenshot, file: `${location.checkoutPath()}/${offer.override.screenshot.path}` } } } : offer);
    return { signOffs: (read.signOffs ?? []).map(named), signed: read.signed ?? [] };
  } catch { return { signOffs: [], signed: [] }; }
}

/**
 * Whether "this check is wrong here" is the finding's last way on: the routes name nobody but the step's own author, as
 * the resolution reads them (phase-resolution.mjs offers it in place of a report to SFlow's maintainer).
 */
async function lastWayOn(workflow, phase, finding) {
  try {
    const { phaseResolutionChoices } = await import('./phase-resolution.mjs');
    return phaseResolutionChoices(workflow, phase, finding).choices.some((choice) => choice.kind === 'check-wrong');
  } catch { return false; }
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
    // A code step's findings have their own dispute; its page sign-off and "this check is wrong here" are still offered.
    const code = phaseRequiresCodeDelivery(phase);
    const { findings, overridden } = await currentFindings(root, config, workflow, phase);
    const offered = [];
    for (const finding of findings) {
      const kind = finding.override?.kind ?? (finding.override?.key ? 'override' : null);
      if (!kind || (code && kind === 'override') || offered.length >= 5) continue;
      if (kind === 'check-wrong' && !(await lastWayOn(workflow, phase, finding))) continue;
      offered.push(finding);
    }
    if (!offered.length && !overridden.length) return null;
    const shape = (finding) => ({ key: finding.override?.key ?? finding.overriddenBy?.key, code: finding.code, path: finding.path ?? null, line: finding.line ?? null,
      value: finding.details?.clauseId ?? finding.value ?? finding.clauseId ?? null, message: String(finding.message ?? '').replace(/\s+/gu, ' ').slice(0, 400),
      kind: finding.override?.kind ?? finding.overriddenBy?.kind ?? 'override',
      ...(finding.override?.screenshot ? { screenshot: finding.override.screenshot } : {}),
      ...(finding.override?.kind === 'check-wrong' ? { report: checkReportText(workflow.workItem.id, phase.id, finding) } : {}) });
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
    const barred = findings.filter((entry) => !entry.override?.key).map((entry) => `${entry.code}: ${checkWrongBar(entry) ?? findingOverrideBar(entry) ?? 'its own route'}`);
    refused(`${stepName(phase)} has no blocking finding ${named || '(none named)'} now.${offered.length ? ` Its findings you may override: ${offered.join(', ')}.` : ' None of its findings is one you override here.'}`
      + `${barred.length ? ` Not overridden here: ${barred.slice(0, 5).join('; ')}.` : ''}`, { findings: offered, nextAction: list });
  }
  // The step's approval rules decide who may override its check: never an identity they do not name.
  const [{ requireApprovalAuthority }, { LIFECYCLE_EVENT }, { actorKey, assertNoPendingPublication, transactStory }] = await Promise.all([
    import('./approval-authority.mjs'), import('./lifecycle-event.mjs'), import('./state-stores.mjs')]);
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const kind = finding.override.kind ?? 'override';
  const request = { phase: phase.id, generation: overrideGeneration(workflow, phase), finding: { key: named, code: finding.code, path: finding.path ?? null,
    value: finding.details?.clauseId ?? finding.value ?? finding.clauseId ?? null, message: finding.message },
  reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null,
  kind, screenshot: finding.override.screenshot ?? null };
  // Checked before anything is written, so a refusal changes nothing.
  recordFindingOverride(structuredClone(workflow), { ...request, at: nowIso() });
  const { value: record, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: phase.id, generation: request.generation,
    actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'finding-override' }
  }, `[${id}][phase:${phase.id}][finding-override] ${named}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'override a finding');
    const recorded = recordFindingOverride(aggregate, { ...request, at: nowIso() });
    aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'finding_overridden', phase: phase.id,
      detail: `${recorded.id}: ${recorded.code}${recorded.path ? ` on ${recorded.path}` : ''}${recorded.kind === 'browser-sign-off' ? ` (${recorded.value}) signed off by a person, not captured by SFlow,` : recorded.kind === 'check-wrong' ? ' said to be a wrong check and overridden' : ' overridden'} for version ${recorded.generation}.${recorded.reason ? ` ${recorded.reason}` : ''}` });
    return recorded;
  }, {
    exactWorkItemPaths: [],
    eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'finding-override', record: recorded.id, reviewPacketSha256: null } })
  });
  const words = `${overriddenWords({ code: record.code, path: record.path, value: record.value }, { by: record.actor, reason: record.reason, kind: record.kind ?? 'override', screenshot: record.screenshot })} `
    + `It no longer blocks version ${record.generation} of ${stepName(phase)}; ${stepName(phase)}'s approvers see it${record.reason ? ' with your reason' : ''}, and it shows in the pull request; they may still return the step.`
    + (record.kind === 'check-wrong' ? ` To tell SFlow's maintainer, send: ${checkReportText(id, phase.id, record)}` : '');
  return { schemaVersion: 1, resultType: 'finding-override', workId: id, phase: phase.id, generation: record.generation, id: record.id, finding: named,
    record, words, commit: publication?.sha ?? null, pushed: publication?.pushed ?? false,
    effects: { decisionRecorded: true, phaseAdvanced: false, approvalRecorded: false } };
}
