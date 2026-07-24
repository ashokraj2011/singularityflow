import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  findOrCreateIssue, getIssue, getMyPermissions, listEpicStories, updateIssue
} from './jira.mjs';
import {
  initiativeBreakdownDocument, loadInitiativeBreakdown, validateInitiativeBreakdown
} from './initiative-repositories.mjs';
import {
  loadInitiative, saveInitiative, secureInitiativePath
} from './initiative-state.mjs';
import {
  SingularityFlowError, nowIso, writeJson, writeText
} from './util.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function jiraPath(root, portfolio, initiativeId, relative = '', options = {}) {
  return secureInitiativePath(root, portfolio, initiativeId, path.join('context', 'jira', relative), {
    label: options.label ?? `Initiative '${initiativeId}' Jira path`,
    mustExist: options.mustExist ?? false,
    type: options.type ?? null
  });
}

function onlyRepository(portfolio) {
  const ids = Object.keys(portfolio.repositories);
  return ids.length === 1 ? ids[0] : null;
}

function repositoryFor(issueKey, mapping, portfolio) {
  return mapping?.[issueKey] ?? onlyRepository(portfolio);
}

function importedStoryId(index) {
  return `STORY-${String(index + 1).padStart(3, '0')}`;
}

function issueForRepository(issue, policy) {
  const copy = structuredClone(issue);
  if (policy.read?.attachmentPolicy === 'none') copy.attachments = [];
  else copy.attachments = (copy.attachments ?? []).map(({ url: _url, ...metadata }) => metadata);
  return copy;
}

