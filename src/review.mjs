import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { branch } from './git.mjs';
import { currentPhase, workDir } from './state.mjs';
import { documentCatalog } from './documents.mjs';
import { exists, run, snapshot } from './util.mjs';

function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function activeApprovals(phase) { return phase.approvals.filter((item) => !item.invalidatedAt); }

export async function createReviewBundle(root, config, workflow, requestedPhase = null) {
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
  const approvals = activeApprovals(phase).map((item) => ({ decision: item.decision, persona: item.persona, actor: item.actor?.login ?? item.actor?.email ?? item.actor?.name, at: item.at, selfApproval: item.selfApproval === true }));
  const documents = (await documentCatalog(root, config, workflow)).filter((item) => item.type !== 'system').map(({ id, label, kind, phase: sourcePhase, path: file, url, sha256 }) => ({ id, label, kind, phase: sourcePhase, path: file, url, sha256 }));
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), workItem: workflow.workItem, branch: branch(root), workflowStatus: workflow.status,
    phase: { id: phase.id, label: phase.label, status: phase.status, generation: phase.generation, approvalMinimum: phase.approvalPolicy.minimum ?? 1 },
    artifact, inputs, documents, approvals, selfApprovalWarning: approvals.some((item) => item.selfApproval), checks: phase.checks ?? [], usage: phase.usage ?? [], changeSummary: diff.status === 0 ? diff.stdout.trim() : 'Unavailable'
  };
}

export function reviewMarkdown(bundle) {
  const lines = [`# Review bundle — ${bundle.workItem.id} / ${bundle.phase.label}`, '', `- Status: **${bundle.phase.status}**`, `- Generation: **${bundle.phase.generation}**`, `- Branch: \`${bundle.branch}\``, `- Generated: ${bundle.generatedAt}`, ''];
  if (bundle.selfApprovalWarning) lines.push('> ⚠ This phase contains self-approval. It is not independent review.', '');
  lines.push('## Required artifact', '', bundle.artifact ? `- [${bundle.artifact.path}](../../../../${bundle.artifact.path}) — \`${bundle.artifact.sha256}\`` : '_Not generated._', '');
  if (bundle.artifact) lines.push('### Artifact content', '', bundle.artifact.content, '');
  lines.push('## Approved input provenance', '', ...(bundle.inputs.length ? bundle.inputs.map((item) => `- ${item.phase}: ${item.status}${item.sha256 ? ` @ \`${item.sha256.slice(0, 12)}\`` : ''}${item.optional ? ' (optional)' : ''}`) : ['_No phase inputs._']), '');
  lines.push('## Checks and approvals', '', ...(bundle.checks.length ? bundle.checks.map((item) => `- ${item.status ?? 'recorded'} — ${item.command ?? item.name ?? JSON.stringify(item)}`) : ['- No quality-command results recorded.']), ...(bundle.approvals.length ? bundle.approvals.map((item) => `- ${item.decision} by ${item.actor} as ${item.persona}${item.selfApproval ? ' ⚠ self-approval' : ''}`) : ['- No decisions recorded.']), '');
  lines.push('## Source change summary', '', '```text', bundle.changeSummary || 'No source changes.', '```', '', '## Supporting evidence', '', ...(bundle.documents.length ? bundle.documents.map((item) => `- ${item.id} — ${item.label} (${item.path ?? item.url})`) : ['_No supporting evidence._']), '');
  return `${lines.join('\n')}\n`;
}

export function reviewHtml(bundle) {
  const markdown = reviewMarkdown(bundle);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(bundle.workItem.id)} review</title><style>body{font:16px/1.55 Inter,system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 28px;color:#19231d;background:#f8faf8}pre{white-space:pre-wrap;background:#fff;border:1px solid #d9e1dc;border-radius:12px;padding:24px;box-shadow:0 8px 30px #183f2a10}h1{color:#163e29}</style></head><body><pre>${escapeHtml(markdown)}</pre></body></html>`;
}
