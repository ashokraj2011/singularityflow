import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { currentPhase, sourceTreeHash, validateWorkflow, workDir } from './state.mjs';
import { exists, snapshot, run } from './util.mjs';
import { verifyInputsIntegrity } from './inputs.mjs';
import { verifyAgentIntegrity } from './agents.mjs';
import { verifyGroundingRecord } from './grounding.mjs';
import { verifyPhaseTelemetry } from './telemetry.mjs';

function trackedFiles(root) { return run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean); }
function ids(text, pattern) { return [...new Set([...text.matchAll(pattern)].map((match) => match[0]))]; }

export async function runGovernanceGate(root, config, workflow, { terminal = false } = {}) {
  const errors = [], warnings = [], passes = [];
  const base = await validateWorkflow(root, config, workflow, { strict: true }); errors.push(...base.errors); warnings.push(...base.warnings);
  for (const override of workflow.sequenceOverrides ?? []) {
    warnings.push(`soft sequence gate '${override.gate}' was overridden for ${override.requestedPhase ?? override.before?.currentPhase ?? 'workflow'} during ${override.action}`);
  }

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

  const documentManifest = path.join(workDir(root, config, workflow.workItem.id), 'documents.json');
  if (await exists(documentManifest)) {
    const manifest = JSON.parse(await readFile(documentManifest, 'utf8')); const seen = new Set();
    if (manifest.workId !== workflow.workItem.id) errors.push('document catalog work ID does not match workflow');
    for (const document of manifest.documents ?? []) {
      if (seen.has(document.id)) errors.push(`duplicate document ID: ${document.id}`); seen.add(document.id);
      if (!(workflow.resolution.documents?.allowedPhases ?? []).includes(document.phase)) errors.push(`${document.id} was uploaded outside the immutable document phase policy`);
      if (!document.addedBy || !document.persona) errors.push(`${document.id} is missing actor or persona attribution`);
      if (document.type === 'file') {
        const current = await snapshot(path.join(root, document.path));
        if (!current.exists || current.size !== document.size || current.sha256 !== document.sha256) errors.push(`document integrity failed: ${document.id} (${document.path})`);
      } else if (document.type === 'url' && !/^https?:\/\/\S+$/i.test(document.url ?? '')) errors.push(`${document.id} has an invalid external URL`);
    }
    if ((workflow.documents?.count ?? 0) !== (manifest.documents?.length ?? 0)) errors.push('workflow document count differs from documents.json');
    else passes.push(`document integrity: ${manifest.documents?.length ?? 0} supporting inputs`);
  } else if ((workflow.documents?.count ?? 0) > 0) errors.push('workflow records documents but documents.json is missing');

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
      const grounding = await verifyGroundingRecord(root, config, workflow, phase, { generation });
      errors.push(...grounding.errors); warnings.push(...grounding.warnings); passes.push(...grounding.passes);
      if (grounding.path && await exists(path.join(root, grounding.path)) && found) {
        if (run('git', ['cat-file', '-e', `${found[0]}:${grounding.path}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`grounding composition was not committed with ${phaseId} generation ${generation}`);
        else passes.push(`grounding audit committed: ${phaseId} generation ${generation}`);
        if (grounding.record?.promptPath && run('git', ['cat-file', '-e', `${found[0]}:${grounding.record.promptPath}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`grounding prompt snapshot was not committed with ${phaseId} generation ${generation}`);
      }
      if (workflow.telemetry?.mode === 'work-item-sanitized' || (phase.telemetry ?? []).some((item) => item.generation === generation)) {
        const telemetry = await verifyPhaseTelemetry(root, workflow, phase, generation);
        errors.push(...telemetry.errors); passes.push(...telemetry.passes);
        const telemetryPath = (phase.telemetry ?? []).find((item) => item.generation === generation)?.path;
        if (found && telemetryPath && run('git', ['cat-file', '-e', `${found[0]}:${telemetryPath}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`telemetry audit was not committed with ${phaseId} generation ${generation}`);
      }
      const agentContextRelative = path.posix.join(config.workItemRoot ?? '.singularity/work-items', workflow.workItem.id, 'context', `agents-${phase.id}-gen${generation}.json`);
      if (await exists(path.join(root, agentContextRelative))) {
        if (found && run('git', ['cat-file', '-e', `${found[0]}:${agentContextRelative}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`remote agent context was not committed with ${phaseId} generation ${generation}`);
        else if (found) passes.push(`remote agent audit: ${phaseId} generation ${generation}`);
      }
      for (const output of (phase.remoteOutputs ?? []).filter((entry) => entry.generation === generation)) {
        const outputRecord = path.posix.join(config.workItemRoot ?? '.singularity/work-items', workflow.workItem.id, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${generation}.json`);
        if (!(await exists(path.join(root, outputRecord)))) errors.push(`remote output provenance is missing: ${outputRecord}`);
        else if (found && run('git', ['cat-file', '-e', `${found[0]}:${outputRecord}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`remote output provenance was not committed with ${phaseId} generation ${generation}`);
      }
    }
    const inputIntegrity = await verifyInputsIntegrity(root, workflow, phase, {
      itemDirectory: workDir(root, config, workflow.workItem.id),
      itemRelative: path.posix.join(config.workItemRoot ?? '.singularity/work-items', workflow.workItem.id)
    });
    errors.push(...inputIntegrity.errors); warnings.push(...inputIntegrity.warnings); passes.push(...inputIntegrity.passes);
    const agentIntegrity = await verifyAgentIntegrity(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    errors.push(...agentIntegrity.errors); warnings.push(...agentIntegrity.warnings); passes.push(...agentIntegrity.passes);
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