function descriptionWithAcceptance(item) {
  return [
    item.description,
    item.acceptanceCriteria?.length ? `Acceptance criteria:\n${item.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

function materializationPhase(initiative) {
  return initiative.phaseOrder.includes('elaboration') ? 'elaboration' : initiative.phaseOrder.includes('plan') ? 'plan' : null;
}

export function buildJiraBreakdownDraft(epic, stories, portfolio, {
  repositoryMap = {}
} = {}) {
  const draft = {
    version: 1,
    initiativeId: null,
    source: {
      type: 'jira',
      epicKey: epic.key,
      epicUpdatedAt: epic.updatedAt,
      fetchedAt: nowIso()
    },
    epics: [{
      id: 'EPIC-001',
      jiraKey: epic.key,
      title: epic.title,
      description: epic.description ?? '',
      acceptanceCriteria: epic.acceptanceCriteria ? [epic.acceptanceCriteria] : [],
      stories: stories.map((story, index) => ({
        id: importedStoryId(index),
        jiraKey: story.key,
        title: story.title,
        description: story.description ?? '',
        acceptanceCriteria: story.acceptanceCriteria ? [story.acceptanceCriteria] : [],
        repository: repositoryFor(story.key, repositoryMap, portfolio),
        blocking: true,
        suggestedWorkType: story.issueType?.toLowerCase().includes('bug') ? 'bugfix' : 'feature',
        estimate: story.storyPoints ?? null,
        dependsOn: [],
        consumesContracts: []
      }))
    }]
  };
  const unresolved = draft.epics[0].stories
    .filter((story) => !story.repository || !portfolio.repositories[story.repository])
    .map((story) => ({ storyId: story.id, jiraKey: story.jiraKey, title: story.title }));
  return { draft, unresolved, ready: unresolved.length === 0 };
}

export async function previewJiraAdoption(root, initiativeId, epicKey, {
  repositoryMap = {},
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot. Start a new initiative after enabling Jira.');
  const [remoteEpic, remoteStories] = await Promise.all([
    getIssue(epicKey, { connection, env, fetchImpl }),
    listEpicStories(epicKey, { connection, env, fetchImpl })
  ]);
  const epic = issueForRepository(remoteEpic, policy);
  const stories = remoteStories.map((story) => issueForRepository(story, policy));
  const built = buildJiraBreakdownDraft(epic, stories, portfolio, { repositoryMap });
  built.draft.initiativeId = initiativeId;
  const source = {
    schemaVersion: 1,
    initiativeId,
    epic,
    stories,
    fetchedAt: nowIso()
  };
  return {
    initiativeId,
    phase: materializationPhase(initiative),
    source,
    sourceSha256: hash(source),
    ...built
  };
}

export async function adoptJiraEpic(root, initiativeId, epicKey, options = {}) {
  const preview = await previewJiraAdoption(root, initiativeId, epicKey, options);
  if (!preview.ready) {
    throw new SingularityFlowError(`Repository mapping is required for Jira stories: ${preview.unresolved.map((story) => story.jiraKey).join(', ')}.`);
  }
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdownPath = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  if (breakdownPath.exists) {
    const existing = YAML.parse(await readFile(breakdownPath.absolute, 'utf8'));
    const hasStories = existing?.epics?.some((epic) => epic.stories?.length);
    if (hasStories && options.replace !== true) throw new SingularityFlowError('This initiative already has a story breakdown. Use --replace only after reviewing the Jira import preview.');
  }
  const validated = validateInitiativeBreakdown(preview.draft, portfolio);
  const importPath = await jiraPath(root, portfolio, initiativeId, path.join('imports', `${preview.sourceSha256}.json`), {
    label: `Initiative '${initiativeId}' Jira import`,
    type: 'file'
  });
  const draftPath = await jiraPath(root, portfolio, initiativeId, 'adoption-draft.yml', {
    label: `Initiative '${initiativeId}' Jira adoption draft`,
    type: 'file'
  });
  await writeJson(importPath.absolute, preview.source);
  await writeText(draftPath.absolute, YAML.stringify(preview.draft));
  await writeText(breakdownPath.absolute, YAML.stringify(initiativeBreakdownDocument(validated)));
  initiative.history.push({
    at: nowIso(),
    actor: options.actor ?? null,
    event: 'jira_epic_adopted',
    phase: materializationPhase(initiative),
    detail: `${epicKey}; ${validated.stories.length} stories; source ${preview.sourceSha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { ...preview, portfolio, initiative, breakdown: validated };
}

function allowedUpdateFields(policy, fields) {
  const allowed = new Set(policy.writePolicy?.allowedFields ?? []);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
}

function expectedFields(item, { parentKey = null, initiativeId }) {
  return {
    summary: item.title,
    description: descriptionWithAcceptance(item),
    labels: [`sflow-${initiativeId.toLowerCase()}`, `sflow-${item.id.toLowerCase()}`],
    ...(parentKey ? { parent: { key: parentKey } } : {})
  };
}

function fieldDiff(issue, expected) {
  const diff = {};
  if (expected.summary !== undefined && issue.title !== expected.summary) diff.summary = expected.summary;
  if (expected.description !== undefined && issue.description !== expected.description) diff.description = expected.description;
  if (expected.parent !== undefined && issue.parent?.key !== expected.parent.key) diff.parent = expected.parent;
  if (expected.labels !== undefined) {
    const current = [...(issue.labels ?? [])].sort();
    const desired = [...new Set([...(issue.labels ?? []), ...expected.labels])].sort();
    if (JSON.stringify(current) !== JSON.stringify(desired)) diff.labels = desired;
  }
  return diff;
}

export async function createJiraWritePlan(root, initiativeId, {
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira ?? portfolio.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot.');
  if (policy.writeMode === 'off') throw new SingularityFlowError('Jira writes are disabled. Set jira.writeMode to preview or approved before starting the initiative.');
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const projectKey = policy.projectKey || portfolio.jira.projectKey;
  if (!projectKey) throw new SingularityFlowError('jira.projectKey is required to create a Jira write plan.');
  if (policy.allowedProjects?.length && !policy.allowedProjects.includes(projectKey)) throw new SingularityFlowError(`Jira project ${projectKey} is outside the configured allowedProjects.`);
  const operations = [];
  const snapshots = {};
  for (const epic of breakdown.epics) {
    let epicIssue = null;
    if (epic.jiraKey) {
      epicIssue = await getIssue(epic.jiraKey, { connection, env, fetchImpl });
      snapshots[epic.jiraKey] = epicIssue;
      const fields = allowedUpdateFields(policy, fieldDiff(epicIssue, expectedFields(epic, { initiativeId })));
      if (Object.keys(fields).length) operations.push({
        id: `update-epic-${epic.id}`,
        action: 'update-owned-fields',
        subject: { type: 'epic', id: epic.id, jiraKey: epic.jiraKey },
        expectedUpdatedAt: epicIssue.updatedAt,
        fields
      });
    } else {
      operations.push({
        id: `create-epic-${epic.id}`,
        action: 'create-epic',
        subject: { type: 'epic', id: epic.id, jiraKey: null },
        issue: {
          projectKey,
          issueType: policy.epicIssueType ?? 'Epic',
          summary: epic.title,
          description: descriptionWithAcceptance(epic),
          labels: [`sflow-${initiativeId.toLowerCase()}`, `sflow-${epic.id.toLowerCase()}`]
        }
      });
    }
    for (const story of epic.stories) {
      if (story.jiraKey) {
        const issue = await getIssue(story.jiraKey, { connection, env, fetchImpl });
        snapshots[story.jiraKey] = issue;
        const fields = allowedUpdateFields(policy, fieldDiff(issue, expectedFields(story, { parentKey: epic.jiraKey, initiativeId })));
        if (Object.keys(fields).length) operations.push({
          id: `update-story-${story.id}`,
          action: 'update-owned-fields',
          subject: { type: 'story', id: story.id, epicId: epic.id, jiraKey: story.jiraKey },
          expectedUpdatedAt: issue.updatedAt,
          fields
        });
      } else {
        operations.push({
          id: `create-story-${story.id}`,
          action: 'create-story',
          subject: { type: 'story', id: story.id, epicId: epic.id, jiraKey: null },
          parent: { epicId: epic.id, jiraKey: epic.jiraKey },
          issue: {
            projectKey,
            issueType: policy.storyIssueType ?? 'Story',
            summary: story.title,
            description: descriptionWithAcceptance(story),
            labels: [`sflow-${initiativeId.toLowerCase()}`, `sflow-${story.id.toLowerCase()}`]
          }
        });
      }
    }
  }
  const forbidden = operations.filter((operation) => !(policy.writePolicy?.operations ?? []).includes(operation.action));
  if (forbidden.length) throw new SingularityFlowError(`Jira policy does not permit planned operations: ${[...new Set(forbidden.map((operation) => operation.action))].join(', ')}.`);
  const snapshotSha256 = hash(snapshots);
  const planBase = {
    schemaVersion: 1,
    initiativeId,
    projectKey,
    connection: policy.connection,
    deployment: policy.deployment,
    source: { breakdownSha256: hash(initiativeBreakdownDocument(breakdown)), jiraSnapshotSha256: snapshotSha256 },
    operations,
    createdAt: nowIso(),
    status: 'proposed'
  };
  const plan = { ...planBase, sha256: hash(planBase) };
  const snapshotPath = await jiraPath(root, portfolio, initiativeId, path.join('snapshots', `${snapshotSha256}.json`), {
    label: `Initiative '${initiativeId}' Jira snapshot`,
    type: 'file'
  });
  const planPath = await jiraPath(root, portfolio, initiativeId, 'write-plan.yml', {
    label: `Initiative '${initiativeId}' Jira write plan`,
    type: 'file'
  });
  await writeJson(snapshotPath.absolute, snapshots);
  await writeText(planPath.absolute, YAML.stringify(plan));
  initiative.history.push({
    at: plan.createdAt,
    actor: null,
    event: 'jira_write_plan_created',
    phase: materializationPhase(initiative),
    detail: `${operations.length} operations; ${plan.sha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, plan };
}

export async function readJiraWritePlan(root, portfolio, initiativeId) {
  const file = await jiraPath(root, portfolio, initiativeId, 'write-plan.yml', {
    label: `Initiative '${initiativeId}' Jira write plan`,
    type: 'file'
  });
  if (!file.exists) throw new SingularityFlowError('No Jira write plan exists. Create and review one first.');
  const plan = YAML.parse(await readFile(file.absolute, 'utf8'));
  const provided = plan.sha256;
  const { sha256: _ignored, ...base } = plan;
  if (hash(base) !== provided) throw new SingularityFlowError('The Jira write plan hash is invalid. Regenerate the plan.');
  return plan;
}

export async function applyJiraWritePlan(root, initiativeId, {
  planSha256,
  confirmation,
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch,
  actor = null
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira ?? portfolio.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot.');
  if (policy.writeMode !== 'approved') throw new SingularityFlowError('Jira apply requires the initiative-pinned jira.writeMode to be approved.');
  if (confirmation !== initiativeId) throw new SingularityFlowError(`Jira apply requires exact initiative confirmation '${initiativeId}'.`);
  const plan = await readJiraWritePlan(root, portfolio, initiativeId);
  if (!planSha256 || planSha256 !== plan.sha256) throw new SingularityFlowError(`Jira apply requires exact write-plan hash '${plan.sha256}'.`);
  const phaseId = materializationPhase(initiative);
  if (!phaseId || initiative.phases[phaseId]?.status !== 'approved') throw new SingularityFlowError(`Jira apply requires approved initiative phase '${phaseId}'.`);
  const permissions = await getMyPermissions(plan.projectKey, { connection, env, fetchImpl });
  const required = new Set(plan.operations.map((operation) => operation.action.startsWith('create-') ? 'CREATE_ISSUES' : 'EDIT_ISSUES'));
  const missing = [...required].filter((name) => !permissions[name]?.havePermission);
  if (missing.length) throw new SingularityFlowError(`Jira account lacks required permissions: ${missing.join(', ')}.`);

  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const results = [];
  const epicKeys = Object.fromEntries(breakdown.epics.filter((epic) => epic.jiraKey).map((epic) => [epic.id, epic.jiraKey]));
  for (const operation of plan.operations) {
    const receiptPath = await jiraPath(root, portfolio, initiativeId, path.join('receipts', `${operation.id}.json`), {
      label: `Initiative '${initiativeId}' Jira receipt '${operation.id}'`,
      type: 'file'
    });
    if (receiptPath.exists) {
      const receipt = JSON.parse(await readFile(receiptPath.absolute, 'utf8'));
      results.push(receipt);
      if (receipt.subject.type === 'epic') epicKeys[receipt.subject.id] = receipt.jiraKey;
      continue;
    }
    let result;
    if (operation.action.startsWith('create-')) {
      const parentKey = operation.subject.type === 'story' ? (operation.parent.jiraKey ?? epicKeys[operation.parent.epicId]) : null;
      if (operation.subject.type === 'story' && !parentKey) throw new SingularityFlowError(`Cannot create ${operation.subject.id}: its parent Epic has no Jira key.`);
      result = await findOrCreateIssue({
        ...operation.issue,
        idempotencyLabel: `sflow-${hash({ initiativeId, operationId: operation.id }).slice(0, 24)}`,
        ...(parentKey ? { parentKey } : {})
      }, { connection, env, fetchImpl });
      if (operation.subject.type === 'epic') epicKeys[operation.subject.id] = result.key;
    } else {
      result = await updateIssue(operation.subject.jiraKey, operation.fields, {
        expectedUpdatedAt: operation.expectedUpdatedAt,
        connection,
        env,
        fetchImpl
      });
    }
    const receipt = {
      schemaVersion: 1,
      initiativeId,
      planSha256: plan.sha256,
      operationId: operation.id,
      action: operation.action,
      subject: operation.subject,
      jiraKey: result.key,
      jiraUpdatedAt: result.updatedAt ?? null,
      appliedAt: nowIso(),
      actor
    };
    await writeJson(receiptPath.absolute, receipt);
    results.push(receipt);
  }
  for (const epic of breakdown.epics) {
    epic.jiraKey = results.find((receipt) => receipt.subject.type === 'epic' && receipt.subject.id === epic.id)?.jiraKey ?? epic.jiraKey;
    for (const story of epic.stories) {
      story.jiraKey = results.find((receipt) => receipt.subject.type === 'story' && receipt.subject.id === story.id)?.jiraKey ?? story.jiraKey;
    }
  }
  const breakdownPath = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  await writeText(breakdownPath.absolute, YAML.stringify(initiativeBreakdownDocument(breakdown)));
  const application = {
    schemaVersion: 1,
    initiativeId,
    planSha256: plan.sha256,
    status: 'applied',
    appliedAt: nowIso(),
    appliedBy: actor,
    operations: results.map((receipt) => ({ operationId: receipt.operationId, jiraKey: receipt.jiraKey }))
  };
  const applicationPath = await jiraPath(root, portfolio, initiativeId, path.join('applications', `${plan.sha256}.json`), {
    label: `Initiative '${initiativeId}' Jira application`,
    type: 'file'
  });
  await writeJson(applicationPath.absolute, application);
  initiative.history.push({
    at: application.appliedAt,
    actor,
    event: 'jira_write_plan_applied',
    phase: phaseId,
    detail: `${results.length} operations; ${plan.sha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, plan, application, results };
}
