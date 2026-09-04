/**
 * The only place terminal prose for a command result is produced.
 *
 * Handlers return data. This turns it into words. Keeping that boundary is what lets the wording
 * improve, or be translated, without touching a handler — and what stops a future handler printing
 * a reassuring sentence that its own effects contradict.
 */
import { MESSAGES, REASONS } from './messages.mjs';
import { preservedEverything } from './command-result.mjs';
import { approvalChainText } from '../approval-chain.mjs';
import { contextXrayText } from '../context-xray.mjs';
import { tokenLedgerText } from '../token-ledger.mjs';
import { table } from '../util.mjs';
import * as style from '../style.mjs';

/**
 * The reassurance line, derived from declared effects rather than authored.
 *
 * `preserves` in the catalog only marks a message as *allowed* to reassure; what it says is
 * computed here from what the command reports it changed. A message can never promise more than
 * the effects support.
 */
function preservationLine(result) {
  if (!preservedEverything(result)) return null;
  const message = MESSAGES[result.outcome.messageId];
  if (!message?.preserves) return null;
  return 'No governed state, files, publications or external systems were changed.';
}

function headline(result) {
  const message = MESSAGES[result.outcome.messageId];
  if (!message) return result.outcome.messageId;
  return message.headline(result.outcome.slots ?? {});
}

function whyLines(result) {
  return result.why
    .map((entry) => {
      const reason = REASONS[entry.code];
      const text = reason ? reason.render(entry.slots ?? {}) : entry.code;
      // The friendly reason carries its provenance. A citation a reviewer cannot resolve is a
      // claim, not evidence, so the immutable reference stays visible beside the readable line.
      const lines = [entry.ref ? `  - ${text}\n      ↳ ${entry.source}:${entry.ref}` : `  - ${text}`];
      // A terminal has no links, so the deep link is the command that would follow it. Explaining
      // *why* something was refused is only half an answer when the reader does not yet know what
      // the thing being refused is called `[DOC:REQ-041]`.
      if (entry.topic) lines.push(`      ↳ sflow explain ${entry.topic}`);
      return lines.join('\n');
    });
}

function nextLines(result) {
  const order = { NOW: 0, SOON: 1, LATER: 2 };
  return [...result.next]
    .sort((a, b) => (order[a.rank] - order[b.rank]) || a.id.localeCompare(b.id))
    // The command is the thing the reader came for, so it is the thing that carries the emphasis.
    .map((entry) => `  ${style.detail(entry.rank.padEnd(5))} ${entry.label}\n        ${style.action(entry.command)}`);
}

function goalLines(result) {
  if (!result.operation.id.startsWith('goal.')) return [];
  const { goal, goals, links = [], activeGoalId } = result.data ?? {};
  if (Array.isArray(goals)) {
    if (!goals.length) return ['', style.detail('No Goals match this view.')];
    return ['', ...goals.flatMap((item) => [
      `${item.id === activeGoalId ? style.pass('●') : '○'} ${style.heading(item.id)}  ${item.statement}`,
      `  ${style.detail(`${item.status} · ${item.links?.length ?? item.linkedWork ?? 0} linked work item(s) · ${item.successCriteria?.length ?? 'governed'} success criterion/criteria`)}`
    ])];
  }
  if (!goal) return [];
  const lines = [
    '',
    style.heading(goal.statement),
    style.detail(`Goal: ${goal.id} · ${goal.status} · ${goal.authority === 'governed-execution' ? 'governed execution' : 'personal advisory state'}`),
    '',
    style.heading('Success means:'),
    ...goal.successCriteria.map((criterion) => `  - ${criterion}`)
  ];
  if (goal.links.length) {
    lines.push('', style.heading('Governed work:'));
    const facts = new Map(links.map((link) => [`${link.repositoryId}:${link.kind}:${link.id}`, link]));
    for (const link of goal.links) {
      const live = facts.get(`${link.repositoryId}:${link.kind}:${link.id}`);
      lines.push(`  - ${link.id} · ${link.repositoryId} · ${live?.status ?? 'not inspected'}${live?.phase ? ` · ${live.phase}` : ''}`);
    }
  }
  return lines;
}

