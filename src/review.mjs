import { recap } from './narration/recap.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { branch } from './git.mjs';
import { currentPhase, workDir } from './state-stores.mjs';
import { documentCatalog } from './documents.mjs';
import { markerSummary, priorChecklistExceptions, resolvedSpecificationQualityPolicy } from './specification-gate.mjs';
import { STARTER_CHECKLIST, analyzeSpecification, policyHash } from './specification-quality.mjs';
import { exists, run, snapshot } from './util.mjs';

function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function activeApprovals(phase) { return phase.approvals.filter((item) => !item.invalidatedAt); }

export async function createReviewBundle(root, config, workflow, requestedPhase = null) {
  // The account belongs here, in the rendering, and deliberately NOT in the review packet.
  // `readStoryReviewPacket` hashes every field of the packet it reads back, so a recap stored there
  // would put derived narrative text inside the evidence hash — and improving the wording would
  // then invalidate packets and the approvals bound to them. Narration explains the evidence; it
  // must never become part of what the evidence is.
  const narrative = recap(workflow, { locale: 'en-GB', timeZone: 'UTC', length: 'standard' });
  const phase = requestedPhase ? workflow.phases[requestedPhase] : currentPhase(workflow) ?? workflow.phases[workflow.phaseOrder.at(-1)];
  if (!phase) throw new Error('Workflow has no phases to review.');
  if (requestedPhase && !workflow.phases[requestedPhase]) throw new Error(`Unknown phase '${requestedPhase}'.`);
  const itemRoot = workDir(root, config, workflow.workItem.id);
  const artifactPath = path.join(itemRoot, phase.requiredArtifact.path);
  const artifact = await exists(artifactPath) ? { path: path.relative(root, artifactPath).replaceAll(path.sep, '/'), content: await readFile(artifactPath, 'utf8'), ...await snapshot(artifactPath) } : null;
  const inputs = [];
  for (const declaration of phase.inputs ?? []) {
    const producer = workflow.phases[declaration.phase];
    const producerPath = producer ? path.join(itemRoot, producer.requiredArtifact.path) : null;
    inputs.push({ phase: declaration.phase, status: producer?.status ?? 'missing', optional: declaration.optional === true, path: producerPath ? path.relative(root, producerPath).replaceAll(path.sep, '/') : null, sha256: producerPath && await exists(producerPath) ? (await snapshot(producerPath)).sha256 : null });
  }
  const diff = run('git', ['diff', '--stat', `${workflow.workItem.baseBranch}...HEAD`], { cwd: root, allowFailure: true });
  const approvals = activeApprovals(phase).map((item) => ({
    decision: item.decision,
    agent: item.agent,
    authorityGroup: item.authorityGroup ?? null,
    identityAssurance: item.identityAssurance ?? null,
    actor: item.actor?.login ?? item.actor?.email ?? item.actor?.name,
    at: item.at,
    selfApproval: item.selfApproval === true
  }));
  const documents = (await documentCatalog(root, config, workflow)).filter((item) => item.type !== 'system').map(({
    id, type, label, kind, phase: sourcePhase, path: file, url, mimeType, size, sha256, status, generation
  }) => ({ id, type, label, kind, phase: sourcePhase, path: file, url, mimeType, size, sha256, status, generation }));
  /**
   * What the reviewer is actually being asked to judge. `[SPK:REQ-059]`
   *
   * The checklist definition travels with the packet rather than being looked up at reading time,
   * because a reviewer approving against six articles should be able to see the six articles, and
   * because the articles can change — a decision recorded against v1 is not a decision against v2.
   *
   * `analyzeSpecification` is deterministic and takes no clock, so including its findings here does
   * not make the packet vary between renders of the same artifact.
   */
  const quality = resolvedSpecificationQualityPolicy(config, workflow, phase);
  const specificationQuality = quality.mode === 'off' ? null : {
    mode: quality.mode,
    exceptionAuthority: quality.exceptionAuthority,
    checklist: STARTER_CHECKLIST,
    checklistSha256: policyHash(quality, STARTER_CHECKLIST),
    findings: artifact
      ? analyzeSpecification(artifact.content, {
        artifactPath: artifact.path, phase: phase.id, generation: phase.generation, policy: quality
      }).findings
      : [],
    // Assisted candidates are `[SPK:REQ-057]` and not built yet. Rendered as an explicit "none
    // recorded" rather than omitted, so a reader can tell the difference between a specification
    // nobody raised semantic concerns about and a packet that cannot carry them.
    assistedCandidates: []
  };
  const markers = markerSummary(phase);
  const priorExceptions = priorChecklistExceptions(phase);

  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), workItem: workflow.workItem, branch: branch(root), workflowStatus: workflow.status,
    specificationQuality, markers, priorExceptions,
    phase: {
      id: phase.id, label: phase.label, status: phase.status, generation: phase.generation, approvalMinimum: phase.approvalPolicy.minimum ?? 1,
      authorship: [...(phase.authorship ?? [])].reverse().find((record) => record.generation === phase.generation) ?? { producer: 'legacy-unspecified', channel: 'legacy' }
    },
    artifact, inputs, documents, approvals, narrative, selfApprovalWarning: approvals.some((item) => item.selfApproval), checks: phase.checks ?? [], usage: phase.usage ?? [], changeSummary: diff.status === 0 ? diff.stdout.trim() : 'Unavailable'
  };
}

