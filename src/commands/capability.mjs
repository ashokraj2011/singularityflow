import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import { listLeadRepositories, rememberLeadRepository } from '../lead-repositories.mjs';
import {
  optionBoolean, optionString, optionStrings, SingularityFlowError
} from '../util.mjs';

let legacy = null;
let organisation = null;
let explanationSupport = null;
const DIRECT = new Set([
  'add', 'protect', 'depend', 'auto', 'show', 'leads', 'adopt-managed', 'map-team'
]);

/**
 * A request file is a process-boundary transport, not a way around the engine's input limits.
 *
 * Keep this aligned with the aggregate limit enforced by normalizeCapabilityTeamRequest. The raw
 * file can be smaller than an equivalent pretty-printed document; it must never be larger and let
 * whitespace or duplicate JSON syntax turn a bounded domain request into an unbounded file read.
 */
export const CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES = 512 * 1024;

const CAPABILITY_TEAM_REQUEST_FIELDS = new Set([
  'teamId', 'lead', 'name', 'jiraProject', 'members', 'links'
]);
const CAPABILITY_TEAM_REQUEST_MEMBER_FIELDS = new Set([
  'capabilityId', 'repositoryUrl', 'name'
]);

async function printCommandRoutes(command, { skill = null, label = null } = {}) {
  const { safeCommandGuidance } = await import('../safe-command-guidance.mjs');
  if (label) console.log(`${label}:`);
  const guidance = safeCommandGuidance({ command, skill });
  if (!guidance) {
    console.log('Shell: unavailable — the supplied command was not safe to display.');
    console.log('Copilot: unavailable — ask /sf-next for a current governed action.');
    return;
  }
  console.log(`Shell: ${guidance.command}`);
  console.log(`Copilot: ${guidance.copilotCommand}`);
}

function isDirect(context = {}) {
  return DIRECT.has(context.positionals?.[1] ?? 'show');
}

async function loadLegacy() {
  legacy ??= await import('./legacy.mjs');
  await legacy.load();
  return legacy;
}

async function loadOrganisation() {
  organisation ??= await import('../organisation.mjs');
  return organisation;
}

async function loadExplanationSupport() {
  explanationSupport ??= Promise.all([
    import('../git.mjs'),
    import('../capability-context.mjs'),
    import('../config.mjs'),
    import('../schema-migrations.mjs'),
    import('../records.mjs')
  ]).then(([git, capabilities, config, migrations, records]) => ({
    repoRoot: git.repoRoot,
    resolveLifecycleCapability: capabilities.resolveLifecycleCapability,
    loadDefinition: config.loadDefinition,
    currentSchemaVersion: migrations.currentSchemaVersion,
    recordSha256: records.recordSha256
  }));
  return explanationSupport;
}

/** Progressive commands avoid loading the legacy monolith; expert compatibility commands retain it. */
export async function load(context = {}) {
  if (!isDirect(context)) await loadLegacy();
}

function required(positionals, index, label) {
  const value = String(positionals[index] ?? '').trim();
  if (!value) throw new SingularityFlowError(`capability ${positionals[1]} requires ${label}.`);
  return value;
}

function requiredOption(options, key) {
  const value = optionString(options, key);
  if (!String(value ?? '').trim()) {
    throw new SingularityFlowError(`capability map-team requires --${key} <VALUE>.`, {
      code: key === 'lead' ? 'CAPABILITY_LEAD_REQUIRED' : 'CAPABILITY_TEAM_NAME_REQUIRED'
    });
  }
  return String(value).trim();
}

function assignmentMap(values, option, valueLabel) {
  const assignments = new Map();
  for (const raw of values) {
    const separator = raw.indexOf('=');
    const key = separator < 0 ? '' : raw.slice(0, separator).trim();
    const value = separator < 0 ? '' : raw.slice(separator + 1).trim();
    if (!key || !value) {
      throw new SingularityFlowError(
        `--${option} must use <CHILD-ID>=<${valueLabel}>.`, {
          code: 'CAPABILITY_TEAM_ASSIGNMENT_INVALID'
        }
      );
    }
    if (assignments.has(key)) {
      throw new SingularityFlowError(
        `--${option} names '${key}' more than once.`, {
          code: 'CAPABILITY_TEAM_ASSIGNMENT_DUPLICATE', details: { capabilityId: key }
        }
      );
    }
    assignments.set(key, value);
  }
  return assignments;
}

