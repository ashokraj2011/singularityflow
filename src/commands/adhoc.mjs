import { loadDefinition } from '../config.mjs';
import { repoRoot } from '../git.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';
import {
  adhocOptions, beginAdhocLanding, closeAdhocLocalOnly, compileAdhocLanding,
  confirmAdhocIntent, dispositionAdhocResource, promoteAdhocSession, publishAdhocLanding,
  syncAdhocLanding
} from '../adhoc/landing.mjs';
import {
  adhocStatus, pauseAdhocSession, resumeAdhocSession, startAdhocSession
} from '../adhoc/session.mjs';
import { observeAdhocEffects } from '../adhoc/effect-set.mjs';
import { readSessionRecord, resolveSessionId } from '../adhoc/session-store.mjs';

function emit(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(render(value));
  return value;
}

function render(value) {
  if (value?.packet) {
    const lines = [
      `Ad hoc landing ${value.status}`,
      `Session: ${value.sessionId}`,
      `Verification: ${value.verification.status}`
    ];
    if (value.packet) {
      lines.push(`Packet: ${value.packet.packetSha256}`);
      lines.push('', 'Publish this exact packet:');
      lines.push(`singularity-flow adhoc publish ${value.sessionId} --confirm ${value.packet.packetSha256}`);
    } else if (value.eligibility?.promotionReasons?.length) {
      lines.push(`Promotion required: ${value.eligibility.promotionReasons.join('; ')}`);
      lines.push(`singularity-flow adhoc promote ${value.sessionId}`);
    }
    return lines.join('\n');
  }
  if (value?.candidate && value?.resources) {
    return [
      'Ad hoc landing preview',
      `Session: ${value.sessionId}`,
      `Effects: ${value.resources.length} resource(s)`,
      `Change set: ${value.changeSetSha256}`,
      `Candidate objective: ${value.candidate.objective.statement}`,
      ...(value.policy.protectedPaths.length
        ? [`Protected path contact: ${value.policy.protectedPaths.map((entry) => entry.path).join(', ')}`]
        : []),
      '', 'Candidate intent is advisory. Confirm or edit it:',
      value.nextActions[0]
    ].join('\n');
  }
  if (value?.session && value?.baseline) {
    const session = value.session;
    return [
      `Ad hoc session ${session.sessionId}`,
      `Status: ${session.status}`,
      `Branch: ${session.branch}`,
      `Baseline: ${value.baseline.revision.gitCommit}`,
      `Effects: ${value.changeSet?.resources?.length ?? 'not observed'}`,
      `Intent: ${value.intent?.objective ?? 'not confirmed'}`,
      `Packet: ${value.packet?.packetSha256 ?? 'not ready'}`,
      `Commit: ${value.receipt?.authority?.commit ?? session.publication?.commit ?? 'not published'}`
    ].join('\n');
  }
  if (value?.sessionId && value?.workId && value?.commit) {
    return [
      'Ad hoc landing published',
      `Session: ${value.sessionId}`,
      `Work: ${value.workId}`,
      `Commit: ${value.commit}`,
      `Push: ${value.pushed ? 'complete' : value.pending ? 'pending recovery' : 'disabled'}`,
      `Authority receipt: ${value.authorityReceipt}`
    ].join('\n');
  }
  if (value?.kind === 'adhoc-session') {
    return `Ad hoc session ${value.sessionId}\nStatus: ${value.status}\nBranch: ${value.branch}`;
  }
  if (value?.kind === 'adhoc-confirmed-intent') {
    return `Intent confirmed for ${value.sessionId}\nObjective: ${value.objective}\nIntent: ${value.intentSha256}`;
  }
  if (value?.intent && value?.dispositions) {
    return [
      `Intent confirmed for ${value.intent.sessionId}`,
      `Objective: ${value.intent.objective}`,
      `Intent: ${value.intent.intentSha256}`,
      `${value.dispositions.summary.unresolved} resource(s) need a disposition.`,
      `singularity-flow adhoc claim --all --clause ${value.intent.successCriteria[0].id}`
    ].join('\n');
  }
  if (value?.kind === 'adhoc-change-disposition-map') {
    return `Disposition map ${value.mapSha256}\nClaimed: ${value.summary.claimed}/${value.summary.total}\nUnresolved: ${value.summary.unresolved}`;
  }
  if (value?.kind === 'adhoc-change-set') {
    return [
      `Ad hoc effects ${value.changeSetSha256}`,
      ...value.resources.map((entry) => `${entry.operation.padEnd(12)} ${entry.resourceId}`)
    ].join('\n');
  }
  if (value?.kind === 'adhoc-promotion-checkpoint') {
    return `Promotion checkpoint ${value.checkpointSha256}\nWork preserved on ${value.preservedBranch}.\nNext: ${value.nextAction}`;
  }
  return JSON.stringify(value, null, 2);
}

