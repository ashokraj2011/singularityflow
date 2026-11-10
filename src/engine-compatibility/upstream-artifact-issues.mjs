/** Read current-phase upstream items; command rendering belongs to the host. */
import path from 'node:path';
import {readdir,readFile} from 'node:fs/promises';
import {discrepancySteps,upstreamDiscrepanciesFromMarkdown} from '../kernel/phase-upstream-discrepancies.mjs';
import {discrepancyIssueRequests} from '../upstream-issues.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
const refused=message=>{throw new SingularityFlowError(message,{code:'UPSTREAM_ISSUE_INVALID'});};

/** The current step's Markdown: registered artifacts, its required artifact and its draft folder. */
async function stepDocuments(root, config, workflow, phase) {
  const item = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const paths = new Set((phase.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean));
  if (phase.requiredArtifact?.path) paths.add(path.posix.join(item, phase.requiredArtifact.path));
  const folder = path.posix.join(item, 'artifacts', phase.id);
  for (const entry of (await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])).slice(0, 50)) {
    if (entry.isFile()) paths.add(path.posix.join(folder, entry.name));
  }
  return [...paths].filter((file) => /\.(?:md|markdown)$/iu.test(file)).sort();
}

/**
 * Items the current step's own documents list under `## Upstream discrepancies`, not yet raised.
 * An item is raised only against the one earlier step it names as its owner; the rest come back
 * with the command that raises them once the author names the step.
 */
export async function recordedDiscrepancies(root, config, workflow) {
  const current = workflow.phases?.[workflow.currentPhase];
  if (!current) refused('The Story has no current step whose artifacts could list discrepancies.');
  const steps = discrepancySteps(workflow);
  const order = steps.map((step) => step.id);
  const earlier = order.slice(0, Math.max(0, order.indexOf(current.id)));
  const entries = [];
  for (const file of await stepDocuments(root, config, workflow, current)) {
    const content = await readFile(path.join(root, file), 'utf8').catch(() => null);
    if (content == null) continue;
    for (const item of upstreamDiscrepanciesFromMarkdown(content, steps, { earlier })) entries.push({ path: file, item });
  }
  const sorted = discrepancyIssueRequests(workflow, entries);
  return sorted;
}