function capabilityTeamRequestError(message, code = 'CAPABILITY_TEAM_REQUEST_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function isJsonObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateCapabilityTeamRequestDocument(value) {
  if (!isJsonObject(value) || !hasOnlyFields(value, CAPABILITY_TEAM_REQUEST_FIELDS)) {
    capabilityTeamRequestError(
      'The capability team request must be one closed JSON object with supported fields only.'
    );
  }
  if (typeof value.teamId !== 'string' || typeof value.lead !== 'string'
      || typeof value.name !== 'string'
      || (value.jiraProject != null && typeof value.jiraProject !== 'string')
      || (value.members != null && !Array.isArray(value.members))
      || (value.links != null && !Array.isArray(value.links))) {
    capabilityTeamRequestError('The capability team request has invalid field types.');
  }
  const members = value.members ?? [];
  for (const member of members) {
    if (!isJsonObject(member)
        || !hasOnlyFields(member, CAPABILITY_TEAM_REQUEST_MEMBER_FIELDS)
        || typeof member.capabilityId !== 'string'
        || typeof member.repositoryUrl !== 'string'
        || (member.name != null && typeof member.name !== 'string')) {
      capabilityTeamRequestError('The capability team request has an invalid member entry.');
    }
  }
  const links = value.links ?? [];
  if (links.some((link) => typeof link !== 'string')) {
    capabilityTeamRequestError('The capability team request has an invalid link entry.');
  }
  return {
    lead: value.lead,
    teamId: value.teamId,
    name: value.name,
    jiraProject: value.jiraProject ?? null,
    members,
    links
  };
}

/** Read exactly one bounded, closed JSON request without reflecting its contents in an error. */
export async function readCapabilityTeamRequestFile(requestFile) {
  const file = String(requestFile ?? '').trim();
  if (!file) {
    capabilityTeamRequestError(
      'capability map-team requires --request <JSON-FILE>.',
      'CAPABILITY_TEAM_REQUEST_REQUIRED'
    );
  }
  let handle = null;
  let bytes = null;
  try {
    const pathEntry = await lstat(file);
    if (!pathEntry.isFile() || pathEntry.size > CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES) {
      capabilityTeamRequestError(
        `The capability team request must be a regular file no larger than ${CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES} bytes.`,
        'CAPABILITY_TEAM_REQUEST_FILE_INVALID'
      );
    }
    handle = await open(file, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES) {
      capabilityTeamRequestError(
        `The capability team request must be a regular file no larger than ${CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES} bytes.`,
        'CAPABILITY_TEAM_REQUEST_FILE_INVALID'
      );
    }
    // Read one byte beyond the contract. This remains bounded if the already-open file grows after
    // stat, while still distinguishing an exact-limit document from an oversized one.
    const buffer = Buffer.allocUnsafe(CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES) {
      capabilityTeamRequestError(
        `The capability team request exceeds the ${CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES}-byte file limit.`,
        'CAPABILITY_TEAM_REQUEST_FILE_LIMIT_EXCEEDED'
      );
    }
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    capabilityTeamRequestError(
      'The capability team request file could not be read.',
      'CAPABILITY_TEAM_REQUEST_READ_FAILED'
    );
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    capabilityTeamRequestError(
      'The capability team request file must contain valid UTF-8 JSON.',
      'CAPABILITY_TEAM_REQUEST_JSON_INVALID'
    );
  }
  return validateCapabilityTeamRequestDocument(value);
}

