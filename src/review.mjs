import { recap } from './narration/recap.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { branch } from './git.mjs';
import { currentPhase, workDir } from './state-stores.mjs';
import { documentCatalog } from './documents.mjs';
import { assistedRecordRelative } from './assisted-quality.mjs';
import { citedArticleIds, requiredArticles } from './constitution.mjs';
import { markerSummary, priorChecklistExceptions, resolvedSpecificationQualityPolicy } from './specification-gate.mjs';
import {
  STARTER_CHECKLIST, analyzeSpecification, policyHash, witnessedClauseReviewFields
} from './specification-quality.mjs';
import { extractClauses } from './specifications.mjs';
import { exists, posix, run, snapshot } from './util.mjs';
import { GOVERNED_ROOTS } from './config.mjs';

function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

/**
 * The assisted candidates for exactly this artifact, or none. `[SPK:REQ-059]`
 *
 * The hash comparison is the whole guard. An assisted record is bound to the bytes it read, and a
 * specification regenerated to address a candidate would otherwise still show that candidate in its
 * packet — telling a reviewer a concern stands when it was the reason for the rewrite.
 */
async function assistedCandidatesFor(root, config, workflow, phase, artifact) {
  if (!artifact) return [];
  const relative = assistedRecordRelative(
    posix(path.relative(root, workDir(root, config, workflow.workItem.id))), phase.id, phase.generation
  );
  const file = path.join(root, relative);
  if (!(await exists(file))) return [];
  const record = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (record?.deterministicReport?.artifactSha256 !== artifact.sha256) return [];
  return record.candidates ?? [];
}
function activeApprovals(phase) { return phase.approvals.filter((item) => !item.invalidatedAt); }

export async function witnessMappingReview(root, config, workflow, phase) {
  const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === phase.id && Number(entry.generation) === Number(phase.generation));
  if (!submission) return null;
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, submission.packetSha256);
  const mappings = packet.witnessReview?.clauseMappings ?? [];
  if (!mappings.length) return {
    ...structuredClone(packet.witnessReview ?? {}), mappings: []
  };
  const clauses = new Map();
  for (const producer of Object.values(workflow.phases ?? {})) {
    for (const artifact of producer.artifacts ?? []) {
      if (!['requirements', 'implementation-spec'].includes(artifact.kind)) continue;
      try {
        const historical = run('git', ['show', `${packet.evidenceCommit}:${artifact.path}`], {
          cwd: root, allowFailure: true
        });
        if (historical.status !== 0) continue;
        const content = historical.stdout;
        for (const clause of extractClauses(content, { sourcePath: artifact.path })) {
          clauses.set(clause.id, clause);
        }
      } catch { /* Missing or malformed clauses remain visibly unavailable below. */ }
    }
  }
  return {
    ...structuredClone(packet.witnessReview ?? {}),
    mappings: mappings.slice(0, 1000).map((mapping) => {
      const clause = clauses.get(mapping.clauseId);
      const currentBodySha256 = clause?.bodySha256 ? `sha256:${clause.bodySha256}` : null;
      return {
        ...structuredClone(mapping),
        clauseText: currentBodySha256 === mapping.clauseBodySha256 ? clause.body : null,
        clauseFields: currentBodySha256 === mapping.clauseBodySha256
          ? witnessedClauseReviewFields(clause.body) : null,
        clauseStatus: currentBodySha256 === mapping.clauseBodySha256 ? 'current' : 'stale-or-unavailable'
      };
    })
  };
}

