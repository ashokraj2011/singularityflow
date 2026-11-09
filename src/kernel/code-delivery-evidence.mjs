/** Code-delivery v2 replay rules. Yield explicit evidence requests; never discover or execute a host. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,codeDeliveryReplayVersion} from '../foundation/record-schema.mjs';
import {normalizeQualifiedClauseId} from '../foundation/traceability-ids.mjs';
import {configurationPathSyntax} from './configuration-path-policies.mjs';
import {applicationPathPolicies,changeScopePolicies,configurationFilePolicies,configurationMaterializationPolicies,
  testDeliveryPolicies,createRepositoryChangeSetCodec} from './source-path-policies.mjs';
import {createTestReportCodec} from './test-report-codec.mjs';

export const EXPLANATION_LIMITS = Object.freeze({ minimum: 10, maximum: 300 });
const TRAILING_COMMENT = /\s*(?:\*\/(?:\s*\})?|-->|#\}|%\})\s*$/u;

/**
 * The explanation after a `@clause` tag on its comment line: the text that follows the clause ID,
 * without a leading dash or colon or a closing comment marker. Null when there is none.
 */
export function clauseTagExplanation(line, clauseId) {
  const text = String(line ?? '');
  const at = text.toUpperCase().indexOf(`@CLAUSE:${String(clauseId).toUpperCase()}`);
  if (at < 0) return null;
  const rest = text.slice(at + `@clause:${clauseId}`.length)
    // A same-line JSX element may follow the comment-only expression container.
    .replace(/\s*\*\/\s*\}.*$/u, '')
    .replace(TRAILING_COMMENT, '')
    .replace(/^\s*(?:[-–—:]+\s*)?/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return rest || null;
}