/** Resolve file and flag transports into the same domain request passed to mapCapabilityTeam. */
export async function resolveMapTeamInput(context = {}) {
  const options = context.options ?? {};
  if (Object.hasOwn(options, 'request')) {
    if ((context.positionals?.length ?? 0) !== 2) {
      capabilityTeamRequestError(
        'capability map-team --request does not accept a <TEAM-ID> positional argument.',
        'CAPABILITY_TEAM_REQUEST_ARGUMENT_CONFLICT'
      );
    }
    if (['lead', 'name', 'jira-project', 'member', 'member-name', 'link']
      .some((key) => Object.hasOwn(options, key))) {
      capabilityTeamRequestError(
        'capability map-team --request cannot be combined with team mapping flags.',
        'CAPABILITY_TEAM_REQUEST_ARGUMENT_CONFLICT'
      );
    }
    if (Array.isArray(options.request)) {
      capabilityTeamRequestError(
        'capability map-team accepts exactly one --request <JSON-FILE>.',
        'CAPABILITY_TEAM_REQUEST_ARGUMENT_CONFLICT'
      );
    }
    return readCapabilityTeamRequestFile(optionString(options, 'request'));
  }
  if ((context.positionals?.length ?? 0) > 3) {
    throw new SingularityFlowError(
      'capability map-team accepts exactly one <TEAM-ID> positional argument.', {
        code: 'CAPABILITY_TEAM_ARGUMENT_INVALID'
      }
    );
  }
  const teamId = required(context.positionals, 2, '<TEAM-ID>');
  const lead = requiredOption(options, 'lead');
  const name = requiredOption(options, 'name');
  const memberUrls = assignmentMap(optionStrings(options, 'member'), 'member', 'GIT-URL');
  const memberNames = assignmentMap(
    optionStrings(options, 'member-name'), 'member-name', 'FRIENDLY-NAME'
  );
  for (const capabilityId of memberNames.keys()) {
    if (!memberUrls.has(capabilityId)) {
      throw new SingularityFlowError(
        `--member-name '${capabilityId}' does not match a --member assignment.`, {
          code: 'CAPABILITY_TEAM_MEMBER_NAME_ORPHAN', details: { capabilityId }
        }
      );
    }
  }
  return {
    lead,
    teamId,
    name,
    jiraProject: optionString(options, 'jira-project'),
    members: [...memberUrls].map(([capabilityId, repositoryUrl]) => ({
      capabilityId,
      repositoryUrl,
      name: memberNames.get(capabilityId) ?? capabilityId
    })),
    links: optionStrings(options, 'link')
  };
}

async function runMapTeam(context) {
  const options = context.options ?? {};
  const { lead, teamId, name, jiraProject, members, links } = await resolveMapTeamInput(context);
  const { capabilityProposalCommands, mapCapabilityTeam } = await loadOrganisation();
  let result = await mapCapabilityTeam(lead, {
    teamId,
    name,
    jiraProject,
    members,
    links
  });
  try {
    await rememberLeadRepository(lead);
  } catch {
    // The proposal is the durable result. A machine-local registry failure must not encourage a
    // retry that would compete with the confirmed remote branch.
    const warning = 'The team proposal succeeded, but this machine could not remember its capability-map repository.';
    result = {
      ...result,
      localCache: { remembered: false, code: 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED', warning },
      warnings: [...(result.warnings ?? []), warning]
    };
  }
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify({ lead, ...result }, null, 2));
    return result;
  }
  if (result.alreadyMapped) {
    console.log(`Team ${teamId} and every selected member are already present in the approved map.`);
    console.log('No proposal, commit, state change, or application-branch change was created.');
    return result;
  }
  console.log(`Proposed team ${teamId} with ${members.length} new-member selection(s) and ${result.linkedCapabilityIds.length} link selection(s).`);
  console.log(`  review branch: ${result.branch}`);
  console.log(`  base: ${result.baseBranch}@${result.baseCommit.slice(0, 8)}`);
  console.log(`  commit: ${result.commit.slice(0, 8)}`);
  console.log('  approved configuration and application branches were not changed.');
  const commands = capabilityProposalCommands(lead, result.branch, result.commit);
  await printCommandRoutes(
    commands.review,
    { label: 'Review' }
  );
  await printCommandRoutes(
    commands.activate,
    { label: 'Activate after review' }
  );
  return result;
}

async function mutationLead(root, options) {
  const explicit = optionString(options, 'lead');
  if (explicit) return explicit;
  if (root) {
    const { configuredRemoteIdentity } = await import('../git-remote-diagnostics.mjs');
    const current = configuredRemoteIdentity(root, 'origin');
    if (current.url) return current.url;
  }
  const [known] = await listLeadRepositories();
  if (known?.url) return known.url;
  throw new SingularityFlowError(
    'No capability authority repository is known. Configure one credential-free origin or pass --lead <URL>.',
    { code: 'CAPABILITY_LEAD_REQUIRED' }
  );
}