function journalLines(result) {
  if (!result.operation.id.startsWith('journal.')) return [];
  const data = result.data ?? {};
  if (result.operation.id === 'journal.today') {
    const lines = ['', style.detail(data.privacy?.label ?? 'Stored locally · Never pushed')];
    if (!data.summaries?.length && !data.attention?.length) {
      lines.push('No local engineering outcomes were recorded for this day. This is not an activity or productivity judgment.');
    } else {
      for (const item of data.summaries ?? []) lines.push(`${style.pass('✓')} ${item.workId ? `${item.workId} · ` : ''}${item.text}`);
      for (const item of data.attention ?? []) lines.push(`${style.pending('!')} ${item.workId ? `${item.workId} · ` : ''}${item.text}`);
    }
    if (data.malformedLines?.length) lines.push(style.detail(`Warning: ${data.malformedLines.length} malformed local event line(s) were ignored.`));
    return lines;
  }
  if (result.operation.id === 'journal.doctor') {
    return ['', ...(data.findings ?? []).map((finding) => `  - [${finding.state}] ${finding.id}: ${finding.detail}`)];
  }
  if (result.operation.id.startsWith('journal.settings') || ['journal.pause', 'journal.resume'].includes(result.operation.id)) {
    return ['',
      `  Mode: ${data.mode}`,
      `  Paused: ${data.paused ? 'yes' : 'no'}`,
      `  Retention: ${data.retentionDays} days`,
      `  Time zone: ${data.timeZone}`,
      style.detail('Prompt content, source bytes, command output, file saves, and remote sync are disabled.')
    ];
  }
  if (result.operation.id === 'journal.export.preview' && data.preview) return ['', data.preview.trimEnd()];
  if (result.operation.id === 'journal.export' && data.file) {
    return ['', style.detail(`Wrote ${data.file} outside registered worktrees. Nothing was uploaded or staged.`)];
  }
  return [];
}

