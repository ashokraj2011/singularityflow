/**
 * The archived-workflow list (docs/SPEC-WORKFLOW-RETIREMENT-v1.md): `singularity/workflow-archive.yml`,
 * `{ version: 1, archived: { story: { <id>: { reason } }, initiative: { … } } }`. Archived workflows
 * stay in the configuration and keep every running Story working; new Stories cannot choose them.
 * Its own file, so an engine that does not know it keeps working. Small on purpose: Story creation
 * and every workflow list read it.
 */
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { SingularityFlowError, secureRepositoryPath } from './util.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';

export const WORKFLOW_ARCHIVE_PATH = 'singularity/workflow-archive.yml';

function invalid(label, detail) {
  throw new SingularityFlowError(`${label} is invalid: ${detail}.`, { code: 'WORKFLOW_ARCHIVE_INVALID' });
}

/** The archived workflows by kind; refuses anything but the exact shape. */
export function parseWorkflowArchive(text, label = WORKFLOW_ARCHIVE_PATH) {
  let value;
  try { value = YAML.parse(text) ?? {}; }
  catch (error) { throw new SingularityFlowError(`Cannot parse ${label}: ${error.message}`, { code: 'WORKFLOW_ARCHIVE_INVALID' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label, 'it must be a mapping');
  if (Object.keys(value).some((key) => !['version', 'archived'].includes(key))) invalid(label, 'only version and archived are allowed');
  if (value.version !== 1) invalid(label, 'version must be 1');
  const archived = value.archived ?? {};
  if (!archived || typeof archived !== 'object' || Array.isArray(archived)
      || Object.keys(archived).some((key) => !['story', 'initiative'].includes(key))) invalid(label, 'archived holds story and initiative only');
  const result = { story: {}, initiative: {} };
  for (const governs of ['story', 'initiative']) {
    const entries = archived[governs] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) invalid(label, `archived.${governs} must be a mapping`);
    for (const [id, entry] of Object.entries(entries)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) invalid(label, `'${id}' is not a workflow ID`);
      const record = entry ?? {};
      if (typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some((key) => key !== 'reason')
          || (record.reason != null && (typeof record.reason !== 'string' || record.reason.length > 500))) {
        invalid(label, `${governs}:${id} holds only an optional reason`);
      }
      result[governs][id] = record.reason ? { reason: record.reason } : {};
    }
  }
  return result;
}

/** The archive read from `directory` itself (a working tree or a proposal's scratch checkout). */
export async function readWorkflowArchiveAt(directory) {
  const secured = await secureRepositoryPath(directory, WORKFLOW_ARCHIVE_PATH, { label: WORKFLOW_ARCHIVE_PATH, type: 'file' });
  if (!secured.exists) return { story: {}, initiative: {} };
  return parseWorkflowArchive(await readFile(secured.absolute, 'utf8'));
}

/** The repository's archived workflows, read from the approved configuration. */
export function readWorkflowArchive(root) {
  return readWorkflowArchiveAt(configurationReadRoot(root));
}

export function workflowArchived(archive, governs, id) {
  return Object.hasOwn(archive?.[governs] ?? {}, id);
}

/** The first live Story workflow, for a Story created without naming one. */
export function firstLiveStoryWorkflow(workTypes, archive) {
  return Object.keys(workTypes ?? {}).find((id) => !workflowArchived(archive, 'story', id)) ?? null;
}

/** Refuse a new Story on an archived workflow. A running Story never passes through here again. */
export function assertWorkflowNotArchived(archive, workType) {
  if (!workflowArchived(archive, 'story', workType)) return;
  throw new SingularityFlowError(`Workflow '${workType}' is archived, so new Stories cannot use it. Choose another workflow, or restore it with `
    + `singularity-flow workflow restore ${workType} --propose.`, { code: 'WORKFLOW_ARCHIVED', details: {
    workflow: workType, nextAction: { command: `singularity-flow workflow restore ${workType} --propose --json` }
  } });
}