function explanationRecord(capability, subject, config, { currentSchemaVersion, recordSha256 }) {
  const scope = capability.sourceScope?.sourceRoots ?? [];
  const approvals = capability.policy?.requiredAuthorityGroups ?? [];
  const core = {
    schemaVersion: currentSchemaVersion('capability-explanation'),
    kind: 'capability-explanation',
    subject: { kind: 'path', value: subject || '.' },
    capability: { id: capability.id, label: capability.name },
    ownership: {
      status: 'owned',
      canonicalPrefix: scope[0] ?? '',
      resolution: capability.mode === 'implicit' ? 'repository-root-fallback' : 'most-specific-prefix'
    },
    permission: {
      status: approvals.length ? 'permitted-with-review' : 'permitted',
      sourceRoots: scope
    },
    approvals: approvals.map((authority) => ({ authority, reasonCode: 'capability-owner' })),
    approvalProfile: config.approvalSecurity?.profile ?? 'team',
    selfApprovalAllowed: config.approvalSecurity?.allowSelfApproval !== false,
    resolutionSha256: capability.resolutionSha256
      ?? capability.effectiveResolution?.resolutionSha256
      ?? capability.map?.sha256
      ?? null
  };
  return { ...core, explanationSha256: `sha256:${recordSha256(core)}` };
}

export async function showCapability(root, subject = '', {
  json = false,
  verbose = false,
  gitShadow = false
} = {}) {
  const support = await loadExplanationSupport();
  const relative = subject || path.relative(root, process.cwd()).replaceAll('\\', '/') || '.';
  const gitShadowObservations = [];
  const capability = await support.resolveLifecycleCapability(root, {
    subjectPath: relative === '.' ? '' : relative,
    required: true,
    ...(gitShadow ? {
      gitReadMode: 'shadow',
      onGitShadowComparison(value) { gitShadowObservations.push(value); }
    } : {})
  });
  const config = await support.loadDefinition(root);
  const record = explanationRecord(capability, relative, config, support);
  let gitShadowSummary = null;
  if (gitShadow) {
    const { summarizeFosGitShadowObservations } = await import('../fos-git-shadow.mjs');
    gitShadowSummary = summarizeFosGitShadowObservations(gitShadowObservations);
  }
  if (json) {
    console.log(JSON.stringify({
      ...record,
      ...(verbose ? { effectiveCapability: capability } : {}),
      ...(gitShadowSummary ? { gitShadow: gitShadowSummary } : {})
    }, null, 2));
    return record;
  }
  const implicit = capability.mode === 'implicit';
  console.log(`${relative === '.' ? 'This repository' : relative} belongs to ${implicit ? 'this repository' : capability.name}.`);
  console.log('\nThis Story may change:');
  if (record.permission.sourceRoots.length) {
    for (const rootPath of record.permission.sourceRoots) console.log(`  ${rootPath}/**`);
  } else console.log('  files in this repository except protected files');
  console.log('\nApproval:');
  if (record.approvals.length) {
    for (const approval of record.approvals) console.log(`  ${approval.authority}`);
  } else {
    console.log(`  ${record.approvalProfile} profile${record.selfApprovalAllowed ? '; self-approval is allowed' : ''}`);
  }
  console.log(`\nWhy:\n  ${implicit
    ? 'No more specific ownership is configured, so this repository owns the path.'
    : `${capability.name} is the most specific approved capability for this path.`}`);
  if (verbose) {
    console.log(`\nMode: ${capability.mode}`);
    console.log(`Resolution: ${record.resolutionSha256 ?? 'unavailable'}`);
    console.log(`Explanation: ${record.explanationSha256}`);
  }
  if (gitShadowSummary) {
    console.log(`Git shadow: ${gitShadowSummary.equivalent}/${gitShadowSummary.comparisons} equivalent · reference remains authoritative`);
  }
  return record;
}