/** The pinned articles in scope for this phase, plus the exceptions recorded against them. */
function constitutionSection(workflow, phase, artifact) {
  const pin = workflow.resolution?.constitutionPin ?? null;
  if (!pin) return null;
  const cited = citedArticleIds(artifact?.content ?? '');
  const scope = new Set(requiredArticles(pin, cited));
  return {
    path: pin.path,
    fileSha256: pin.fileSha256,
    indexSha256: pin.indexSha256,
    cited,
    articles: pin.articles.filter((article) => scope.has(article.id)),
    exceptions: (workflow.constitutionExceptions ?? []).filter((entry) => !entry.phase || entry.phase === phase.id)
  };
}


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
  const reviewBase = workflow.workItem.baseCommit ?? workflow.workItem.baseBranch;
  const diff = run('git', [
    'diff', '--stat', reviewBase, 'HEAD', '--', '.',
    ...GOVERNED_ROOTS.flatMap((root) => [`:(exclude)${root}`, `:(exclude)${root}/**`]),
    ':(exclude).sflow/results/**'
  ], { cwd: root, allowFailure: true });
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
  const agentBriefs = [];
  for (const brief of (phase.agentBriefs ?? []).filter((entry) => entry.generation === phase.generation)) {
    agentBriefs.push({
      ...structuredClone(brief),
      content: brief.renderedPath ? await readFile(path.join(root, brief.renderedPath), 'utf8').catch(() => null) : null
    });
  }
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
  const qualityAnalysis = quality.mode !== 'off' && artifact
    ? analyzeSpecification(artifact.content, {
      artifactPath: artifact.path, phase: phase.id, generation: phase.generation, policy: quality
    })
    : null;
  const specificationQuality = quality.mode === 'off' ? null : {
    mode: quality.mode,
    exceptionAuthority: quality.exceptionAuthority,
    checklist: STARTER_CHECKLIST,
    checklistSha256: policyHash(quality, STARTER_CHECKLIST),
    findings: qualityAnalysis?.findings ?? [],
    witnessedClauses: qualityAnalysis?.witnessedClauses ?? null,
    /**
     * Assisted candidates when present `[SPK:REQ-059]`.
     *
     * Read from the record `spec analyze --assisted` wrote for *this* generation, and only if it
     * was bound to these exact artifact bytes. A candidate list carried over from an earlier
     * generation would describe a document the reviewer is not looking at, and would be at its most
     * misleading precisely when someone had regenerated the specification to address it.
     */
    assistedCandidates: await assistedCandidatesFor(root, config, workflow, phase, artifact)
  };
  const markers = markerSummary(phase);
  const priorExceptions = priorChecklistExceptions(phase);
  const witnessReview = await witnessMappingReview(root, config, workflow, phase);

  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), workItem: workflow.workItem, branch: branch(root), workflowStatus: workflow.status,
    specificationQuality, witnessReview, markers, priorExceptions,
    /**
     * The constitution articles this phase is bound by `[SPK:REQ-101]`, and every exception to them
     * `[SPK:REQ-104]`.
     *
     * Rendered from the Story's pin rather than from the file, so a reviewer sees the articles the
     * author actually wrote against. Cited *and* evidence-required, because an evidence-required
     * article nobody cited is exactly the one most likely to be missed.
     */
    constitution: constitutionSection(workflow, phase, artifact),
    // The durable half of `[SPK:REQ-111]`. Publication warns about incidental change on the terminal
    // of whoever published; the person who has to weigh it is the reviewer, reading this later.
    artifactSet: phase.artifactSet ?? null,
    phase: {
      id: phase.id, label: phase.label, status: phase.status, generation: phase.generation, approvalMinimum: phase.approvalPolicy.minimum ?? 1,
      authorship: [...(phase.authorship ?? [])].reverse().find((record) => record.generation === phase.generation) ?? { producer: 'legacy-unspecified', channel: 'legacy' }
    },
    artifact, inputs, agentBriefs, documents, approvals, narrative, selfApprovalWarning: approvals.some((item) => item.selfApproval), checks: phase.checks ?? [], usage: phase.usage ?? [], changeSummary: diff.status === 0 ? diff.stdout.trim() : 'Unavailable'
  };
}

/**
 * The constitution articles in scope, and every exception to them. `[SPK:REQ-101]` `[SPK:REQ-104]`
 *
 * A judged article is here so a human is asked for its verdict `[SPK:CON-044]` — the kernel cannot
 * form one. An exception is here because an exception is the record of a rule deliberately not
 * followed, and the only thing separating that from a rule quietly ignored is that a reviewer saw it.
 */
function constitutionRendering(bundle) {
  const constitution = bundle.constitution;
  if (!constitution) return [];
  const lines = [
    '## Constitution', '',
    `Pinned: \`${constitution.path}\` (\`${constitution.fileSha256.slice(0, 12)}\`), index \`${constitution.indexSha256.slice(0, 12)}\``,
    `Cited by this artifact: ${constitution.cited.length ? constitution.cited.join(', ') : 'none'}`,
    ''
  ];
  if (!constitution.articles.length) lines.push('_No article is cited and none requires evidence._', '');
  for (const article of constitution.articles) {
    const shape = article.type === 'judged'
      ? `judged/${article.level}${article.evidenceRequired ? ', evidence required' : ''}`
      : 'enforced';
    const asked = article.type === 'judged'
      ? ' — a human records this verdict; the kernel cannot.'
      : ' — enforced by policy; nothing to judge.';
    lines.push(`- **${article.id}** (${shape})${constitution.cited.includes(article.id) ? '' : ' _(not cited; carried because it requires evidence)_'}${asked}`);
  }
  lines.push('', '### Exceptions', '');
  lines.push(...(constitution.exceptions.length
    ? constitution.exceptions.map((entry) =>
      `- **${entry.articleId}** — ${entry.reason} _(scope ${entry.scope}; ${entry.actor?.login ?? entry.actor?.email ?? entry.actor ?? 'unknown'} under ${entry.authority} at ${entry.at}${entry.expiresAt ? `, expires ${entry.expiresAt}` : ''})_`)
    : ['_None recorded._']));
  return [...lines, ''];
}