/** Only captured string/byte primitives; policy and every verdict remain in this owner. */
export function codeDeliveryEvidencePolicies(pathSyntax,roots,testFacts,changeValues,byteSyntax) {
  const {path}=configurationPathSyntax(pathSyntax);
  const {isApplicationChangeEntry}=applicationPathPolicies(roots);
  const {evaluateSourceBoundary}=changeScopePolicies(pathSyntax);
  const {isConfigurationPath}=configurationFilePolicies(pathSyntax);
  const {evaluateStoryProtectedPaths}=configurationMaterializationPolicies(pathSyntax);
  const {isAllowedTestAutomationPath,testCommandCoversPath,testCoverageDeliveryPaths}=testDeliveryPolicies(pathSyntax,testFacts);
  const {verifyRepositoryChangeSetIntegrity}=createRepositoryChangeSetCodec(changeValues);
  const {prepareTestReportReader,replayTestReports,persistedOccurrences,testReceiptPassing}=createTestReportCodec(byteSyntax);
  const hash=Object.getOwnPropertyDescriptor(byteSyntax,'sha256').value;
  const from=Object.getOwnPropertyDescriptor(byteSyntax,'from').value;
  const sha256=value=>{const result=Reflect.apply(hash,byteSyntax,[value]);
    if(typeof result!=='string'||!/^[a-f0-9]{64}$/u.test(result))throw new SingularityFlowError('Delivery hashing did not return an exact SHA-256 digest.',{code:'ENGINE_CODE_DELIVERY_DIGEST_INVALID'});
    return result;};
  const utf8=bytes=>Reflect.apply(from,byteSyntax,[bytes]).toString('utf8');
  const receiptDigest=record=>sha256(canonicalJson(record));
  const bindingsDigest=(bindings=[])=>'sha256:'+receiptDigest(bindings);
  const cornerCaseMatrixDigest=matrix=>{const {matrixSha256,harness,obligations,uncoveredObligations,inadequateDeclarations,...core}=matrix??{};return 'sha256:'+receiptDigest(core);};
  const MAX_BOUND_SOURCE_BYTES=16*1024*1024;
  const MODEL_ASSURANCE_RANK=Object.freeze({unavailable:0,'host-observed':1,'provider-reported':2,'policy-selected':3});
  const modelAssuranceRank=value=>MODEL_ASSURANCE_RANK[value==='observed'?'host-observed':value]??-1;
  const request=(kind,fields)=>Object.freeze({kind,...fields});
  function safeEvidencePath(value) {
    const candidate=String(value??'');
    return candidate&&!path.posix.isAbsolute(candidate)&&!candidate.includes('\\')&&!candidate.includes(':')&&!candidate.includes('\0')
      &&!candidate.split('/').some(segment=>!segment||segment==='.'||segment==='..');
  }
function* codeDeliveryReceiptReplay(receipt, {
  protectedPaths = [],
  configurationSource = null,
  sourceBoundary = 'unrestricted',
  symlinkPolicy = 'reject',
  minimumDiscovered = 1,
  minimumPassed = 1,
  requireAffectedModuleCoverage = true,
  minimumModelAssurance = 'unavailable',
  sourceBindingPolicy = 'off',
  cornerCasePolicy = 'off',
  assertionAdequacyPolicy = 'off',
  evidenceCommit = null,
  pathContext = null,
  testRecovery = null,
  // { workflow, at }: the Story, for test-run risks and the pins its attempts ran under.
  testRunRisks = null
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!codeDeliveryReplayVersion(receipt)) {
    return { valid: false, errors: ['code-delivery v2 receipt is unavailable'] };
  }
  if (receipt.status !== 'ready') fail(`code-delivery receipt is ${receipt.status ?? 'unavailable'}`);

  const generationCommit = receipt.tree?.generationCommit;
  if (!generationCommit) fail('generation commit is absent');
  else {
    const tree = yield request('generation-tree', { generationCommit });
    if (tree.status !== 0) fail(`generation commit ${generationCommit} is unavailable`);
    else if (tree.stdout.trim() !== receipt.tree?.generationTree) fail('generation tree differs from the committed generation');
  }

  let changeSet = null;
  if (!generationCommit || !receipt.changeSet?.path) fail('committed repository change set is absent');
  else {
    const historical = yield request('change-set', { generationCommit, path: receipt.changeSet.path });
    if (historical.status !== 0) fail('repository change set was not committed with the generation');
    else {
      try { changeSet = yield request('decode-record', { family: 'repository-change-set', value: historical.stdout }); }
      catch (error) { fail(`repository change set is unreadable: ${error.message}`); }
    }
  }
  if (changeSet) {
    const integrity = verifyRepositoryChangeSetIntegrity(changeSet);
    if (!integrity.valid) fail('repository change-set integrity does not reproduce');
    if (changeSet.digest !== receipt.changeSet.digest) fail('repository change-set digest differs from its receipt');
    const protectedResult = evaluateStoryProtectedPaths(changeSet, protectedPaths, configurationSource);
    if (!protectedResult.valid) fail(`protected path policy fails: ${protectedResult.violations.map((item) => item.path).join(', ')}`);
    const applicationChangeSet = {
      ...changeSet,
      entries: changeSet.entries.filter((entry) => isApplicationChangeEntry(entry, pathContext))
    };
    const boundary = evaluateSourceBoundary(applicationChangeSet, sourceBoundary, {
      phaseId: receipt.phase, allowedPath: isAllowedTestAutomationPath
    });
    if (!boundary.valid) fail(`source boundary fails: ${boundary.violations.map((item) => item.path).join(', ')}`);
    if (symlinkPolicy === 'reject' && applicationChangeSet.entries.some((entry) => entry.newContent?.kind === 'symlink')) {
      fail('source or test delivery contains a symbolic link');
    }
    if (receipt.autoCandidate) {
      try {
        const candidate = yield request('auto-candidate', { value: receipt.autoCandidate });
        const verification = yield request('auto-verification', { value: receipt.autoCandidateVerification });
        if (verification.status !== 'passed'
            || verification.flightId !== candidate.flightId
            || verification.candidateId !== candidate.candidateId
            || verification.candidateSha256 !== candidate.candidateSha256
            || verification.bindingSha256 !== candidate.bindingSha256) {
          fail('Auto Candidate verification does not bind the published Candidate');
        }
        if (candidate.candidateSha256 !== receipt.tree?.workingStateDigest) {
          fail('Auto Candidate source-tree identity differs from the published generation');
        }
        if (receipt.tree?.generationTree) {
          const publishedCandidate = yield request('auto-resource-delta', {
            baseTree: candidate.repository.baselineTree, targetTree: receipt.tree.generationTree,
            subject: { kind: 'auto-candidate', id: candidate.attemptId }, pathContext
          });
          const publishedResourceDigest = yield request('auto-resource-digest', { changeSet: publishedCandidate,
            baselineTree: candidate.repository.baselineTree, candidateSha256: candidate.candidateSha256 });
          if (publishedResourceDigest !== candidate.applicationResourceDigest) {
            fail('Auto Candidate resource delta differs from the published generation tree');
          }
        }
      } catch (error) {
        fail(`Auto Candidate binding is invalid: ${error.message}`);
      }
    }
  }

  // The same committed file often backs many clauses. Prefetch only the recorded generation's
  // source/test bytes; current worktree, authority, regular-file and final verdict checks remain
  // at their original boundaries. Missing/oversized/unsupported batch answers take the old read.
  const array = value => Array.isArray(value) ? value : [];
  yield request('prepare-generation-files', { generationCommit, paths: [
    ...array(receipt.implementationBindings?.bindings).map(binding => binding?.explanation?.path),
    ...array(receipt.fulfillment?.obligations).filter(item => item?.fulfillment !== 'evidence')
      .flatMap(item => array(item?.paths).map(entry => entry?.path)),
    ...array(receipt.traceability?.witnesses).map(witness => witness?.testSource),
    ...array(sourceBindingPolicy === 'enforce' ? receipt.traceability?.sourceBindings : []).map(binding => binding?.sourcePath)
  ].filter(file => safeEvidencePath(file)) });
  const explanationLines = new Map();
  const declarationIndexes = new Map();
  const sourceTagIndexes = new Map();

  // The bindings a reviewer approves are exactly the recorded ones, and every explanation is still
  // on its tag line in the committed generation [E2G-011].
  if (receipt.cornerCaseMatrix) {
    if (cornerCaseMatrixDigest(receipt.cornerCaseMatrix) !== receipt.cornerCaseMatrix.matrixSha256) {
      fail('corner-case obligation matrix does not match its digest');
    } else if (cornerCasePolicy === 'enforce' && !['satisfied', 'not-applicable'].includes(receipt.cornerCaseMatrix.status)) {
      fail('corner-case obligation matrix is incomplete for the committed generation');
    }
    if (assertionAdequacyPolicy === 'enforce' && receipt.cornerCaseMatrix.summary?.inadequateDeclarations !== 0) {
      fail('assertion adequacy is incomplete for the committed generation');
    }
  } else if (cornerCasePolicy === 'enforce' || assertionAdequacyPolicy === 'enforce') {
    fail('corner-case obligation matrix is absent from the code-delivery receipt');
  }
  if (receipt.implementationBindings) {
    const { bindings, bindingsSha256 } = receipt.implementationBindings;
    if (!Array.isArray(bindings) || bindingsDigest(bindings) !== bindingsSha256) fail('implementation bindings do not match their digest');
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      if (!normalizeQualifiedClauseId(binding?.clauseId) || !Array.isArray(binding.regions)) { fail('an implementation binding is malformed'); continue; }
      const explanation = binding.explanation;
      if (explanation == null) continue;
      const text = typeof explanation.text === 'string' ? explanation.text : '';
      const bytes = generationCommit && safeEvidencePath(explanation.path) ? yield request('generation-file', { generationCommit, path: explanation.path, options: {} }) : null;
      if (bytes && !explanationLines.has(explanation.path)) explanationLines.set(explanation.path, utf8(bytes).split(/\r?\n/u));
      const line = bytes ? explanationLines.get(explanation.path)?.[Number(explanation.line) - 1] : null;
      if (text.length < EXPLANATION_LIMITS.minimum || !line || !(clauseTagExplanation(line, binding.clauseId) ?? '').startsWith(text)) {
        fail(`the explanation of ${binding.clauseId} is not on its tag line in the generation`);
      }
    }
  }
  // Each fulfillment the delivery recorded is replayed against the committed generation [E2G-010].
  for (const obligation of receipt.fulfillment?.obligations ?? []) {
    for (const entry of obligation?.paths ?? []) {
      if (!safeEvidencePath(entry?.path)) { fail(`fulfillment evidence for ${obligation?.clauseId ?? 'unknown'} names an unsafe path`); continue; }
      if (!generationCommit) continue;
      const bytes = yield request('generation-file', { generationCommit, path: entry.path, options: obligation.fulfillment === 'evidence'
        ? { regularOnly: true, maximumBytes: 16 * 1024 * 1024 } : {} });
      if (['existing', 'evidence'].includes(obligation.fulfillment)) {
        if (entry.state !== 'present' || !bytes || sha256(bytes) !== entry.sha256) {
          fail(`${obligation.fulfillment} evidence of ${obligation.clauseId} is not at ${entry.path} in the generation`);
        }
      } else if (obligation.fulfillment === 'removed') {
        if (entry.state !== 'absent' || bytes) fail(`${entry.path}, removed for ${obligation.clauseId}, is still in the generation`);
      } else if (['document', 'configuration'].includes(obligation.fulfillment)) {
        const changedInSet = (changeSet?.entries ?? []).some((change) => change.newPath === entry.path || change.oldPath === entry.path);
        if (entry.state !== 'changed' || (changeSet && !changedInSet)) {
          fail(`the ${obligation.fulfillment} change of ${obligation.clauseId} did not change ${entry.path}`);
        }
      } else {
        fail(`fulfillment evidence for ${obligation?.clauseId ?? 'unknown'} names an unknown type`);
      }
    }
  }

  const traceability = receipt.traceability ?? {};
  if (traceability.missing?.length) fail(`acceptance bindings are missing: ${traceability.missing.join(', ')}`);
  if (traceability.ambiguous?.length) fail('acceptance bindings are ambiguous');
  const bound = new Set(traceability.bound ?? []);
  const bindings = traceability.bindings ?? [];
  for (const clauseId of traceability.required ?? []) {
    if (!bound.has(clauseId) || !bindings.some((binding) => binding.clauseId === clauseId)) {
      fail(`acceptance clause ${clauseId} has no module test-source binding`);
    }
  }
  // Each exact JavaScript witness is read again from the committed generation: the test, its
  // revision and its tag must still be what publication recorded [E2G-015].
  for (const witness of traceability.witnesses ?? []) {
    if (!witness?.identity || !['jest-static-v2', 'vitest-static-v2', 'node-test-v1', 'playwright-json-v1'].includes(witness.profile)) continue;
    const bytes = generationCommit && safeEvidencePath(witness.testSource) ? yield request('generation-file', { generationCommit, path: witness.testSource, options: {} }) : null;
    let declaration = null;
    try {
      if (bytes) {
        const framework = witness.identity.framework;
        const key = typeof framework === 'string' ? JSON.stringify([witness.testSource, framework]) : null;
        if (!key) {
          declaration = (yield request('javascript-declarations', { source: utf8(bytes), sourcePath: witness.testSource, framework }))
            .declarations.find(entry => entry.logicalTestId === witness.logicalTestId) ?? null;
        } else if (!declarationIndexes.has(key)) {
          const index = new Map();
          for (const entry of (yield request('javascript-declarations', { source: utf8(bytes),
            sourcePath: witness.testSource, framework
          })).declarations) {
            if (!index.has(entry.logicalTestId)) index.set(entry.logicalTestId, entry);
          }
          declarationIndexes.set(key, index);
        }
        if (key) declaration = declarationIndexes.get(key).get(witness.logicalTestId) ?? null;
      }
    } catch { declaration = null; }
    if (!declaration || declaration.declarationSha256 !== witness.declarationSha256 || !declaration.clauseIds.includes(witness.clauseId)
        || (witness.profile === 'node-test-v1' && (declaration.line !== witness.line || declaration.gaps.length))) {
      fail(`the acceptance witness for ${witness.clauseId} in ${witness.testSource} does not match the committed test`);
    }
  }
  if (sourceBindingPolicy === 'enforce') {
    const required = traceability.sourceRequired;
    const sourceBindings = traceability.sourceBindings;
    if (!Array.isArray(required) || !Array.isArray(sourceBindings)) {
      fail('planned source-clause bindings are absent from the code-delivery receipt');
    } else {
      const delivered = new Set(receipt.changeSet?.sourcePaths ?? []);
      for (const item of required) {
        if (!normalizeQualifiedClauseId(item?.clauseId)
            || !Array.isArray(item.expectedPaths) || !item.expectedPaths.length
            || item.expectedPaths.some((candidate) => !safeEvidencePath(candidate))) {
          fail('planned source-clause requirement is invalid');
          continue;
        }
        const witnesses = sourceBindings.filter((binding) => binding?.clauseId === item.clauseId
          && item.expectedPaths.includes(binding.sourcePath));
        if (!witnesses.length) fail(`planned clause ${item.clauseId} has no exact source-comment binding`);
      }
      for (const binding of sourceBindings) {
        const sourcePath = binding?.sourcePath;
        const clauseId = binding?.clauseId;
        const requirement = required.find((item) => item.clauseId === clauseId);
        if (!requirement || !normalizeQualifiedClauseId(clauseId)
            || !safeEvidencePath(sourcePath) || !delivered.has(sourcePath)
            || !requirement.expectedPaths.includes(sourcePath)
            || !['clause', 'deletion'].includes(binding.tag)
            || (binding.tag === 'clause' && (!Number.isInteger(binding.line) || binding.line < 1))
            || (binding.tag === 'deletion' && (binding.line !== null
              || !(receipt.changeSet?.deletedSourcePaths ?? []).includes(sourcePath)))) {
          fail(`source-clause binding for ${clauseId ?? 'unknown'} is outside the reviewed delivery`);
          continue;
        }
        let historical;
        try {
          historical = generationCommit
            ? yield request('generation-file', { generationCommit, path: sourcePath, options: { maximumBytes: MAX_BOUND_SOURCE_BYTES } })
            : null;
        } catch (error) {
          fail(`source-clause binding ${clauseId} at ${sourcePath} could not be read: ${error.message}`);
          continue;
        }
        if (binding.tag === 'deletion') {
          if (historical) {
            fail(`planned deletion ${sourcePath} for ${clauseId} still exists in the generation commit`);
          }
        } else {
          if (historical && !sourceTagIndexes.has(sourcePath)) {
            sourceTagIndexes.set(sourcePath, new Set((yield request('source-clause-tags', { source: utf8(historical), sourcePath }))
              .filter(tag => tag.tag === 'clause').map(tag => JSON.stringify([tag.clauseId, tag.line]))));
          }
          if (!historical || !sourceTagIndexes.get(sourcePath)?.has(JSON.stringify([clauseId, binding.line]))) {
            fail(`source-clause binding ${clauseId} at ${sourcePath}:${binding.line} does not replay from the generation commit`);
          }
        }
      }
    }
  }

  yield request('prepare-test-replay', { evidenceCommit, executions: receipt.testExecutions ?? [] });
  const executions = new Map();
  for (const execution of receipt.testExecutions ?? []) {
    if (execution.kind === 'phase-validation-observation') {
      try {
        if (!testRecovery?.config || !testRecovery?.workflow || !evidenceCommit || !receipt.testRecovery
          || !['unavailable', 'failed', 'passed'].includes(execution.status) || receipt.testRecovery.observedOutcome !== execution.status
          || receipt.testRecovery.disposition !== 'accepted-risk') throw new Error('authenticated TRP runtime context is required');
        const context = yield request('test-recovery-context', { config: testRecovery.config, workflow: testRecovery.workflow, options: {
          phaseId: receipt.phase, generation: Number(receipt.generation), operation: testRecovery.operation ?? 'replay',
          observationSha256: receipt.testRecovery.observationSha256, evidenceCommit,
          ...(testRecovery.mode === 'historical' ? { mode: 'historical', at: testRecovery.at } : {}) } });
        const observation = context.observations[0];
        if (!observation || context.evaluation.gateDecision !== 'allow-with-risk'
          || (observation.observedOutcome === 'passed' && observation.counts.skipped <= 0)
          || observation.obligationId !== execution.commandId || observation.observedOutcome !== execution.status
          || observation.sourceManifestSha256 !== receipt.tree.workingStateDigest
          || execution.receiptPath !== `${testRecovery.config.workItemRoot ?? 'singularity/work-items'}/${receipt.workId}/context/test-recovery/runs/${observation.id}.json`
          || receiptDigest(observation) !== String(execution.receiptSha256).replace(/^sha256:/u, '')) {
          throw new Error('the risk observation is not bound to this exact committed delivery');
        }
        const phase = testRecovery.workflow.phases?.[receipt.phase];
        const commands = yield request('test-recovery-commands', { phase, workflow: testRecovery.workflow });
        const command = commands.find(item => item?.kind === 'test' && item.id === execution.commandId);
        if (!command || canonicalJson(command.affectedRoots) !== canonicalJson(execution.affectedRoots)) {
          throw new Error('risk observation command coverage differs from the approved command contract');
        }
        executions.set(execution.commandId, { commandId: execution.commandId, status: observation.observedOutcome,
          affectedRoots: execution.affectedRoots, observedOutcome: observation.observedOutcome, disposition: 'accepted-risk',
          decisionRefs: context.evaluation.decisionRefs });
      } catch (error) { fail(`TRP risk validation ${execution.commandId} does not replay: ${error.message}`); }
      continue;
    }
    let testReceipt;
    try {
      const storedRecord = yield request('test-receipt', { evidenceCommit, path: execution.receiptPath });
      if (receiptDigest(storedRecord) !== String(execution.receiptSha256 ?? '').replace(/^sha256:/, '')) {
        fail(`test receipt ${execution.commandId} differs from its bound digest`);
      }
      testReceipt = yield request('decode-record', { family: 'test-execution', value: storedRecord });
    }
    catch (error) {
      fail(`test receipt ${execution.commandId} is unavailable: ${error.message}`);
      continue;
    }
    // An attempt is bound by its own identity, to this generation and to the exact candidate tree
    // the generation published [E2G-016].
    if (testReceipt.attemptId !== execution.attemptId || testReceipt.commandId !== execution.commandId
        || !String(execution.receiptPath ?? '').endsWith(`/${testReceipt.attemptId}.json`)) {
      fail(`test receipt ${execution.commandId} is not the attempt it is bound to`);
    }
    if (testReceipt.phase !== receipt.phase || Number(testReceipt.generation) !== Number(receipt.generation)) {
      fail(`test receipt ${execution.commandId} is an attempt of another step or generation`);
    }
    if (!testReceipt.candidate?.treeSha256 || testReceipt.candidate.treeSha256 !== receipt.tree?.workingStateDigest) {
      fail(`test receipt ${execution.commandId} did not run against the published candidate`);
    }
    const replayReports = [];
    const referencedPaths = new Set();
    let replayable = true;
    for (const report of testReceipt.rawReports ?? []) {
      const expectedExtension = ['junit-xml', 'dotnet-trx'].includes(testReceipt.adapter) ? '.xml' : '.bin';
      const contentAddressedPath = typeof report.path === 'string'
        && report.path.includes('/context/code-delivery/tests/raw/')
        && report.path.endsWith(`/${report.sha256}${expectedExtension}`);
      if (!safeEvidencePath(report.path) || !contentAddressedPath
          || !/^[0-9a-f]{64}$/.test(report.sha256 ?? '')
          || !Number.isInteger(report.bytes) || report.bytes < 0 || referencedPaths.has(report.path)) {
        fail(`test receipt ${execution.commandId} contains an invalid or repeated raw report reference`);
        replayable = false;
        continue;
      }
      referencedPaths.add(report.path);
      try {
        let bytes;
        bytes = yield request('test-report', { evidenceCommit, path: report.path, sha256: report.sha256, bytes: report.bytes });
        if (sha256(bytes) !== report.sha256 || bytes.length !== report.bytes) {
          fail(`test receipt ${execution.commandId} raw report differs from its content address`);
          replayable = false;
          continue;
        }
        replayReports.push({ contents: bytes });
      } catch (error) {
        fail(`test receipt ${execution.commandId} raw report is unavailable: ${error.message}`);
        replayable = false;
      }
    }
    if (testReceipt.status === 'passed' && !testReceipt.rawReports?.length) {
      fail(`test receipt ${execution.commandId} has no durable raw report evidence`);
    } else if (replayable && replayReports.length) {
      try {
        yield request('prepare-report-reader', { adapter: testReceipt.adapter });
        const replay = replayTestReports(testReceipt.adapter, replayReports);
        if (canonicalJson(replay.tests) !== canonicalJson(testReceipt.tests)) {
          fail(`test receipt ${execution.commandId} module counts do not replay from its raw reports`);
        }
        // An older engine kept no Playwright occurrences; a receipt without them replays its counts alone.
        if (canonicalJson(persistedOccurrences(replay)) !== canonicalJson(testReceipt.occurrences ?? [])
            && (testReceipt.occurrences?.length || testReceipt.adapter !== 'playwright-json')) {
          fail(`test receipt ${execution.commandId} occurrences do not replay from its raw reports`);
        }
        if (replay.result.sha256 !== testReceipt.result?.sha256 || replay.result.bytes !== testReceipt.result?.bytes) {
          fail(`test receipt ${execution.commandId} aggregate result binding does not replay`);
        }
      } catch (error) {
        fail(`test receipt ${execution.commandId} raw report replay failed: ${error.message}`);
      }
    }
    // The pin an attempt ran under replays with it [TCE:REQ-014], and so does its accepted narrowing.
    if (testReceipt.pin) for (const problem of yield request('test-command-pin-problems', { testRunRisks, receipt, execution, testReceipt })) {
      fail(`test receipt ${execution.commandId}: ${problem}`);
    }
    if (execution.testRunRisk) {
      // A run a step approver accepted could not execute any test: it covers its command's modules
      // while that decision is active, and never a run in which tests executed [test-run risk].
      const problem = testRunRisks?.workflow
        ? yield request('test-run-risk-problem', { workflow: testRunRisks.workflow, risk: execution.testRunRisk,
          options: { phaseId: receipt.phase, attempt: testReceipt, at: testRunRisks.at } })
        : `test-run risk ${execution.testRunRisk.id ?? '?'} cannot be verified without its Story`;
      if (problem) fail(`test receipt ${execution.commandId}: ${problem}`);
      executions.set(execution.commandId, testReceipt);
      continue;
    }
    if (!testReceiptPassing(testReceipt, minimumDiscovered, minimumPassed)) fail(`test receipt ${execution.commandId} is not passing`);
    executions.set(execution.commandId, testReceipt);
  }
  if (!executions.size) fail('no passing test-execution receipt is bound');
  for (const binding of bindings) {
    const execution = executions.get(binding.commandId);
    if (!execution || !testCommandCoversPath(execution, binding.testSource)) {
      fail(`acceptance clause ${binding.clauseId} is not covered by its bound test command`);
    }
  }
  if (requireAffectedModuleCoverage) {
    for (const sourcePath of testCoverageDeliveryPaths(receipt.changeSet)) {
      if (![...executions.values()].some((execution) => testCommandCoversPath(execution, sourcePath))) {
        fail(`affected ${isConfigurationPath(sourcePath) ? 'configuration' : 'source'} path ${sourcePath} has no passing module test receipt`);
      }
    }
  }
  if (!['policy-selected', 'provider-reported', 'host-observed', 'unavailable'].includes(receipt.model?.assurance)) {
    fail(`model assurance '${receipt.model?.assurance ?? ''}' is invalid`);
  }
  // The assurance floor governs model-authored code; it must not manufacture a mandatory model
  // dependency for explicitly human-authored delivery. Older v2 receipts did not record `required`,
  // so a real observation remains governed while an unavailable observation is treated as manual.
  const modelRequired = receipt.model?.required ?? receipt.model?.assurance !== 'unavailable';
  if (modelRequired && modelAssuranceRank(receipt.model?.assurance) < modelAssuranceRank(minimumModelAssurance)) {
    fail(`model assurance '${receipt.model?.assurance ?? 'unavailable'}' is below required '${minimumModelAssurance}'`);
  }
  if (receipt.model?.minimumAssurance != null
      && receipt.model.minimumAssurance !== minimumModelAssurance) {
    fail('model assurance minimum differs from the pinned policy');
  }
  if (receipt.model?.assurance === 'policy-selected' && !(receipt.model.invocationIds ?? []).length) {
    fail('policy-selected model assurance has no kernel invocation binding');
  }
  if (receipt.model?.assurance !== 'unavailable' && (!receipt.model?.provider || !receipt.model?.resolvedModel
      || receipt.model?.host !== 'singularity-flow-kernel'
      || receipt.model?.observationSource !== 'model-invocation-audit'
      || receipt.model?.observationIntegrity !== 'external-host-attested'
      || !receipt.model?.observedAt
      || Number(receipt.model?.generation) !== Number(receipt.generation)
      || !(receipt.model?.invocationIds ?? []).length)) {
    fail('model assurance is missing its provider/model, host audit source, timestamp, generation, or invocation binding');
  }
  return { valid: errors.length === 0, errors, changeSet, executions: [...executions.values()] };
}

  return Object.freeze({codeDeliveryReceiptReplay,safeEvidencePath,bindingsDigest,cornerCaseMatrixDigest,prepareTestReportReader});
}