function exactDependency(positionals, options) {
  const operand = required(positionals, 2, '<TARGET-CAPABILITY>@<REFERENCE>');
  const split = operand.lastIndexOf('@');
  if (split <= 0 || split === operand.length - 1) {
    throw new SingularityFlowError('Dependency must be TARGET-CAPABILITY@REFERENCE.', {
      code: 'PCD_DEPENDENCY_REFERENCE_INVALID'
    });
  }
  const capability = operand.slice(0, split);
  const reference = operand.slice(split + 1);
  const contractId = optionString(options, 'contract');
  const contractSha256 = /^sha256:[a-f0-9]{64}$/.test(reference)
    ? reference : optionString(options, 'contract-sha256');
  const publicationSha256 = optionString(options, 'publication-sha256');
  const version = optionString(options, 'contract-version')
    ?? (/^\d+$/.test(reference) ? reference : null);
  const publisherAuthority = optionString(options, 'publisher-authority');
  if (!contractId || !contractSha256 || !publicationSha256 || !version || !publisherAuthority) {
    throw new SingularityFlowError(
      `Published contract '${operand}' cannot yet be resolved to one immutable local publication. `
      + 'Supply --contract, --contract-version, --contract-sha256, --publication-sha256, and --publisher-authority from the reviewed contract receipt.',
      { code: 'PCD_DEPENDENCY_CONTRACT_UNAVAILABLE', details: { capability, reference } }
    );
  }
  return {
    capability,
    contract: {
      id: contractId,
      version,
      sha256: contractSha256,
      publicationSha256,
      publisherAuthority
    }
  };
}

async function runMutation(subcommand, context) {
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const lead = await mutationLead(root, context.options ?? {});
  const options = context.options ?? {};
  const { proposeProgressiveCapabilityChange } = await loadOrganisation();
  const result = subcommand === 'add'
    ? await proposeProgressiveCapabilityChange(lead, {
        operation: 'add',
        capabilityId: required(context.positionals, 2, '<ID>'),
        ownership: optionString(options, 'owns'),
        name: optionString(options, 'name'),
        teams: optionStrings(options, 'team'),
        parent: optionString(options, 'parent')
      })
    : subcommand === 'protect'
      ? await proposeProgressiveCapabilityChange(lead, {
          operation: 'protect',
          subjectPath: required(context.positionals, 2, '<PATH-OR-DIRECTORY>'),
          capabilityId: optionString(options, 'capability'),
          approver: optionString(options, 'approver'),
          reason: optionString(options, 'reason')
        })
      : subcommand === 'auto'
        ? await proposeProgressiveCapabilityChange(lead, {
            operation: 'auto',
            capabilityId: required(context.positionals, 2, '<CAPABILITY-ID>'),
            auto: capabilityAutoOptions(options)
          })
        : await proposeProgressiveCapabilityChange(lead, {
          operation: 'depend',
          capabilityId: optionString(options, 'from'),
          dependency: exactDependency(context.positionals, options)
        });
  await rememberLeadRepository(lead);
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify({ lead, ...result }, null, 2));
    return result;
  }
  if (!result.changed) {
    console.log('The requested capability rule is already effective. Nothing changed.');
    return result;
  }
  if (result.materialized) console.log('The repository-root capability was materialized without changing existing Story rules.');
  console.log(`Proposal created: ${result.receipt.changeId}`);
  console.log(`  branch: ${result.branch}`);
  console.log(`  commit: ${result.commit}`);
  console.log(`  receipt: ${result.receiptPath}`);
  console.log('Nothing has been applied yet.');
  await printCommandRoutes(`singularity-flow capability proposal ${result.branch} --lead ${lead}`, { label: 'Review' });
  await printCommandRoutes(
    `singularity-flow capability activate ${result.branch} --lead ${lead} --confirm ${result.commit}`,
    { label: 'Activate after review' }
  );
  return result;
}

function positiveOrNull(value, label) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SingularityFlowError(`${label} must be a positive integer or empty to inherit.`);
  }
  return parsed;
}

