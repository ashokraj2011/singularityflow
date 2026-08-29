import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import {
  branch, gitCommitIdentity, head, protectedBranchNames
} from '../git.mjs';
import { lifecycleEvent, LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { publishLifecycleChange } from '../publication-unit-of-work.mjs';
import {
  buildRepositoryChangeSet, changeSetPaths, evaluateProtectedPaths
} from '../repository-change-set.mjs';
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import {
  nowIso, optionString, optionStrings, run, SingularityFlowError, writeJson
} from '../util.mjs';
import {
  ADHOC_DISPOSITIONS, adhocError, assertRecordHash, assertSessionMutable,
  normalizeResourceId, stampRecord
} from './contracts.mjs';
import { createIntentCandidate, observeAdhocEffects } from './effect-set.mjs';
import { normalizeAdhocPolicy } from './policy.mjs';
import {
  closeAdhocSessionLocally, readAdhocSession, updateAdhocSession
} from './session.mjs';
import {
  adhocSessionDirectory, clearActiveSession, readSessionRecord, writeSessionRecord
} from './session-store.mjs';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function clauseIds(criteria) {
  return criteria.map((_criterion, index) => `ADH-INTENT:SC-${String(index + 1).padStart(3, '0')}`);
}

function summary(entries) {
  const result = Object.fromEntries(ADHOC_DISPOSITIONS.map((value) => [value, 0]));
  for (const entry of entries) result[entry.disposition] += 1;
  return { total: entries.length, ...result };
}

function resourceIdentity(resource) {
  return resource.resourceSha256 ?? resource.afterSha256 ?? resource.beforeSha256;
}

export async function beginAdhocLanding(root, definition, requested = null) {
  const policy = normalizeAdhocPolicy(definition.adhoc);
  let session;
  try {
    session = await readAdhocSession(root, requested);
  } catch (error) {
    if (requested || error.code !== 'ADH_SESSION_NOT_FOUND') throw error;
    const { startAdhocSession } = await import('./session.mjs');
    ({ session } = await startAdhocSession(root, definition, {
      note: '', includeExisting: true, unstartedLanding: true
    }));
  }
  assertSessionMutable(session);
  const changeSet = await observeAdhocEffects(root, session.sessionId);
  const candidate = await createIntentCandidate(root, session.sessionId);
  const protectedResult = evaluateProtectedPaths(
    changeSet.repositoryChangeSet, definition.governance?.protectedPaths ?? []
  );
  const preview = {
    sessionId: session.sessionId,
    status: 'needs-intent',
    changeSetSha256: changeSet.changeSetSha256,
    resources: changeSet.resources,
    candidate,
    policy: {
      maximumTouchedResources: policy.scope.maximumTouchedResources,
      protectedPaths: protectedResult.violations
    },
    nextActions: [
      `singularity-flow adhoc intent confirm ${session.sessionId} --objective "${candidate.objective.statement.replaceAll('"', '\\"')}" --success "<observable success>" --confirm ${changeSet.changeSetSha256}`,
      `singularity-flow adhoc close ${session.sessionId} --local-only`
    ]
  };
  return preview;
}

export async function confirmAdhocIntent(root, requested, {
  objective, successCriteria = [], constraints = [], nonGoals = [], risks = [], confirm
} = {}) {
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  const changeSet = await readSessionRecord(root, session.sessionId, 'preview');
  if (!confirm || confirm !== changeSet.changeSetSha256) {
    throw adhocError(
      'ADH_CONFIRMATION_REQUIRED',
      `Intent confirmation must equal the current change-set digest ${changeSet.changeSetSha256}.`,
      'Review the complete effect list and re-run the printed intent confirm command with that digest.'
    );
  }
  const statement = String(objective ?? '').trim();
  const criteria = successCriteria.map(String).map((item) => item.trim()).filter(Boolean);
  if (!statement || !criteria.length) {
    throw adhocError(
      'ADH_INTENT_CONFIRMATION_REQUIRED',
      'Confirmed ad hoc intent requires an objective and at least one observable success criterion.',
      'Pass --objective and one or more --success values.'
    );
  }
  const actor = gitCommitIdentity(root);
  const confirmation = stampRecord('adhoc-intent-confirmation', {
    kind: 'adhoc-intent-confirmation',
    sessionId: session.sessionId,
    changeSetSha256: changeSet.changeSetSha256,
    actor: { name: actor.name, email: actor.email },
    confirmedAt: nowIso()
  }, 'confirmationSha256');
  const intent = await writeSessionRecord(root, session.sessionId, 'intent', {
    kind: 'adhoc-confirmed-intent',
    sessionId: session.sessionId,
    changeSetSha256: changeSet.changeSetSha256,
    objective: statement,
    outcomes: criteria,
    successCriteria: criteria.map((text, index) => ({ id: clauseIds(criteria)[index], text })),
    constraints: constraints.map(String).filter(Boolean),
    nonGoals: nonGoals.map(String).filter(Boolean),
    risks: risks.map(String).filter(Boolean),
    provenance: {
      kind: 'discovered-at-landing',
      confirmedBy: confirmation.actor,
      confirmedAt: confirmation.confirmedAt
    },
    confirmationSha256: confirmation.confirmationSha256
  });
  const dispositions = await writeSessionRecord(root, session.sessionId, 'disposition', {
    kind: 'adhoc-change-disposition-map',
    sessionId: session.sessionId,
    changeSetSha256: changeSet.changeSetSha256,
    intentSha256: intent.intentSha256,
    entries: changeSet.resources.map((resource) => ({
      resourceId: resource.resourceId,
      resourceSha256: resourceIdentity(resource),
      disposition: 'unresolved',
      clauseIds: [],
      targetWorkUnit: null,
      decisionRef: null
    })),
    summary: summary(changeSet.resources.map(() => ({ disposition: 'unresolved' }))),
    updatedAt: nowIso()
  });
  await updateAdhocSession(root, session.sessionId, { status: 'needs-disposition' });
  return { intent, dispositions };
}

export async function dispositionAdhocResource(root, requested, {
  resource, all = false, disposition = 'claimed', clauses = [], reason = null
} = {}) {
  if (!ADHOC_DISPOSITIONS.includes(disposition)) {
    throw adhocError('ADH_DISPOSITION_INVALID', `Unknown disposition '${disposition}'.`, `Use one of: ${ADHOC_DISPOSITIONS.join(', ')}.`);
  }
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  const changeSet = await readSessionRecord(root, session.sessionId, 'preview');
  const intent = await readSessionRecord(root, session.sessionId, 'intent');
  if (intent.changeSetSha256 !== changeSet.changeSetSha256) {
    throw adhocError('ADH_INTENT_STALE', 'The confirmed intent belongs to an older effect set.', 'Run land again, review the new effects, and reconfirm intent.');
  }
  const map = await readSessionRecord(root, session.sessionId, 'disposition');
  const knownClauses = new Set(intent.successCriteria.map((entry) => entry.id));
  const selectedClauses = clauses.map(String).filter(Boolean);
  if (disposition === 'claimed' && !selectedClauses.length) {
    throw adhocError('ADH_DISPOSITION_INVALID', 'A claimed resource must name at least one confirmed success criterion.', `Use --clause ${intent.successCriteria[0].id}.`);
  }
  const unknown = selectedClauses.find((id) => !knownClauses.has(id));
  if (unknown) throw adhocError('ADH_DISPOSITION_INVALID', `Clause '${unknown}' is not in the confirmed intent.`, `Use one of: ${[...knownClauses].join(', ')}.`);
  const selected = all ? null : normalizeResourceId(resource);
  let matched = false;
  const entries = map.entries.map((entry) => {
    if (!all && entry.resourceId !== selected) return entry;
    matched = true;
    return {
      ...entry,
      disposition,
      clauseIds: selectedClauses,
      decisionRef: reason ? { reason: String(reason) } : null
    };
  });
  if (!matched) {
    throw adhocError('ADH_DISPOSITION_INVALID', `Resource '${selected}' is not in the current effect set.`, 'Run adhoc effects and use an exact resource path.');
  }
  const updated = await writeSessionRecord(root, session.sessionId, 'disposition', {
    ...map,
    entries,
    summary: summary(entries),
    updatedAt: nowIso(),
    mapSha256: undefined,
    schemaVersion: currentSchemaVersion('adhoc-change-disposition-map')
  });
  return updated;
}

function selectTestCommand(definition, requested = null) {
  const commands = definition.spec?.testCommands ?? {};
  if (requested) {
    if (!commands[requested]) {
      throw adhocError('ADH_VERIFICATION_UNAVAILABLE', `Configured test command '${requested}' does not exist.`, `Use one of: ${Object.keys(commands).join(', ') || 'none configured'}.`);
    }
    return [requested, commands[requested]];
  }
  const entries = Object.entries(commands);
  if (entries.length === 1) return entries[0];
  if (!entries.length) return null;
  throw adhocError(
    'ADH_VERIFICATION_UNAVAILABLE',
    'More than one deterministic test command is configured, so the direct-land check is ambiguous.',
    `Re-run landing preview with --test-command ${entries[0][0]} after reviewing: ${entries.map(([id]) => id).join(', ')}.`
  );
}

function executeTest(root, id, argv, changeSetSha256) {
  const startedAt = nowIso();
  const result = run(argv[0], argv.slice(1), { cwd: root, allowFailure: true });
  const record = stampRecord('adhoc-verification-result', {
    kind: 'adhoc-verification-result',
    changeSetSha256,
    startedAt,
    completedAt: nowIso(),
    status: result.status === 0 ? 'passed' : 'failed',
    checks: [{
      id,
      argv,
      required: true,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
      outputBytes: Buffer.byteLength(result.stdout),
      errorBytes: Buffer.byteLength(result.stderr)
    }]
  }, 'resultSha256');
  return record;
}

function workId(session, intent) {
  const date = String(session.startedAt).slice(0, 10).replaceAll('-', '');
  const slug = intent.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'work';
  return `ADH-${date}-${slug}-${session.sessionId.slice(-6).toLowerCase()}`;
}

export async function compileAdhocLanding(root, definition, requested = null, { testCommand = null } = {}) {
  const policy = normalizeAdhocPolicy(definition.adhoc);
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  const changeSet = await observeAdhocEffects(root, session.sessionId);
  const intent = await readSessionRecord(root, session.sessionId, 'intent', { required: false });
  if (!intent) {
    throw adhocError('ADH_INTENT_CONFIRMATION_REQUIRED', 'The current effects have no human-confirmed reverse-converged intent.', 'Review the candidate and run adhoc intent confirm.');
  }
  if (intent.changeSetSha256 !== changeSet.changeSetSha256) {
    throw adhocError('ADH_INTENT_STALE', 'Repository effects changed after intent confirmation.', 'Review the updated effect set and confirm the intent again.');
  }
  const dispositions = await readSessionRecord(root, session.sessionId, 'disposition');
  if (dispositions.changeSetSha256 !== changeSet.changeSetSha256
      || dispositions.intentSha256 !== intent.intentSha256) {
    throw adhocError('ADH_CHANGE_SET_STALE', 'The disposition map is not bound to the current effects and intent.', 'Reconfirm intent and disposition every current resource.');
  }
  const unresolved = dispositions.entries.filter((entry) => entry.disposition !== 'claimed');
  if (unresolved.length) {
    throw adhocError(
      'ADH_CHANGE_UNCLAIMED',
      `${unresolved.length} changed resource(s) are not claimed for direct landing: ${unresolved.map((entry) => entry.resourceId).join(', ')}.`,
      `Claim them with 'singularity-flow adhoc claim --all --clause ${intent.successCriteria[0].id}', or promote/split the work.`
    );
  }

  const protectedResult = evaluateProtectedPaths(
    changeSet.repositoryChangeSet, definition.governance?.protectedPaths ?? []
  );
  const reasons = [];
  if (changeSet.resources.length > policy.scope.maximumTouchedResources) {
    reasons.push(`resource ceiling exceeded (${changeSet.resources.length} > ${policy.scope.maximumTouchedResources})`);
  }
  if (!protectedResult.valid) reasons.push(`protected paths touched: ${protectedResult.violations.map((entry) => entry.path).join(', ')}`);
  if (protectedBranchNames(root, definition).has(branch(root))) reasons.push(`current branch '${branch(root)}' is protected`);
  const stagedPaths = run('git', ['diff', '--cached', '--name-only', '-z'], { cwd: root }).stdout
    .split('\0').filter(Boolean);
  if (stagedPaths.length) reasons.push(`staged index entries require review: ${stagedPaths.join(', ')}`);
  if (!policy.directLanding.enabled) reasons.push('direct landing is disabled');

  const selected = selectTestCommand(definition, testCommand);
  const verificationPlan = await writeSessionRecord(root, session.sessionId, 'verificationPlan', {
    kind: 'adhoc-verification-plan',
    sessionId: session.sessionId,
    changeSetSha256: changeSet.changeSetSha256,
    checks: selected ? [{ id: selected[0], operation: 'code.test', argv: selected[1], required: true }] : [],
    evidenceContracts: [],
    humanRequests: [],
    compiledAt: nowIso()
  });
  const verification = selected
    ? executeTest(root, selected[0], selected[1], changeSet.changeSetSha256)
    : stampRecord('adhoc-verification-result', {
        kind: 'adhoc-verification-result', sessionId: session.sessionId,
        changeSetSha256: changeSet.changeSetSha256, status: 'unavailable', checks: [],
        completedAt: nowIso()
      }, 'resultSha256');
  await writeSessionRecord(root, session.sessionId, 'verificationResult', verification);
  if (verification.status !== 'passed') {
    reasons.push(selected ? `required test '${selected[0]}' ${verification.status}` : 'no deterministic test command is configured');
  }
  const status = reasons.length ? 'promotion-required' : 'eligible';
  const eligibility = await writeSessionRecord(root, session.sessionId, 'eligibility', {
    kind: 'adhoc-landing-eligibility',
    sessionId: session.sessionId,
    changeSetSha256: changeSet.changeSetSha256,
    intentSha256: intent.intentSha256,
    dispositionMapSha256: dispositions.mapSha256,
    status,
    checks: [
      { id: 'single-repository', passed: true },
      { id: 'resource-ceiling', passed: changeSet.resources.length <= policy.scope.maximumTouchedResources },
      { id: 'protected-paths', passed: protectedResult.valid },
      { id: 'unprotected-branch', passed: !protectedBranchNames(root, definition).has(branch(root)) },
      { id: 'unstaged-work-area', passed: stagedPaths.length === 0 },
      { id: 'dispositions', passed: unresolved.length === 0 },
      { id: 'verification', passed: verification.status === 'passed' }
    ],
    promotionReasons: reasons,
    blockers: [],
    requiredVerification: selected ? [selected[0]] : [],
    requiredHumanRequests: ['confirm-exact-landing-packet'],
    evaluatedAt: nowIso()
  });
  if (status !== 'eligible') {
    await updateAdhocSession(root, session.sessionId, { status: 'needs-decision' });
    return { sessionId: session.sessionId, status, eligibility, verificationPlan, verification, packet: null };
  }
  const packet = await writeSessionRecord(root, session.sessionId, 'packet', {
    kind: 'adhoc-landing-packet',
    sessionId: session.sessionId,
    workId: workId(session, intent),
    baselineSha256: session.baseline.baselineSha256,
    changeSetSha256: changeSet.changeSetSha256,
    intentSha256: intent.intentSha256,
    dispositionMapSha256: dispositions.mapSha256,
    eligibilitySha256: eligibility.resultSha256,
    verificationPlanSha256: verificationPlan.planSha256,
    verificationResultSha256: verification.resultSha256,
    origin: {
      mode: 'adhoc',
      intentProvenance: 'discovered-at-landing',
      executionRoute: session.execution.mode,
      workflowExecuted: false
    },
    changes: { files: changeSet.resources.length },
    evidence: { ready: selected ? [selected[0]] : [], missing: [] },
    externalEffects: { governed: [], outsideGovernance: [], uncertain: [] },
    publication: {
      destination: 'current-subject',
      branch: branch(root),
      expectedHead: head(root),
      allowedResources: changeSetPaths(changeSet.repositoryChangeSet)
    },
    humanDecision: { required: true, authority: 'current-git-identity' },
    createdAt: nowIso()
  });
  await updateAdhocSession(root, session.sessionId, {
    status: 'ready-to-land',
    landing: { ...(session.landing ?? {}), packetSha256: packet.packetSha256 }
  });
  return { sessionId: session.sessionId, status, eligibility, verificationPlan, verification, packet };
}

async function resourceFingerprint(root, resources) {
  const hash = createHash('sha256');
  for (const resource of [...resources].sort()) {
    const absolute = path.join(root, resource);
    hash.update(resource).update('\0');
    try {
      const info = await lstat(absolute);
      const content = info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      hash.update(info.isSymbolicLink() ? 'symlink' : String(info.mode & 0o111 ? 'executable' : 'file'))
        .update('\0').update(content).update('\0');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('missing\0');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

async function writeAuthorityRecord(root, directory, file, family, value, hashField) {
  const record = stampRecord(family, value, hashField);
  await writeJson(path.join(root, directory, file), record);
  return record;
}

export async function publishAdhocLanding(root, definition, requested, { confirm } = {}) {
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  const packet = await readSessionRecord(root, session.sessionId, 'packet', { required: false });
  if (!packet || !confirm || confirm !== packet.packetSha256) {
    throw adhocError(
      'ADH_CONFIRMATION_REQUIRED',
      `Publication requires the exact current landing packet digest ${packet?.packetSha256 ?? '(no packet exists)'}.`,
      packet ? `Review it, then run adhoc publish ${session.sessionId} --confirm ${packet.packetSha256}.` : 'Run adhoc landing preview after confirming intent and dispositions.'
    );
  }
  if (packet.publication.expectedHead !== head(root) || packet.publication.branch !== branch(root)) {
    throw adhocError('ADH_PACKET_STALE', 'The branch or HEAD changed after the landing packet was created.', 'Run adhoc landing preview again and confirm the replacement packet.');
  }
  const current = await buildRepositoryChangeSet(root, {
    baseCommit: (await readSessionRecord(root, session.sessionId, 'baseline')).revision.gitCommit,
    subject: { kind: 'adhoc', id: session.sessionId }
  });
  const prior = await readSessionRecord(root, session.sessionId, 'preview');
  if (current.digest !== prior.repositoryChangeSet.digest) {
    throw adhocError('ADH_PACKET_STALE', 'Repository effects changed after the landing packet was created.', 'Run land, review the new effect set, and produce a new exact packet.');
  }
  const intent = await readSessionRecord(root, session.sessionId, 'intent');
  const dispositions = await readSessionRecord(root, session.sessionId, 'disposition');
  const verificationPlan = await readSessionRecord(root, session.sessionId, 'verificationPlan');
  const verification = executeTest(
    root,
    verificationPlan.checks[0].id,
    verificationPlan.checks[0].argv,
    prior.changeSetSha256
  );
  if (verification.status !== 'passed') {
    throw adhocError('ADH_VERIFICATION_FAILED', `Required test '${verificationPlan.checks[0].id}' failed during publication freshness verification.`, 'Fix the failure; all working changes remain present; then produce a new landing preview.');
  }
  const actor = gitCommitIdentity(root);
  if (!actor.email) {
    throw adhocError('ADH_AUTHORITY_REQUIRED', 'Git user.email is not configured, so the human landing decision cannot be attributed.', 'Configure Git user.name and user.email, then retry the same exact packet if it remains current.');
  }
  const decision = stampRecord('adhoc-landing-decision', {
    kind: 'adhoc-landing-decision',
    sessionId: session.sessionId,
    workId: packet.workId,
    packetSha256: packet.packetSha256,
    decision: 'approve-direct-landing',
    actor: { name: actor.name, email: actor.email },
    decidedAt: nowIso()
  }, 'decisionSha256');
  const authorityDirectory = `singularity/adhoc-work/${packet.workId}`;
  const applicationResources = packet.publication.allowedResources;
  const allowedPaths = [...new Set([...applicationResources, authorityDirectory])];
  const initialFingerprint = await resourceFingerprint(root, applicationResources);
  const authoritativeReceipt = stampRecord('adhoc-landing-receipt', {
    kind: 'adhoc-landing-receipt',
    sessionId: session.sessionId,
    workId: packet.workId,
    packetSha256: packet.packetSha256,
    authorityTransactionSha256: null,
    authority: {
      previousRevision: packet.publication.expectedHead,
      newRevision: null,
      commit: null,
      commitBinding: 'lifecycle-event-and-commit-trailers'
    },
    publishedResources: applicationResources,
    excludedResources: [],
    splitResources: [],
    origin: { kind: 'reverse-converged-adhoc' },
    completedAt: nowIso()
  }, 'receiptSha256');
  const event = lifecycleEvent({
    type: LIFECYCLE_EVENT.ADHOC_LANDED,
    subject: { kind: 'adhoc', id: session.sessionId },
    actor: { name: actor.name, email: actor.email },
    payload: {
      workId: packet.workId,
      packetSha256: packet.packetSha256,
      decisionSha256: decision.decisionSha256,
      landingReceiptSha256: authoritativeReceipt.receiptSha256,
      origin: 'reverse-converged-adhoc'
    }
  });
  const publication = await publishLifecycleChange(root, {
    subject: { kind: 'adhoc', id: session.sessionId },
    expectedRevision: { head: packet.publication.expectedHead },
    allowedPaths,
    event,
    commit: {
      message: `[adhoc][${packet.workId}] ${intent.objective.slice(0, 120)}`
    },
    publication: {
      branch: packet.publication.branch,
      remote: definition.git?.remote ?? 'origin',
      mode: definition.git?.publish ?? 'required',
      expectedLocalHead: packet.publication.expectedHead,
      ...((definition.git?.publish ?? 'required') !== 'off'
        ? { expectedRemoteSha: packet.publication.expectedHead }
        : {})
    },
    pendingRecord: ({ envelope }) => ({
      adhoc: { sessionId: session.sessionId, workId: packet.workId, packetSha256: packet.packetSha256 },
      lifecycleEventId: envelope.eventId
    }),
    state: {
      write: async () => {
        await writeAuthorityRecord(root, authorityDirectory, 'confirmed-intent.json', 'adhoc-confirmed-intent', intent, 'intentSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'effect-set.json', 'adhoc-change-set', prior, 'changeSetSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'disposition-map.json', 'adhoc-change-disposition-map', dispositions, 'mapSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'verification-plan.json', 'adhoc-verification-plan', verificationPlan, 'planSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'verification-result.json', 'adhoc-verification-result', verification, 'resultSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'decision.json', 'adhoc-landing-decision', decision, 'decisionSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'landing-receipt.json', 'adhoc-landing-receipt', authoritativeReceipt, 'receiptSha256');
        await writeAuthorityRecord(root, authorityDirectory, 'work.json', 'reverse-converged-work', {
          kind: 'reverse-converged-work',
          workId: packet.workId,
          origin: {
            kind: 'adhoc', sessionId: session.sessionId,
            workflowExecuted: false, intentProvenance: 'discovered-at-landing'
          },
          baselineSha256: packet.baselineSha256,
          intentSha256: packet.intentSha256,
          changeSetSha256: packet.changeSetSha256,
          dispositionMapSha256: packet.dispositionMapSha256,
          verificationResultSha256: verification.resultSha256,
          decisionSha256: decision.decisionSha256,
          status: 'published'
        }, 'recordSha256');
      },
      validate: async () => {
        for (const [file, family, hashField] of [
          ['confirmed-intent.json', 'adhoc-confirmed-intent', 'intentSha256'],
          ['effect-set.json', 'adhoc-change-set', 'changeSetSha256'],
          ['disposition-map.json', 'adhoc-change-disposition-map', 'mapSha256'],
          ['verification-result.json', 'adhoc-verification-result', 'resultSha256'],
          ['decision.json', 'adhoc-landing-decision', 'decisionSha256'],
          ['landing-receipt.json', 'adhoc-landing-receipt', 'receiptSha256'],
          ['work.json', 'reverse-converged-work', 'recordSha256']
        ]) {
          const record = readRecord(family, await readFile(path.join(root, authorityDirectory, file), 'utf8')).record;
          assertRecordHash(record, hashField, file);
        }
      }
    },
    beforeCommit: async () => {
      if (await resourceFingerprint(root, applicationResources) !== initialFingerprint) {
        throw new SingularityFlowError('Application resources changed while the ad hoc authority records were being prepared.', { code: 'ADH_PACKET_STALE' });
      }
    },
    stabilityGuard: () => resourceFingerprint(root, applicationResources)
  });
  const localReceipt = await writeSessionRecord(root, session.sessionId, 'receipt', {
    ...authoritativeReceipt,
    authorityTransactionSha256: publication.event.idempotencyHash
      ? `sha256:${publication.event.idempotencyHash}` : null,
    authority: {
      ...authoritativeReceipt.authority,
      newRevision: publication.sha,
      commit: publication.sha
    },
    completedAt: nowIso(),
    receiptSha256: undefined,
    schemaVersion: currentSchemaVersion('adhoc-landing-receipt')
  }).catch(() => null);
  await updateAdhocSession(root, session.sessionId, {
    status: 'landed', landedAt: nowIso(), workId: packet.workId,
    publication: { commit: publication.sha, pushed: publication.pushed, pending: publication.pending === true }
  }).catch(() => null);
  await clearActiveSession(root, session.sessionId).catch(() => null);
  return {
    sessionId: session.sessionId,
    workId: packet.workId,
    packetSha256: packet.packetSha256,
    commit: publication.sha,
    pushed: publication.pushed,
    pending: publication.pending === true,
    receipt: localReceipt,
    authorityReceipt: `${authorityDirectory}/landing-receipt.json`
  };
}

export async function promoteAdhocSession(root, requested = null) {
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  const changeSet = await readSessionRecord(root, session.sessionId, 'preview', { required: false });
  const checkpoint = stampRecord('adhoc-promotion-checkpoint', {
    kind: 'adhoc-promotion-checkpoint',
    sessionId: session.sessionId,
    status: 'review-required',
    baselineSha256: session.baseline.baselineSha256,
    changeSetSha256: changeSet?.changeSetSha256 ?? null,
    preservedBranch: session.branch,
    createdAt: nowIso(),
    nextAction: `singularity-flow start <WORK-ID> --from-branch ${session.branch} --allow-dirty`
  }, 'checkpointSha256');
  await writeJson(path.join(adhocSessionDirectory(root, session.sessionId), 'promotion-checkpoint.json'), checkpoint);
  await updateAdhocSession(root, session.sessionId, { status: 'needs-decision' });
  return checkpoint;
}

export async function closeAdhocLocalOnly(root, requested = null) {
  return closeAdhocSessionLocally(root, requested);
}

export function adhocOptions(options) {
  return {
    objective: optionString(options, 'objective'),
    successCriteria: optionStrings(options, 'success'),
    constraints: optionStrings(options, 'constraint'),
    nonGoals: optionStrings(options, 'non-goal'),
    risks: optionStrings(options, 'risk'),
    confirm: optionString(options, 'confirm')
  };
}