function comprehensionText(result) {
  const { context = {}, manifest = null, coverage = null } = result.data ?? {};
  const common = [
    style.heading(headline(result)),
    `Repository: ${context.repository ?? 'unavailable'}`,
    `Repository change-set subject: ${manifest?.compatibilityCandidateSha256 ?? coverage?.candidateSha256 ?? 'unavailable'}`,
    `Baseline: ${context.base ?? 'unavailable'} (${context.source ?? 'unknown'})`
  ];
  if (result.operation.id === 'comprehension.regions' && manifest) {
    const rows = manifest.regions.map((region) => ({
      region: region.regionId,
      operation: region.operation,
      path: region.location.pathAfter ?? region.location.pathBefore ?? '(unknown)',
      assurance: region.classification.assurance
    }));
    return [
      ...common,
      `Granularity: ${manifest.granularity}; structural assurance: ${manifest.structuralAssurance}`,
      'Every region is conservatively material and in scope; ownership has not been inferred.',
      ...(rows.length ? ['', table(rows, [
        { key: 'region', label: 'REGION' },
        { key: 'operation', label: 'OPERATION' },
        { key: 'path', label: 'PATH' },
        { key: 'assurance', label: 'ASSURANCE' }
      ])] : []),
      '', style.detail('Observe only and non-authoritative: this result neither authorizes nor blocks publication.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.check' && coverage) {
    const rows = coverage.unresolved.map((entry) => ({
      region: entry.regionId,
      path: entry.path ?? '(unknown)',
      reason: entry.reason
    }));
    return [
      ...common,
      `Assessment: ${coverage.verdict}; unresolved: ${coverage.counts.unresolved}/${coverage.counts.materialRegions}`,
      ...(rows.length ? ['', table(rows, [
        { key: 'region', label: 'REGION' },
        { key: 'path', label: 'PATH' },
        { key: 'reason', label: 'REASON' }
      ])] : []),
      '', style.detail('Observe only and non-authoritative: this assessment neither authorizes nor blocks publication.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  return [style.heading(headline(result)), preservationLine(result)].filter(Boolean).join('\n\n');
}

const REST_STATE_LINES = Object.freeze({
  complete: 'This work is complete. There is nothing further to do.',
  cancelled: 'This work is cancelled and archived.',
  'awaiting-others': 'Nothing to do here — this is waiting on someone else.',
  informational: null
});

export function renderCommandResult(result) {
  if (result.operation.id === 'precheck.quick' && result.data?.precheck) {
    const precheck = result.data.precheck;
    return [
      style.heading(headline(result)),
      ...precheck.checks.map((check) => `${check.status === 'pass' ? style.pass('✓') : check.status === 'fail' ? style.failure('✖') : style.pending('~')} ${check.id}: ${check.subject}${check.reason ? ` (${check.reason})` : ''}`),
      `Proof readiness: ${precheck.proofReadiness}. No project command was run.`,
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id.startsWith('comprehension.')) return comprehensionText(result);
  if (result.operation.id.startsWith('auto.') && result.data?.card) return result.data.card;
  if (result.operation.id === 'approvals' && result.data?.approvalChain) {
    return approvalChainText(result.data.approvalChain).trimEnd();
  }
  if (result.operation.id === 'context' && result.data?.xray) {
    return [contextXrayText(result.data.xray), preservationLine(result)].filter(Boolean).join('\n\n');
  }
  if (result.operation.id === 'context.compile' && result.data?.packet) {
    return JSON.stringify(result.data.packet, null, 2);
  }
  if (result.operation.id === 'context.expand' && result.data?.expansion) {
    const expansion = result.data.expansion;
    return [
      `CONTEXT EXPANSION · ${expansion.packetId} · ${expansion.representation}`,
      '', expansion.content, '',
      `${expansion.accounting.includedContentBytes.toLocaleString('en-US')} bytes · ${expansion.accounting.estimatedInputTokens.toLocaleString('en-US')} estimated tokens`
    ].join('\n');
  }
  if (result.operation.id === 'context.doctor' && result.data?.diagnostic) {
    const { status, policy, profile, configurationDigest } = result.data.diagnostic;
    return [
      `TOKEN ECONOMY · ${status} · ${policy.mode} · profile ${profile.id}`,
      `Estimated prompt ${profile.maximumEstimatedPromptTokens.toLocaleString('en-US')} · reserved output ${profile.reservedOutputTokens.toLocaleString('en-US')} · expansion ${profile.maxExpansionTokens.toLocaleString('en-US')} tokens`,
      `Observation firewall ${policy.observationFirewall ? 'on' : 'off'} · progressive retrieval ${policy.progressiveRetrieval ? 'on' : 'off'} · provider telemetry ${policy.providerTelemetry}`,
      `Configuration ${configurationDigest}`
    ].join('\n');
  }
  if (result.operation.id === 'tokens' && result.data?.ledger) {
    return [tokenLedgerText(result.data.ledger), preservationLine(result)].filter(Boolean).join('\n\n');
  }
  // A refusal is the one outcome the reader must not skim past, so it is the one that gets weight.
  const emphasise = ['refused', 'failed'].includes(result.outcome.status) ? style.failure : style.heading;
  const lines = [emphasise(headline(result))];

  lines.push(...goalLines(result));
  lines.push(...journalLines(result));

  const preservation = preservationLine(result);
  if (preservation) lines.push(style.detail(preservation));

  const why = whyLines(result);
  if (why.length) lines.push('', style.heading('Why:'), ...why);

  const next = nextLines(result);
  if (next.length) lines.push('', style.heading('Next:'), ...next);
  else if (result.restState) {
    const rest = REST_STATE_LINES[result.restState];
    if (rest) lines.push('', rest);
  }

  return lines.join('\n');
}
