import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { currentPhase, sourceTreeHash, validateWorkflow, workDir } from './state.mjs';
import { exists, snapshot, run } from './util.mjs';

function trackedFiles(root) { return run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean); }
function ids(text, pattern) { return [...new Set([...text.matchAll(pattern)].map((match) => match[0]))]; }

export async function runGovernanceGate(root, config, workflow, { terminal = false } = {}) {
  const errors = [], warnings = [], passes = [];
  const base = await validateWorkflow(root, config, workflow, { strict: true }); errors.push(...base.errors); warnings.push(...base.warnings);

  if (!config._legacy && workflow.resolution.configSha256) {
    const current = await snapshot(path.join(root, '.singularity/workflow.yml'));
    if (current.sha256 !== workflow.resolution.configSha256) errors.push('workflow.yml differs from the immutable work-item configuration snapshot');
    for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
      const present = await snapshot(path.join(root, template.path));
      if (present.sha256 !== template.sha256) errors.push(`template snapshot changed for ${phaseId}: ${template.path}`);
    }
    if (workflow.resolution.sourceSha256) {
      const source = await snapshot(path.join(workDir(root, config, workflow.workItem.id), 'source.json'));
      if (source.sha256 !== workflow.resolution.sourceSha256) errors.push('source.json differs from the immutable source snapshot');
    }
  }

  const diff = run('git', ['diff', '--name-only', `${workflow.workItem.baseBranch}...HEAD`], { cwd: root, allowFailure: true });
  if (diff.status === 0) {
    const changed = diff.stdout.split(/\r?\n/).filter(Boolean);
    for (const protectedPath of config.governance?.protectedPaths ?? []) {
      if (changed.some((file) => file === protectedPath || file.startsWith(`${protectedPath}/`))) errors.push(`protected process path changed on work branch: ${protectedPath}`);
    }
  } else warnings.push(`could not compare protected process paths with ${workflow.workItem.baseBranch}`);

  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    for (let generation = 1; generation <= (phase.generation ?? 0); generation += 1) {
      const subject = `[${workflow.workItem.id}][phase:${phase.id}][generated:${generation}]`;
      const found = run('git', ['log', '--format=%H%x09%s', '--fixed-strings', '--grep', subject], { cwd: root, allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')).find(([, message]) => message.startsWith(subject));
      if (!found) errors.push(`${phaseId} generation ${generation} has no required Git commit`);
      else if (config.git?.publish === 'required') {
        const remoteRef = `refs/remotes/${config.git.remote ?? 'origin'}/${workflow.workItem.branch}`;
        const published = run('git', ['merge-base', '--is-ancestor', found[0], remoteRef], { cwd: root, allowFailure: true });
        if (published.status !== 0) errors.push(`${phaseId} generation ${generation} is not present on the remote branch`);
      }
    }
    if (phase.status !== 'approved') continue;
    const decisions = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved');
    const distinct = new Set(decisions.map((item) => item.actor?.login ?? item.actor?.email ?? item.actor?.name));
    if (distinct.size < (phase.approvalPolicy.minimum ?? 1)) errors.push(`${phaseId} has ${distinct.size} distinct approvals; requires ${phase.approvalPolicy.minimum ?? 1}`);
    for (const decision of decisions) {
      if (!(phase.approvalPolicy.personas ?? []).includes(decision.persona)) errors.push(`${phaseId} was approved using unauthorized persona '${decision.persona}'`);
      if (decision.selfApproval) warnings.push(`${phaseId} is self-approved by ${decision.actor?.name ?? 'unknown'} as ${decision.persona}`);
    }
    for (const artifact of phase.artifacts) {
      const current = await snapshot(path.join(root, artifact.path));
      if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) errors.push(`STALE ${phaseId} approval: ${artifact.path} changed after approval`);
    }
    const required = path.join(root, config.workItemRoot, workflow.workItem.id, phase.requiredArtifact.path);
    const text = await readFile(required, 'utf8').catch(() => '');
    if (decisions.some((item) => item.selfApproval) && !/"selfApproval": true/.test(text)) errors.push(`${phaseId} artifact does not expose its self-approval warning`);
    passes.push(`approval integrity: ${phaseId}`);
  }

  if (config.governance?.requireAcceptanceCriteriaTags) {
    const requirements = workflow.phaseOrder.includes('requirements') ? path.join(workDir(root, config, workflow.workItem.id), workflow.phases.requirements.requiredArtifact.path) : null;
    if (requirements && await exists(requirements)) {
      const acIds = ids(await readFile(requirements, 'utf8'), /\bAC-\d+\b/g); const tags = new Set();
      for (const file of trackedFiles(root).filter((item) => /(^|\/)(test|tests|__tests__)(\/|\.|$)|\.(test|spec)\./i.test(item))) {
        const text = await readFile(path.join(root, file), 'utf8').catch(() => ''); for (const match of text.matchAll(/@ac:\s*(AC-\d+)/g)) tags.add(match[1]);
      }
      for (const id of acIds) if (!tags.has(id)) errors.push(`AC coverage: ${id} has no test tagged @ac:${id}`);
      if (acIds.length && acIds.every((id) => tags.has(id))) passes.push(`acceptance coverage: ${acIds.length} criteria mapped`);
    }
  }

  if (workflow.phases.conformance?.generation > 0) {
    const phase = workflow.phases.conformance; const reportPath = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path); const report = await readFile(reportPath, 'utf8');
    const expected = new Set();
    for (const phaseId of ['requirements', 'implementation-spec', 'fix-spec']) {
      const source = workflow.phases[phaseId]; if (!source) continue;
      const text = await readFile(path.join(workDir(root, config, workflow.workItem.id), source.requiredArtifact.path), 'utf8').catch(() => '');
      ids(text, /\b(?:AC|SPEC)-\d+\b/g).forEach((id) => expected.add(id));
    }
    for (const id of expected) if (!report.includes(id)) errors.push(`conformance report has no row for ${id}`);
    for (const [phaseId, prior] of Object.entries(workflow.phases)) {
      for (const approval of prior.approvals.filter((item) => !item.invalidatedAt && item.selfApproval)) {
        const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name;
        if (!report.includes(phaseId) || (actor && !report.includes(actor))) errors.push(`conformance report does not disclose self-approval for ${phaseId} by ${actor}`);
      }
    }
    if (!/\b(matched|partial|missing|deviated|unplanned)\b/.test(report)) errors.push('conformance report has no recognized verdict');
    if (phase.conformanceTree !== await sourceTreeHash(root)) errors.push('conformance report is stale: source/test tree changed after comparison');
    else passes.push(`conformance freshness: ${expected.size} traced identifiers`);
  }

  if (config.git?.publish === 'required' && terminal) {
    const remote = config.git.remote ?? 'origin'; const remoteHead = run('git', ['ls-remote', remote, `refs/heads/${workflow.workItem.branch}`], { cwd: root, allowFailure: true }).stdout.trim().split(/\s+/)[0];
    const localHead = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    if (remoteHead !== localHead) errors.push(`terminal: local HEAD is not published to ${remote}/${workflow.workItem.branch}`);
    else passes.push('remote publication');
  }

  if (terminal) {
    for (const phaseId of workflow.phaseOrder) if (workflow.phases[phaseId]?.status !== 'approved') errors.push(`terminal: phase ${phaseId} is not approved`);
    if (workflow.status !== 'complete' || currentPhase(workflow)) errors.push('terminal: workflow is not complete'); else passes.push('terminal lifecycle');
  }
  return { errors, warnings, passes };
}