function capabilityAutoOptions(options) {
  const eligibility = optionString(options, 'eligibility');
  if (!['inherit', 'disabled', 'plan-only', 'bounded'].includes(eligibility ?? '')) {
    throw new SingularityFlowError('--eligibility must be inherit, disabled, plan-only, or bounded.', {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  const protectedScope = optionString(options, 'protected-scope');
  if (eligibility === 'inherit') {
    if ([protectedScope, optionString(options, 'maximum-touched-paths'),
      optionString(options, 'maximum-concurrent-flights')].some((value) => value != null)) {
      throw new SingularityFlowError('--eligibility inherit cannot be combined with capability Auto limits.', {
        code: 'AUTO_PLAN_INVALID'
      });
    }
    return null;
  }
  if (protectedScope != null && !['block', 'allow'].includes(protectedScope)) {
    throw new SingularityFlowError('--protected-scope must be block or allow.', { code: 'AUTO_PLAN_INVALID' });
  }
  const maximumTouchedPaths = positiveOrNull(
    optionString(options, 'maximum-touched-paths'), '--maximum-touched-paths'
  );
  const maximumConcurrentFlights = positiveOrNull(
    optionString(options, 'maximum-concurrent-flights'), '--maximum-concurrent-flights'
  );
  return {
    eligibility,
    forbiddenWhenProtectedScopePredicted: protectedScope !== 'allow',
    ...(maximumTouchedPaths == null ? {} : { maximumTouchedPaths }),
    ...(maximumConcurrentFlights == null ? {} : { maximumConcurrentFlights })
  };
}

export async function run(argv, context = {}) {
  const subcommand = context.positionals?.[1] ?? 'show';
  if (subcommand === 'map-team') return runMapTeam(context);
  if (subcommand === 'leads') {
    const leads = await listLeadRepositories();
    if (optionBoolean(context.options ?? {}, 'json')) return console.log(JSON.stringify(leads, null, 2));
    if (!leads.length) return console.log('No lead repository is known yet.');
    for (const lead of leads) console.log(`  ${lead.url}`);
    return;
  }
  if (subcommand === 'show') {
    const support = await loadExplanationSupport();
    return showCapability(support.repoRoot(), context.positionals?.[2] ?? '', {
      json: optionBoolean(context.options ?? {}, 'json'),
      verbose: optionBoolean(context.options ?? {}, 'verbose'),
      gitShadow: optionBoolean(context.options ?? {}, 'git-shadow')
    });
  }
  if (subcommand === 'adopt-managed') {
    const { repoRoot } = await import('../git.mjs');
    let root = null;
    try { root = repoRoot(); } catch { /* --lead and the known-authority registry are rootless */ }
    const options = context.options ?? {};
    const lead = await mutationLead(root, options);
    const confirm = optionString(options, 'confirm');
    if (!optionBoolean(options, 'preview') && !confirm) {
      throw new SingularityFlowError('Use capability adopt-managed --preview first, then --confirm sha256:<PLAN>.', {
        code: 'PCD_MANAGED_ADOPTION_CONFIRMATION_REQUIRED'
      });
    }
    const { adoptManagedCapabilityMap, previewManagedCapabilityAdoption } = await loadOrganisation();
    const result = optionBoolean(options, 'preview')
      ? await previewManagedCapabilityAdoption(lead)
      : await adoptManagedCapabilityMap(lead, { confirm });
    await rememberLeadRepository(lead);
    if (optionBoolean(options, 'json')) {
      console.log(JSON.stringify({ lead, ...result }, null, 2));
      return result;
    }
    if (result.preview) {
      console.log('Managed capability adoption preview:');
      console.log(`  current map: ${result.plan.beforeSha256}`);
      console.log(`  plan: ${result.plan.planSha256}`);
      console.log('No file, proposal, Story, or authority was changed.');
      await printCommandRoutes(
        `singularity-flow capability adopt-managed --lead ${lead} --confirm ${result.plan.planSha256}`,
        { label: 'Confirm' }
      );
      return result;
    }
    if (result.alreadyManaged) {
      console.log('The capability map is already managed by SFlow. Nothing changed.');
      return result;
    }
    console.log(`Proposal created: ${result.receipt.changeId}`);
    console.log(`  branch: ${result.branch}`);
    console.log(`  commit: ${result.commit}`);
    console.log('Nothing has been applied yet. Existing Stories keep their pinned capability rules.');
    return result;
  }
  if (['add', 'protect', 'depend', 'auto'].includes(subcommand)) return runMutation(subcommand, context);
  return (await loadLegacy()).run(argv);
}
