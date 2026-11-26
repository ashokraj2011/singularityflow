/**
 * Which Initiative outputs, packs and phases wait for a decision, and whose decision each is [FPL:REQ-008].
 *
 * This rule lived in VS Code (`approvals-model.ts`), for the Initiative open in the window only. It is the engine's
 * now: Needs you (src/needs-you.mjs) lists an Initiative approval from it for every Initiative checked out in the
 * workspace's clones, and the VS Code Approvals page reads the same function, so the two never disagree.
 *
 * Authorization is recomputed from the same inputs the engine's approval uses, so it can be wrong in one direction
 * only: it may offer an approval the engine then refuses, with the engine's own reason. It never hides one the engine
 * would accept, so an uncertain case is offered.
 *
 * Pure: the caller supplies the Initiative's state, report and phase gate (`initiativeEditorSnapshot` in editor.mjs),
 * the person, and a lookup for approval groups.
 */

const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Whether a group admits `person`, by the engine's rule: a group open to any Git identity, or a member matched by email or
 * GitHub login.
 */
function authorityAdmits(groupOf, authority, person) {
  const definition = groupOf(authority);
  if (!definition || (!person.email && !person.login)) return false;
  if (definition.allowAnyGitIdentity) return true;
  return (definition.members ?? []).some((member) => (person.email && lower(member.email) === person.email)
    || (person.login && lower(member.githubLogin ?? member.login) === person.login));
}

/** Whether a group names its members only by GitHub login, so a person with no login known cannot be matched. */
function loginOnly(groupOf, authority) {
  const definition = groupOf(authority);
  return Boolean(definition && !definition.allowAnyGitIdentity
    && (definition.members ?? []).some((member) => (member.githubLogin ?? member.login) && !member.email));
}

/**
 * Which chain step is open, read from the gate's own sentence ("… waiting on Executive Decisioning (0/1) for …"): the
 * report's approval records drop the chain step each decision recorded, so reading the gate keeps one implementation.
 */
function openStepFrom(gateErrors, subjectId) {
  for (const error of gateErrors) {
    if (!error.includes(subjectId)) continue;
    const match = /waiting on (.+?) \((\d+)\/(\d+)\)/u.exec(error);
    if (match?.[1]) return { label: match[1], signed: Number(match[2]), needed: Number(match[3]) };
  }
  return null;
}

/** The declared chain, marked up with whichever step the gate says is open. */
function chainProgress(policy, open) {
  if (!policy?.chain?.length) return [];
  const openIndex = open ? policy.chain.findIndex((step) => (step.label ?? step.authority) === open.label) : -1;
  return policy.chain.map((step, index) => ({
    authority: step.authority,
    label: step.label ?? step.authority,
    minimum: step.minimum,
    signatures: index === openIndex ? open?.signed ?? 0 : (openIndex < 0 && !open) || index < openIndex ? step.minimum : 0,
    // Everything before the open step was satisfied for it to be open at all.
    satisfied: openIndex >= 0 ? index < openIndex : !open,
    open: index === openIndex
  }));
}

/**
 * Whose decision this is now, and why it is not this person's when it is not. `couldNotTell` is a group that names its
 * members only by GitHub login while no login is known here: offered, and the approval itself checks it.
 */
export function initiativeStanding(groupOf, person, policy, chain) {
  if (policy?.mode === 'none') return { standing: 'blocked', reason: 'This subject is not approved individually.', authorities: [] };
  const openStep = chain.find((step) => step.open);
  const authorities = openStep ? [openStep.authority] : (policy?.authorities ?? []);
  // No group named is a gap in the configuration, not a decision anybody can take.
  if (!authorities.length) return { standing: 'blocked', reason: 'No approval group is configured for this subject.', authorities: [] };
  if (!person.email && !person.login) return { standing: 'others', reason: 'No Git identity is configured for this repository.', authorities };
  if (authorities.some((authority) => authorityAdmits(groupOf, authority, person))) return { standing: 'yours', reason: null, authorities };
  if (!person.login && authorities.some((authority) => loginOnly(groupOf, authority))) {
    return { standing: 'yours', couldNotTell: true,
      reason: 'Your GitHub account is not known here, so SFlow cannot confirm you are in this group: approving checks it.', authorities };
  }
  return { standing: 'others', authorities,
    reason: openStep ? `Waiting on ${openStep.label} (${openStep.signatures}/${openStep.minimum}).` : `Waiting on ${authorities.join(', ')}.` };
}

/** The phase a pack's approval belongs to: the latest phase any member sits in. */
function packTerminalPhase(phaseOrder, members) {
  let terminal = null;
  let latest = -1;
  for (const member of members) {
    const phase = member.split('/')[0] ?? '';
    const position = phaseOrder.indexOf(phase);
    if (position > latest) { latest = position; terminal = phase; }
  }
  return terminal;
}

/** An output's path from the repository root, as the editor snapshot names it. */
function outputRepositoryPath(initiative, phaseId, output) {
  return output.repositoryPath
    ?? initiative.documents?.find((document) => document.phase === phaseId && document.id === output.id)?.repositoryPath
    ?? output.path;
}

/**
 * Every pending Initiative approval: `{ initiativeId, actor, pending, obstacles, empty }`, each pending entry with its
 * `standing` (`yours`, `others`, `blocked`), the exact confirmation the CLI asks (`expected`) and its chain.
 *
 * `initiative` is `{ state, report, phaseGate, documents? }`; `person` is `{ email, login }`; `groupOf(id)` returns an
 * approval group's definition.
 */
