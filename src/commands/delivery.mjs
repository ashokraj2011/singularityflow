import { readFile } from 'node:fs/promises';

import { startAdhocSession } from '../adhoc/session.mjs';
import { loadDefinition } from '../config.mjs';
import {
  buildOutcomeSelectionBundle, normalizeDeliveryRequest, recommendDelivery,
  validateRecommendationPlan
} from '../delivery-modes/delivery-kernel.mjs';
import { branch, gitCommitIdentity, head, repoRoot } from '../git.mjs';
import { commandResult, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { recordSha256 } from '../records.mjs';
import {
  optionBoolean, optionString, secureRepositoryPath, SingularityFlowError
} from '../util.mjs';

function sha(value) { return `sha256:${recordSha256(value)}`; }

function deliveryPolicy(definition) {
  const configured = definition.delivery ?? {};
  const allowedModes = configured.allowedModes ?? ['outcome', 'workflow'];
  return {
    selectionStrategy: configured.selectionStrategy ?? 'recommend',
    allowedModes,
    defaultWorkflowProfile: configured.defaultWorkflowProfile
      ?? configured.workflowProfile
      ?? 'feature',
    outcomeBounds: {
      maximumRisk: 'medium', maximumRepositories: 1, maximumTouchedResources: 40,
      externalEffects: false, credentials: false, protectedPaths: false
    }
  };
}

async function jsonFile(root, relative, label) {
  if (!relative) throw new SingularityFlowError(`${label} is required.`, { code: 'GDM_MODE_REQUIRED' });
  const secured = await secureRepositoryPath(root, relative, {
    label, mustExist: true, type: 'file'
  });
  if (secured.entry.size > 1024 * 1024) throw new SingularityFlowError(
    `${label} exceeds the 1048576-byte limit.`, { code: 'PFC_RECORD_TOO_LARGE' }
  );
  try { return JSON.parse(await readFile(secured.absolute, 'utf8')); }
  catch (error) {
    throw new SingularityFlowError(`${label} is not valid JSON.`, {
      code: 'GDM_MODE_REQUIRED', cause: error
    });
  }
}

function repositoryRevision(root) {
  return sha({ branch: branch(root), head: head(root) });
}

function configurationIdentity(definition, policy) {
  return sha({
    policy,
    protectedPaths: definition.governance?.protectedPaths ?? [],
    adhoc: definition.adhoc ?? null,
    workflows: Object.keys(definition.workflows ?? {}).sort()
  });
}

function effects({ stateChanged = false } = {}) {
  return {
    stateChanged, filesChanged: false, publicationCreated: false,
    externalSystemsChanged: false
  };
}

export async function run(_argv, { positionals, options, operation: suppliedOperation = null } = {}) {
  const action = positionals?.[1] ?? 'recommend';
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const policy = deliveryPolicy(definition);
  if (action === 'recommend') {
    const request = normalizeDeliveryRequest(await jsonFile(
      root, optionString(options, 'request-file'), 'Delivery request file'
    ));
    const plan = recommendDelivery({
      request, repositoryRevisionSha256: repositoryRevision(root),
      configurationSha256: configurationIdentity(definition, policy), ...policy
    });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.recommend', classification: 'read' },
      subject: { kind: 'outcome', id: request.workId },
      outcome: succeeded('delivery.recommendation-created', {
        recommendation: plan.outcome, reasons: plan.reasons.length
      }),
      effects: effects(), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdm-delivery-recommendation-plan', request, plan,
        nothingChanged: true,
        nextAction: plan.requiredMode === 'workflow'
          ? `singularity-flow start ${request.workId} --workflow ${request.workflowProfile}`
          : 'Save this JSON to a repository-relative file, review it, then run delivery select with its exact digest.'
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action !== 'select') throw new SingularityFlowError(
    `Unknown delivery action '${action}'. Use: delivery recommend or delivery select.`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  const envelope = await jsonFile(root, optionString(options, 'plan'), 'Delivery plan');
  const plan = validateRecommendationPlan(envelope);
  const request = normalizeDeliveryRequest(envelope?.data?.request ?? envelope?.request);
  const confirmPlan = optionString(options, 'confirm-plan');
  if (!confirmPlan || confirmPlan !== plan.recommendationSha256) throw new SingularityFlowError(
    `Delivery selection requires --confirm-plan ${plan.recommendationSha256}. Nothing changed.`,
    { code: 'GDM_SELECTION_CONFIRMATION_INVALID' }
  );
  const currentRepository = repositoryRevision(root);
  const currentConfiguration = configurationIdentity(definition, policy);
  if (plan.repositoryRevisionSha256 !== currentRepository
      || plan.configurationSha256 !== currentConfiguration
      || plan.requestSha256 !== sha(request)) {
    throw new SingularityFlowError(
      'Repository, configuration, or request changed after delivery recommendation. Nothing changed. '
      + 'Run delivery recommend again and review the replacement plan.',
      { code: 'GDM_SELECTION_PLAN_STALE' }
    );
  }
  const mode = optionString(options, 'mode');
  if (mode !== 'outcome') throw new SingularityFlowError(
    `The GDP-M5 selection pilot starts only bounded Outcome work. For Workflow mode run: `
    + `singularity-flow start ${request.workId} --workflow ${request.workflowProfile}. Nothing changed.`,
    { code: 'GDM_MODE_NOT_ALLOWED' }
  );
  const identity = gitCommitIdentity(root);
  if (!identity.email) throw new SingularityFlowError(
    'Git user.email is required to attribute the reviewed delivery selection. Nothing changed.',
    { code: 'GDM_MODE_REQUIRED' }
  );
  const selectedBy = {
    kind: 'human', identity: identity.email, authoritySha256: null
  };
  const proofPolicySha256 = sha({ profile: request.proofProfile, source: 'installed-gdp-m5' });
  const bundle = buildOutcomeSelectionBundle({
    request, recommendation: plan, mode,
    proofPolicySha256, policySnapshotSha256: currentConfiguration,
    gapAcceptancePolicySha256: sha({ mode: 'none', milestone: 'GDP-M5' }),
    promotionPolicySha256: sha(policy.outcomeBounds), selectedBy
  });
  const started = await startAdhocSession(root, definition, {
    note: request.outcome.statement, from: 'HEAD', includeExisting: false,
    mode: 'in-place', gdp: bundle
  });
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: 'delivery.select', classification: 'mutation' },
    subject: { kind: 'adhoc', id: started.session.sessionId },
    outcome: succeeded('delivery.outcome-started', {
      workId: request.workId, sessionId: started.session.sessionId,
      selectionSha256: bundle.selection.selectionSha256
    }),
    effects: effects({ stateChanged: true }), restState: 'informational',
    data: {
      workId: request.workId, session: started.session, baseline: started.baseline,
      selection: bundle.selection, completionContract: bundle.completionContract,
      nextAction: `singularity-flow adhoc status ${started.session.sessionId}`,
      publication: 'The existing Ad Hoc publisher will commit these exact GDP records only after its own landing preview and confirmation.'
    }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
