import { repoRoot, resolveGitCommitIdentity } from '../git.mjs';
import { smartInitPrecheck } from '../initialization/precheck.mjs';
import {
  buildRepositoryReadinessPlan, executeRepositoryReadinessPlan, loadRepositoryTestBaseline,
  isEmptyRepositoryReadinessPlan
} from '../initialization/runtime-readiness.mjs';
import {
  action, commandResult, effects, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  assessPreStoryTestBaseline, createPreStoryTestRiskAcceptance,
  listPreStoryTestRiskAcceptances, storePreStoryTestRiskAcceptance
} from '../test-baseline-risk.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(argv, { options } = {}) {
  const quick = optionBoolean(options, 'quick');
  const execute = optionBoolean(options, 'run');
  const riskStatus = optionBoolean(options, 'risk-status');
  const acceptTestRisk = optionBoolean(options, 'accept-test-risk');
  if ([quick, execute, riskStatus, acceptTestRisk].filter(Boolean).length > 1) {
    throw new SingularityFlowError('Choose exactly one precheck mode.', {
      code: 'INI_CONFIGURATION_INVALID'
    });
  }
  if (quick && execute) throw new SingularityFlowError(
    'Choose either metadata-only precheck --quick or reviewed repository execution with precheck --run.',
    { code: 'INI_CONFIGURATION_INVALID' }
  );
  if (!quick && !execute && !riskStatus && !acceptTestRisk) throw new SingularityFlowError(
    'Choose precheck --quick, --run, --risk-status, or --accept-test-risk.', { code: 'INI_CONFIGURATION_INVALID' }
  );
  const root = repoRoot();
  if (riskStatus || acceptTestRisk) {
    const loaded = await loadRepositoryTestBaseline(root, { scope: 'dependency-test' });
    if (!loaded && acceptTestRisk) throw new SingularityFlowError(
      'No confirmed dependency/test failure baseline exists for the current commit and host. Run the reviewed precheck plan first.', {
        code: 'PRE_STORY_TEST_RISK_INELIGIBLE'
      }
    );
    const currentPlan = loaded ? await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' }) : null;
    const current = Boolean(loaded && currentPlan.planId === loaded.baseline.planId
      && currentPlan.sourceCommit === loaded.baseline.sourceCommit
      && currentPlan.sourceManifestSha256 === loaded.baseline.sourceManifestSha256);
    const assessment = loaded ? assessPreStoryTestBaseline(loaded.baseline) : null;
    const decisions = loaded && current && assessment.eligible
      ? await listPreStoryTestRiskAcceptances(root, loaded.baseline) : [];
    if (riskStatus) return emitCommandResult(commandResult({
      operation: { id: 'precheck.risk.status', classification: 'read' },
      outcome: succeeded('precheck.risk-reported', {
        status: !loaded ? 'no-baseline' : !current ? 'stale-baseline'
          : assessment.eligible ? 'eligible-for-human-decision' : 'ineligible'
      }),
      effects: noEffects(), restState: 'informational',
      data: { baseline: loaded?.baseline ?? null, baselineFile: loaded?.file ?? null,
        current, assessment, decisions }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
    if (!current || !assessment.eligible) throw new SingularityFlowError(
      'The test failure baseline is stale or incomplete; risk cannot be accepted.', {
        code: 'PRE_STORY_TEST_RISK_INELIGIBLE', details: {
          current, reasons: assessment?.reasons ?? []
        }
      }
    );
    const identity = resolveGitCommitIdentity(root);
    if (identity.source !== 'configured') throw new SingularityFlowError(
      'Configure an explicit Git user.name and user.email before recording a human risk decision.', {
        code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
      }
    );
    const acceptance = createPreStoryTestRiskAcceptance(loaded.baseline, {
      actor: identity.email,
      reason: optionString(options, 'reason'),
      confirmBaselineSha256: optionString(options, 'confirm-baseline'),
      expiresAt: optionString(options, 'expires')
    });
    const saved = await storePreStoryTestRiskAcceptance(root, acceptance, loaded.baseline);
    return emitCommandResult(commandResult({
      operation: { id: 'precheck.risk.accept', classification: 'mutation' },
      outcome: succeeded('precheck.risk-recorded', {
        status: acceptance.status, acceptanceSha256: acceptance.acceptanceSha256
      }),
      effects: effects({ stateChanged: saved.created }), restState: 'complete',
      data: { acceptance: saved.acceptance, file: saved.file,
        created: saved.created, gateEffect: 'none-until-story-and-phase-bindings-are-verified' }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
  }
  if (execute) {
    const scope = optionString(options, 'scope', 'dependency-test');
    const confirmation = optionString(options, 'confirm-plan');
    if (!confirmation) {
      const plan = await buildRepositoryReadinessPlan(root, { scope });
      if (isEmptyRepositoryReadinessPlan(plan)) {
        const result = await executeRepositoryReadinessPlan(root, {
          scope, confirmation: plan.planId, emptyOnly: true
        });
        return emitExecution(result, options);
      }
      const command = `singularity-flow precheck --run --scope ${plan.scope} --confirm-plan ${plan.planId} --json`;
      const blockedNext = plan.blockers.length ? [action({
        id: 'precheck-repair-test-setup',
        label: plan.blockers.some((blocker) => blocker.code === 'REPOSITORY_READINESS_STRUCTURED_TEST_REQUIRED')
          ? 'Inspect the repository test setup, then add or repair a supported structured unit-test reporter before planning again. Do not confirm this blocked plan.'
          : 'Inspect ambiguous repository setup and choose one supported package manager or test command before planning again. Do not confirm this blocked plan.',
        command: 'singularity-flow precheck --quick --json',
        skill: '/sf-ready',
        kind: 'remediation'
      })] : [];
      return emitCommandResult(commandResult({
        operation: { id: 'precheck.run.plan', classification: 'read' },
        outcome: succeeded(plan.blockers.length ? 'precheck.run-blocked' : 'precheck.run-planned', {
          commands: plan.commands.length, blockers: plan.blockers.length
        }),
        effects: noEffects(),
        next: plan.blockers.length ? blockedNext : [action({
          id: 'precheck-run-confirm',
          label: plan.scope === 'dependency-test'
            ? 'Run the exact reviewed locked-dependency and existing-unit-test plan.'
            : 'Run the exact reviewed dependency, build, test, and application-start plan.',
          command,
          skill: '/sf-ready',
          kind: 'review'
        })],
        restState: 'informational',
        data: { plan }
      }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
    }
    const result = await executeRepositoryReadinessPlan(root, { confirmation, scope });
    return emitExecution(result, options);
  }
  const precheck = await smartInitPrecheck(root);
  const [unitBaseline, fullBaseline] = await Promise.all([
    loadRepositoryTestBaseline(root, { scope: 'dependency-test' }),
    loadRepositoryTestBaseline(root, { scope: 'full' })
  ]);
  return emitCommandResult(commandResult({
    operation: { id: 'precheck.quick', classification: 'read' },
    outcome: succeeded('precheck.reported', { status: precheck.status, checks: precheck.checks.length }),
    effects: noEffects(),
    restState: 'informational',
    data: {
      precheck,
      testBaselines: {
        'dependency-test': unitBaseline ?? null,
        full: fullBaseline ?? null
      }
    }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}

function emitExecution(result, options) {
  return emitCommandResult(commandResult({
    operation: { id: 'precheck.run.execute', classification: 'mutation' },
    outcome: succeeded('precheck.run-completed', {
      commands: result.receipt.commandResults.length,
      commit: result.receipt.sourceCommit.slice(0, 12)
    }),
    effects: effects({ stateChanged: true }), restState: 'complete',
    data: { ...result, execution: result.receipt.commandResults.length ? 'commands-executed' : 'no-commands-applicable' }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