export function initiativePendingApprovals(initiative, { person: given = {}, groupOf = () => null } = {}) {
  const person = { email: lower(given.email) || null, login: lower(given.login) || null };
  const actor = person.email;
  // `records` in the report is a count; the decisions themselves are grouped by phase.
  const byPhase = initiative.report?.approvals?.byPhase ?? {};
  const records = Object.values(byPhase).flat();
  const { state } = initiative;
  const phaseId = state.currentPhase;
  const pending = [];
  const gateErrors = initiative.phaseGate?.ready ? [] : initiative.phaseGate?.errors ?? [];
  const recordsFor = (phase, type, id) => records.filter((record) => record.phase === phase && record.subjectType === type && record.subjectId === id);
  const signaturesOf = (signed) => signed.map((record) => ({ actor: record.actorEmail ?? 'unknown', at: record.at ?? null }));

  if (phaseId) {
    const resolution = state.resolution?.phases?.find((phase) => phase.id === phaseId);
    const phase = state.phases?.[phaseId];

    // Outputs that exist and are not yet approved.
    for (const output of Object.values(phase?.outputs ?? {})) {
      if (!output.sha256 || output.status === 'approved') continue;
      const policy = resolution?.outputs?.find((declared) => declared.id === output.id)?.approval;
      const chain = chainProgress(policy, openStepFrom(gateErrors, output.id));
      const { standing, reason, authorities, couldNotTell } = initiativeStanding(groupOf, person, policy, chain);
      const artifactPath = outputRepositoryPath(initiative, phaseId, output);
      pending.push({
        source: 'initiative', id: `output:${phaseId}/${output.id}`, kind: 'output', phase: phaseId, subject: output.id,
        label: output.label ?? output.id, detail: artifactPath, artifactPath, sha256: output.sha256,
        expected: `${phaseId}:${output.id}`, standing, reason, ...(couldNotTell ? { couldNotTell } : {}),
        selfApproval: Boolean(actor) && lower(output.generatedBy) === actor,
        chain, authorities, rejectTo: [phaseId], signatures: signaturesOf(recordsFor(phaseId, 'output', output.id)),
        waitingSince: output.generatedAt ?? output.publishedAt ?? phase?.startedAt ?? null
      });
    }

    // Packs whose last member sits in this phase.
    for (const pack of state.resolution?.packs ?? []) {
      if (packTerminalPhase(state.phaseOrder ?? [], pack.members) !== phaseId) continue;
      const complete = pack.members.every((member) => {
        const [memberPhase, memberOutput] = [member.split('/')[0] ?? '', member.split('/')[1] ?? ''];
        return Boolean(state.phases?.[memberPhase]?.outputs?.[memberOutput]?.sha256);
      });
      if (!complete) continue;
      const policy = pack.approval;
      const signed = recordsFor(phaseId, 'pack', pack.id);
      const open = openStepFrom(gateErrors, pack.id);
      // A pack has no status of its own: signed, and the gate no longer asks, is approved. Listing it again would invite
      // a second decision on something already decided.
      if (signed.length && !open && !gateErrors.some((error) => error.includes(pack.id))) continue;
      const chain = chainProgress(policy, open);
      const { standing, reason, authorities, couldNotTell } = initiativeStanding(groupOf, person, policy, chain);
      pending.push({
        source: 'initiative', id: `pack:${pack.id}`, kind: 'pack', phase: phaseId, subject: `pack:${pack.id}`,
        label: pack.label ?? pack.id,
        detail: `${pack.members.length} artifacts across ${new Set(pack.members.map((member) => member.split('/')[0])).size} phases`,
        sha256: null, expected: `${phaseId}:pack:${pack.id}`, standing, reason, ...(couldNotTell ? { couldNotTell } : {}),
        selfApproval: false, chain, authorities, rejectTo: [phaseId], signatures: signaturesOf(signed),
        waitingSince: phase?.startedAt ?? null
      });
    }

    // The phase itself, once its gate is ready.
    if (phase && phase.status !== 'approved' && initiative.phaseGate?.ready) {
      const policy = resolution?.bundleApproval;
      const chain = chainProgress(policy, openStepFrom(gateErrors, phaseId));
      const { standing, reason, authorities, couldNotTell } = initiativeStanding(groupOf, person, policy, chain);
      pending.push({
        source: 'initiative', id: `phase:${phaseId}`, kind: 'phase', phase: phaseId, subject: 'phase',
        label: `${phase.label ?? phaseId} — the phase itself`, detail: 'Approving the phase closes it and opens the next.',
        sha256: initiative.phaseGate?.bundleSha256 ?? null, expected: `${phaseId}:phase`, standing, reason,
        ...(couldNotTell ? { couldNotTell } : {}),
        selfApproval: Boolean(actor) && Object.values(phase.outputs ?? {}).some((output) => lower(output.generatedBy) === actor),
        chain, authorities, rejectTo: [phaseId], signatures: signaturesOf(recordsFor(phaseId, 'phase', phaseId)),
        waitingSince: phase.submittedAt ?? phase.startedAt ?? null
      });
    }
  }

  // Yours first: it is the only part most readers need.
  const order = { yours: 0, others: 1, blocked: 2 };
  pending.sort((left, right) => order[left.standing] - order[right.standing] || left.label.localeCompare(right.label));
  // Gate errors that are not approvals: evidence, checklists, artifacts that do not exist yet.
  const obstacles = (initiative.phaseGate?.ready ? [] : initiative.phaseGate?.errors ?? []).filter((error) => !/\bapprovals?\b|waiting on/iu.test(error));
  return {
    initiativeId: state.initiative?.id ?? '', actor, pending, obstacles,
    empty: pending.length || obstacles.length ? null : 'Nothing is waiting for a decision.'
  };
}