/**
 * The specification-quality section of the packet. `[SPK:REQ-059]`
 *
 * Ordered as a reviewer reads it: what you are being asked (the articles), what the machine could
 * check (deterministic findings), what it explicitly could not (the disclaimer and the empty
 * assisted list), what the document still asks (open markers), and what was let through before
 * (prior exceptions).
 *
 * `[SPK:CON-025]` asks every surface to keep the three questions apart, so the heading says which
 * one this is — a reviewer glancing at "findings" should not read them as failing tests.
 */
function specificationQualitySection(bundle) {
  const quality = bundle.specificationQuality;
  if (!quality && !bundle.markers && !bundle.priorExceptions?.length) return [];
  const lines = ['## Specification quality — is the requirement good enough?', ''];
  if (quality) {
    lines.push(`- Policy: **${quality.mode}** · checklist \`${quality.checklist.id}\` v${quality.checklist.version} (\`${quality.checklistSha256.slice(0, 12)}\`)`);
    if (quality.exceptionAuthority) lines.push(`- Exceptions require: **${quality.exceptionAuthority}**`);
    lines.push('', '### Articles to decide', '');
    for (const article of quality.checklist.articles) lines.push(`- **${article.title}** (\`${article.id}\`) — ${article.question}`);
    lines.push('', '### Deterministic findings', '');
    lines.push(...(quality.findings.length
      ? quality.findings.map((finding) => `- \`${finding.kind}\` — ${finding.message}`)
      : ['- None. This is not a claim that the specification is complete, clear, consistent, or correct; those are the articles above.']));
    lines.push('', '### Assisted candidates', '',
      ...(quality.assistedCandidates.length
        ? quality.assistedCandidates.map((candidate) => `- ${candidate.text}`)
        : ['- None recorded.']));
  }
  if (bundle.markers) {
    lines.push('', '### Open clarification markers', '');
    for (const question of bundle.markers.questions) lines.push(`- (\`${bundle.markers.mode}\`, generation ${bundle.markers.generation}) ${question}`);
  }
  if (bundle.priorExceptions?.length) {
    lines.push('', '### Exceptions already accepted', '');
    for (const entry of bundle.priorExceptions) {
      lines.push(`- \`${entry.article}\` — **${entry.decision}** by ${entry.actor ?? 'unknown'}${entry.generation ? ` at generation ${entry.generation}` : ''}: ${entry.reason ?? 'no reason recorded'}`);
    }
  }
  return [...lines, ''];
}

export function reviewMarkdown(bundle) {
  const lines = [`# Review bundle — ${bundle.workItem.id} / ${bundle.phase.label}`, '', `- Status: **${bundle.phase.status}**`, `- Generation: **${bundle.phase.generation}**`, `- Branch: \`${bundle.branch}\``, `- Generated: ${bundle.generatedAt}`, ''];
  if (bundle.selfApprovalWarning) lines.push('> ⚠ This phase contains self-approval. It is not independent review.', '');
  lines.push('## Authorship', '', `- Producer: **${bundle.phase.authorship?.producer ?? 'legacy-unspecified'}**`, `- Channel: **${bundle.phase.authorship?.channel ?? 'legacy'}**`, `- Kernel model invoked: **${bundle.phase.authorship?.kernelModel?.invoked === true ? 'yes' : bundle.phase.authorship?.kernelModel?.invoked === false ? 'no' : 'unknown'}**`, '');
  lines.push('## Required artifact', '', bundle.artifact ? `- [${bundle.artifact.path}](../../../../${bundle.artifact.path}) — \`${bundle.artifact.sha256}\`` : '_Not generated._', '');
  if (bundle.artifact) lines.push('### Artifact content', '', bundle.artifact.content, '');
  lines.push('## Approved input provenance', '', ...(bundle.inputs.length ? bundle.inputs.map((item) => `- ${item.phase}: ${item.status}${item.sha256 ? ` @ \`${item.sha256.slice(0, 12)}\`` : ''}${item.optional ? ' (optional)' : ''}`) : ['_No phase inputs._']), '');
  lines.push('## Checks and approvals', '', ...(bundle.checks.length ? bundle.checks.map((item) => `- ${item.status ?? 'recorded'} — ${item.command ?? item.name ?? JSON.stringify(item)}`) : ['- No quality-command results recorded.']), ...(bundle.approvals.length ? bundle.approvals.map((item) => `- ${item.decision} by ${item.actor} via ${item.authorityGroup ?? 'unrecorded authority'} (${item.identityAssurance ?? 'unknown assurance'}); governed agent ${item.agent ?? 'unavailable'}${item.selfApproval ? ' ⚠ self-approval' : ''}`) : ['- No decisions recorded.']), '');
  lines.push(...specificationQualitySection(bundle));
  if (bundle.narrative) lines.push('## How this Story got here', '', '```text', bundle.narrative, '```', '');
  lines.push('## Source change summary', '', '```text', bundle.changeSummary || 'No source changes.', '```', '', '## Supporting evidence', '', ...(bundle.documents.length ? bundle.documents.map((item) => `- ${item.id} — ${item.label} (${item.path ?? item.url})`) : ['_No supporting evidence._']), '');
  return `${lines.join('\n')}\n`;
}

export function reviewHtml(bundle) {
  const markdown = reviewMarkdown(bundle);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(bundle.workItem.id)} review</title><style>body{font:16px/1.55 Inter,system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 28px;color:#19231d;background:#f8faf8}pre{white-space:pre-wrap;background:#fff;border:1px solid #d9e1dc;border-radius:12px;padding:24px;box-shadow:0 8px 30px #183f2a10}h1{color:#163e29}</style></head><body><pre>${escapeHtml(markdown)}</pre></body></html>`;
}