/**
 * What exactly is being approved. `[SPK:CON-045]` `[SPK:REQ-111]`
 *
 * A reviewer approving "the specification" is in fact approving a bundle, and until the members are
 * listed with their hashes there is no way for them to know how many documents that is. The bundle
 * hash is printed because it is what the approval will record: an approval of this list, not of a
 * file name.
 *
 * The reopen block is the durable disclosure. Publication warns on the terminal of whoever ran it;
 * the person who has to decide whether an unasked-for change is acceptable is reading this.
 */
function artifactSetSection(bundle) {
  const set = bundle.artifactSet;
  if (!set) return [];
  const lines = [
    `## Artifact set — \`${set.setId}\``, '',
    `Approval binds this complete bundle, not a single member: \`${set.bundleSha256.slice(0, 16)}\``, ''
  ];
  for (const member of set.members) {
    const state = member.exists
      ? `\`${member.sha256.slice(0, 12)}\`${member.directory ? ` · ${member.files} file(s)` : ''}`
      : '**missing**';
    lines.push(`- \`${member.member}\` — ${member.role}${member.authority === 'advisory' ? ' _(advisory, never evidence)_' : ''} · ${state}`);
  }
  if (set.missingRequired?.length) lines.push('', `> ⚠ Required member(s) absent: ${set.missingRequired.join(', ')}`);
  if (set.reopen) {
    // Everything in this block is named the way the reviewer named it, so the three lists compare.
    const named = (paths) => paths.map((entry) => set.members.find((member) => member.path === entry)?.member ?? entry);
    lines.push('', '### Surgical reopen', '',
      `- Requested by ${set.reopen.requestedBy?.name ?? set.reopen.requestedBy?.email ?? 'unknown'} (${set.reopen.changeRequestId}): ${set.reopen.reason}`,
      `- Asked to regenerate: ${set.reopen.members.join(', ')}`,
      `- Preserved unchanged: ${set.preserved.length ? named(set.preserved).join(', ') : 'none'}`);
    lines.push(set.reopen.incidental?.length
      ? `- ⚠ Changed although not asked for: ${set.reopen.incidental.join(', ')}`
      : '- No member changed that the reopen did not ask for.');
  }
  return [...lines, ''];
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
    if (quality.witnessedClauses) {
      lines.push('', '### Witnessed clause structure', '',
        `- Profile: \`${quality.witnessedClauses.profile}\` · ${quality.witnessedClauses.analyzedClauseCount}/${quality.witnessedClauses.enrolledClauseCount} clauses analyzed`);
      for (const clause of quality.witnessedClauses.clauses ?? []) {
        const fields = Object.entries(clause.fields ?? {})
          .map(([field, detail]) => `${field} **${detail.status}**`)
          .join(' · ');
        lines.push(`- \`${clause.clauseId}\` — ${fields} · witness **${clause.witnessType ?? clause.declaredWitnessType ?? 'unavailable'}**${clause.enforceable ? ' (typed for future enforcement)' : ' (record only)'}`);
      }
      lines.push('', '> Structural facts only. This does not review witness semantics or prove the requirement.');
    }
    lines.push('', '### Assisted candidates', '',
      ...(quality.assistedCandidates.length
        ? quality.assistedCandidates.map((candidate) => `- \`${candidate.concern}\`${candidate.clauseIds?.length ? ` (${candidate.clauseIds.join(', ')})` : ''} — ${candidate.text}`)
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

function witnessMappingSection(bundle) {
  const review = bundle.witnessReview;
  if (!review?.mappings?.length) return [];
  const lines = [
    '## Witness mapping review — human decision required', '',
    '> Exact static identity and a passing local report do not prove the requirement. Each mapping remains non-authoritative until this review is recorded.', ''
  ];
  for (const mapping of review.mappings) {
    lines.push(`### \`${mapping.clauseId}\` → \`${mapping.logicalTestId}\``, '',
      `- Mapping: \`${mapping.mappingSha256}\``,
      `- Test: \`${mapping.sourcePath}\``,
      `- Declaration: \`${mapping.sourceDeclarationSha256}\``,
      `- Clause bytes: **${mapping.clauseStatus}** · \`${mapping.clauseBodySha256}\``,
      `- Behavior: ${mapping.clauseFields?.behavior ?? '_unavailable_'}`,
      `- Observable: ${mapping.clauseFields?.observable ?? '_unavailable_'}`,
      '', mapping.clauseText ?? '_Exact clause text is stale or unavailable._', '');
  }
  return lines;
}

export function reviewMarkdown(bundle) {
  const lines = [`# Review bundle — ${bundle.workItem.id} / ${bundle.phase.label}`, '', `- Status: **${bundle.phase.status}**`, `- Generation: **${bundle.phase.generation}**`, `- Branch: \`${bundle.branch}\``, `- Generated: ${bundle.generatedAt}`, ''];
  if (bundle.selfApprovalWarning) lines.push('> ⚠ This phase contains self-approval. It is not independent review.', '');
  lines.push('## Authorship', '', `- Producer: **${bundle.phase.authorship?.producer ?? 'legacy-unspecified'}**`, `- Channel: **${bundle.phase.authorship?.channel ?? 'legacy'}**`, `- Kernel model invoked: **${bundle.phase.authorship?.kernelModel?.invoked === true ? 'yes' : bundle.phase.authorship?.kernelModel?.invoked === false ? 'no' : 'unknown'}**`, '');
  lines.push('## Required artifact', '', bundle.artifact ? `- [${bundle.artifact.path}](../../../../${bundle.artifact.path}) — \`${bundle.artifact.sha256}\`` : '_Not generated._', '');
  if (bundle.artifact) lines.push('### Artifact content', '', bundle.artifact.content, '');
  lines.push('## Downstream agent briefs', '');
  if (!bundle.agentBriefs?.length) lines.push('_No approved-summary projections are configured for this phase._', '');
  else for (const brief of bundle.agentBriefs) {
    lines.push(`### Consumer: \`${brief.consumerPhase}\``, '',
      `- Status: **${brief.status}**`,
      `- Source SHA-256: \`${brief.sourceSha256}\``,
      `- Integrity SHA-256: \`${brief.integritySha256}\``, '');
    if (brief.content) lines.push(brief.content, '');
    else lines.push('_This consumer is configured to fall back to the complete approved artifact._', '');
  }
  lines.push('## Approved input provenance', '', ...(bundle.inputs.length ? bundle.inputs.map((item) => `- ${item.phase}: ${item.status}${item.sha256 ? ` @ \`${item.sha256.slice(0, 12)}\`` : ''}${item.optional ? ' (optional)' : ''}`) : ['_No phase inputs._']), '');
  lines.push('## Checks and approvals', '', ...(bundle.checks.length ? bundle.checks.map((item) => `- ${item.status ?? 'recorded'} — ${item.command ?? item.name ?? JSON.stringify(item)}`) : ['- No quality-command results recorded.']), ...(bundle.approvals.length ? bundle.approvals.map((item) => `- ${item.decision} by ${item.actor} via ${item.authorityGroup ?? 'unrecorded authority'} (${item.identityAssurance ?? 'unknown assurance'}); governed agent ${item.agent ?? 'unavailable'}${item.selfApproval ? ' ⚠ self-approval' : ''}`) : ['- No decisions recorded.']), '');
  lines.push(
    ...constitutionRendering(bundle),
    ...artifactSetSection(bundle),
    ...specificationQualitySection(bundle),
    ...witnessMappingSection(bundle)
  );
  if (bundle.narrative) lines.push('## How this Story got here', '', '```text', bundle.narrative, '```', '');
  lines.push('## Source change summary', '', '```text', bundle.changeSummary || 'No source changes.', '```', '', '## Supporting evidence', '', ...(bundle.documents.length ? bundle.documents.map((item) => `- ${item.id} — ${item.label} (${item.path ?? item.url})`) : ['_No supporting evidence._']), '');
  return `${lines.join('\n')}\n`;
}

export function reviewHtml(bundle) {
  const markdown = reviewMarkdown(bundle);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(bundle.workItem.id)} review</title><style>body{font:16px/1.55 Inter,system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 28px;color:#19231d;background:#f8faf8}pre{white-space:pre-wrap;background:#fff;border:1px solid #d9e1dc;border-radius:12px;padding:24px;box-shadow:0 8px 30px #183f2a10}h1{color:#163e29}</style></head><body><pre>${escapeHtml(markdown)}</pre></body></html>`;
}