function unsupported(action, sessionId = null) {
  throw new SingularityFlowError(
    `Ad hoc ${action} is outside the direct-landing thin pilot. Existing work${sessionId ? ` in ${sessionId}` : ''} is preserved. `
    + "Use 'singularity-flow adhoc promote' to create a reviewed workflow handoff.",
    { code: action === 'split' ? 'ADH_SPLIT_REQUIRED' : 'ADH_PROMOTION_REQUIRED' }
  );
}

export async function run(_argv, { positionals, options, definition: commandDefinition }) {
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const json = optionBoolean(options, 'json');
  // `land` is a first-class compatibility command mapped to this same handler.
  if (commandDefinition.name === 'land') {
    return emit(await beginAdhocLanding(root, definition, positionals[1] ?? null), json);
  }
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'start') {
    const result = await startAdhocSession(root, definition, {
      note: positionals[2] ?? '',
      from: optionString(options, 'from', 'HEAD'),
      includeExisting: optionBoolean(options, 'include-existing'),
      mode: optionString(options, 'mode')
    });
    return emit({ session: result.session, baseline: result.baseline }, json);
  }
  if (subcommand === 'status') return emit(await adhocStatus(root, positionals[2] ?? null), json);
  if (['diff', 'effects', 'evidence'].includes(subcommand)) {
    return emit(await observeAdhocEffects(root, positionals[2] ?? null), json);
  }
  if (subcommand === 'pause') return emit(await pauseAdhocSession(root, positionals[2] ?? null), json);
  if (subcommand === 'resume') return emit(await resumeAdhocSession(root, positionals[2] ?? null), json);
  if (subcommand === 'land') return emit(await beginAdhocLanding(root, definition, positionals[2] ?? null), json);
  if (subcommand === 'intent') {
    const action = positionals[2] ?? 'show';
    const id = positionals[3] ?? null;
    if (action === 'show') {
      const resolved = await resolveSessionId(root, id);
      return emit(await readSessionRecord(root, resolved, 'intent', { required: false })
        ?? await readSessionRecord(root, resolved, 'candidate'), json);
    }
    if (action === 'confirm') return emit(await confirmAdhocIntent(root, id, adhocOptions(options)), json);
  }
  if (['claim', 'deviate', 'revert'].includes(subcommand)) {
    const disposition = subcommand === 'claim' ? 'claimed' : subcommand === 'deviate' ? 'deviation' : 'revert';
    const id = optionString(options, 'session');
    return emit(await dispositionAdhocResource(root, id, {
      resource: positionals[2],
      all: optionBoolean(options, 'all'),
      disposition,
      clauses: optionStrings(options, 'clause'),
      reason: optionString(options, 'reason')
    }), json);
  }
  if (subcommand === 'landing') {
    const action = positionals[2] ?? 'preview';
    const id = positionals[3] ?? null;
    if (action === 'preview') {
      return emit(await compileAdhocLanding(root, definition, id, {
        testCommand: optionString(options, 'test-command')
      }), json);
    }
    if (action === 'confirm') {
      const resolved = await resolveSessionId(root, id);
      const packet = await readSessionRecord(root, resolved, 'packet');
      const confirm = optionString(options, 'confirm');
      if (packet.packetSha256 !== confirm) {
        throw new SingularityFlowError(`Landing confirmation must equal ${packet.packetSha256}.`, { code: 'ADH_CONFIRMATION_REQUIRED' });
      }
      return emit({ sessionId: resolved, status: 'ready-to-land', packet }, json);
    }
  }
  if (subcommand === 'publish') {
    return emit(await publishAdhocLanding(root, definition, positionals[2] ?? null, {
      confirm: optionString(options, 'confirm')
    }), json);
  }
  if (subcommand === 'sync') {
    const id = await resolveSessionId(root, positionals[2] ?? null);
    return emit(await syncAdhocLanding(root, id), json);
  }
  if (subcommand === 'promote') return emit(await promoteAdhocSession(root, positionals[2] ?? null), json);
  if (subcommand === 'close') {
    if (!optionBoolean(options, 'local-only')) throw new SingularityFlowError('adhoc close requires --local-only.', { code: 'ADH_LOCAL_ONLY' });
    return emit(await closeAdhocLocalOnly(root, positionals[2] ?? null), json);
  }
  if (['run', 'split', 'discard'].includes(subcommand)) return unsupported(subcommand, positionals[2] ?? null);
  throw new SingularityFlowError(`Unknown adhoc subcommand '${subcommand}'.`);
}
