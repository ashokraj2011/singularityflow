import path from 'node:path';

import { listLeadRepositories, rememberLeadRepository } from '../lead-repositories.mjs';
import {
  optionBoolean, optionString, optionStrings, SingularityFlowError
} from '../util.mjs';

let legacy = null;
let organisation = null;
let explanationSupport = null;
const DIRECT = new Set(['add', 'protect', 'depend', 'auto', 'show', 'leads', 'adopt-managed']);

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

async function mutationLead(root, options) {
  const explicit = optionString(options, 'lead');
  if (explicit) return explicit;
  const { configuredRemoteIdentity } = await import('../git-remote-diagnostics.mjs');
  const current = configuredRemoteIdentity(root, 'origin');
  if (current.url) return current.url;
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

export async function showCapability(root, subject = '', { json = false, verbose = false } = {}) {
  const support = await loadExplanationSupport();
  const relative = subject || path.relative(root, process.cwd()).replaceAll('\\', '/') || '.';
  const capability = await support.resolveLifecycleCapability(root, {
    subjectPath: relative === '.' ? '' : relative,
    required: true
  });
  const config = await support.loadDefinition(root);
  const record = explanationRecord(capability, relative, config, support);
  if (json) {
    console.log(JSON.stringify(verbose ? { ...record, effectiveCapability: capability } : record, null, 2));
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
  console.log(`Review: singularity-flow capability proposal ${result.branch} --lead ${lead}`);
  console.log(`Activate after review: singularity-flow capability activate ${result.branch} --lead ${lead} --confirm ${result.commit}`);
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
      verbose: optionBoolean(context.options ?? {}, 'verbose')
    });
  }
  if (subcommand === 'adopt-managed') {
    const { repoRoot } = await import('../git.mjs');
    const root = repoRoot();
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
      console.log(`Confirm: singularity-flow capability adopt-managed --lead ${lead} --confirm ${result.plan.planSha256}`);
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
