/** Code-delivery v2 replay rules. Yield explicit evidence requests; never discover or execute a host. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,codeDeliveryReplayVersion,textDigestCapability} from '../foundation/record-schema.mjs';
import {codeDocumentationPolicies,publicDeclarations,changedDeclarations} from './code-documentation.mjs';
import {normalizeQualifiedClauseId} from '../foundation/traceability-ids.mjs';
import {configurationPathSyntax,externalCommandConfigurationPolicies} from './configuration-path-policies.mjs';
import {phaseRequiresCodeDelivery,nextPhaseGeneration,storyTestScope,reviewMayReturnToCode,reworkReturnRequest,earlierReturnRequest,codeCandidateScopeRequired} from './phase-policy.mjs';
import {specificationCriteria,namespaceOf,storyOwnsTag,tagKey,withoutTags,unknownCriterionTagsReplay,recordOrder,sortedUnique,mergePlannedClaimRecords,accountedAmendmentPaths,SOURCE_CHANGING_FULFILLMENT,plannedClaimAllocatedTo,predecessorSpecClauses} from './specification-policy.mjs';
import {applicationPathPolicies,changeScopePolicies,configurationFilePolicies,configurationMaterializationPolicies,
  testDeliveryPolicies,createRepositoryChangeSetCodec,sourceBoundaryPolicies,supportingChangePolicies,deliveryClassificationPolicies,plannedClaimPathPolicies} from './source-path-policies.mjs';
import {createTestReportCodec} from './test-report-codec.mjs';

export const EXPLANATION_LIMITS = Object.freeze({ minimum: 10, maximum: 300 });
export const SOURCE_TAG_ORIGIN_VALUES_PROFILE='sflow-source-tag-origin-values/v1';
export const CODE_SOURCE_BASIS_PROFILE='sflow-code-source-basis/v1';
/** An explicit namespace observation identity. Its host must authenticate the retained proof. */
export function codeSourceBasis(value,workflow,phase){
  const keys=['profile','workId','phase','generation','repositoryId','sourceBindingId','generationIntentId','baselineRevision','currentRevision'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length
    ||Object.keys(value).some(key=>!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))
    ||value.profile!==CODE_SOURCE_BASIS_PROFILE||value.workId!==workflow.workItem.id||value.phase!==phase.id
    ||value.generation!==nextPhaseGeneration(phase)||!['repositoryId','sourceBindingId','generationIntentId'].every(key=>typeof value[key]==='string'&&value[key].length>0&&value[key].length<=512)
    ||!['baselineRevision','currentRevision'].every(key=>/^sha256:[a-f0-9]{64}$/u.test(value[key]??'')))throw new SingularityFlowError(
      'Code preflight needs its exact versioned retained-source basis.',{code:'ENGINE_SOURCE_BASIS_INVALID'});
  return Object.freeze({...value});
}
const TRAILING_COMMENT = /\s*(?:\*\/(?:\s*\})?|-->|#\}|%\})\s*$/u;

/** Source-control references and line changes are explicit facts, never discovered repositories. */
/** Reconstruct Git's kind-specific line deltas from positions and independently verified bytes. */
export function sourceOriginPatchPolicies(paths,roots) {
  const {isApplicationPath}=applicationPathPolicies(roots),{isTestAutomationPath}=sourceBoundaryPolicies(paths),
    {isDocumentationPath}=deliveryClassificationPolicies(paths,roots),{isConfigurationPath}=configurationFilePolicies(paths);
  function* sourceOriginLineDeltasReplay({patch,tag,pathContext}) {
    const included=path=>path&&isApplicationPath(path,pathContext)&&(tag==='clause'
      ?!isTestAutomationPath(path)&&!isDocumentationPath(path)&&!isConfigurationPath(path):isTestAutomationPath(path));
    const lines=text=>text.match(/[^\n]*\n|[^\n]+$/gu)??[],text=line=>line.replace(/\n$/u,''),deltas=[],pattern=tag==='clause'?/@clause/iu:/@ac/iu;
    const invalid=()=>{throw new SingularityFlowError('Retained hunk positions do not describe the verified original and current bytes.',{code:'ENGINE_SOURCE_CONTROL_BINDING_INVALID',details:{reason:'origin-hunk-bytes'}});};
    for(const row of patch){
      if(!included(row.oldPath)&&!included(row.newPath))continue;
      const original=row.oldPath===null?new Uint8Array():yield Object.freeze({kind:'origin-source-bytes',side:'origin',path:row.oldPath}),
        current=row.newPath===null?new Uint8Array():yield Object.freeze({kind:'origin-source-bytes',side:'current',path:row.newPath}),
        decode=bytes=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes),before=lines(decode(original)),after=lines(decode(current)),file=[];
      if(!row.hunks.length&&(original.subarray(0,8000).includes(0)||current.subarray(0,8000).includes(0)))continue;
      let a=0,b=0;
      for(const hunk of row.hunks){
        const startA=hunk.beforeStart-(hunk.beforeLines?1:0),startB=hunk.afterStart-(hunk.afterLines?1:0);
        if(startA<a||startB<b||startA+hunk.beforeLines>before.length||startB+hunk.afterLines>after.length
          ||canonicalJson(before.slice(a,startA))!==canonicalJson(after.slice(b,startB)))invalid();
        for(let i=0;i<hunk.beforeLines;i++)file.push({path:row.oldPath,side:'removed',line:null,text:text(before[startA+i])});
        for(let i=0;i<hunk.afterLines;i++)file.push({path:row.newPath,side:'added',line:startB+i+1,text:text(after[startB+i])});
        a=startA+hunk.beforeLines;b=startB+hunk.afterLines;
      }
      if(canonicalJson(before.slice(a))!==canonicalJson(after.slice(b)))invalid();
      if(file.some(row=>pattern.test(row.text)))deltas.push(...file);
    }
    return deltas;
  }
  return Object.freeze({sourceOriginLineDeltasReplay});
}
export function sourceTagOriginPolicies(paths,roots) {
  const {isApplicationPath}=applicationPathPolicies(roots),{isTestAutomationPath}=sourceBoundaryPolicies(paths),
    {isDocumentationPath}=deliveryClassificationPolicies(paths,roots),{isConfigurationPath}=configurationFilePolicies(paths),
    request=(kind,fields)=>Object.freeze({kind,...fields});
  const selected=(path,tag)=>tag==='clause'?!isTestAutomationPath(path)&&!isDocumentationPath(path)&&!isConfigurationPath(path):isTestAutomationPath(path);
  function* carriedTagIdsReplay({baseline,changes,occurrences,tag}) {
    if(!baseline)return new Set();
    const changed=new Set(changes.flatMap(change=>[change.oldPath,change.newPath]).filter(Boolean)),
      carried=new Set(occurrences.filter(value=>!changed.has(value.path)).map(value=>value.clauseId)),
      paths=changes.filter(change=>change.oldPath&&change.previousRegular&&selected(change.oldPath,tag)).map(change=>change.oldPath),
      previous=yield request('origin-baseline-texts',{baseline,paths,maximumObjectBytes:16*1024*1024,maximumBytes:64*1024*1024});
    for(const [path,source]of previous) {
      const tags=yield request('origin-comment-tags',{source,path});
      for(const value of tags)if(value.tag===tag)carried.add(value.clauseId);
    }
    return carried;
  }
  function* storyTagLinesReplay({baseline,occurrences,tag,pathContext}) {
    if(!baseline)return null;
    const normalize=text=>text.trim().replace(/\s+/gu,' '),added=new Map(),net=new Map();
    const count=(path,text,delta)=>{let allowed=false;
      try{allowed=Boolean(path)&&isApplicationPath(path,pathContext)&&selected(path,tag);}catch{ /* an ungovernable path contributes no line */ }
      if(allowed)net.set(text,(net.get(text)??0)+delta);
    };
    const add=(path,line,text)=>{if(!added.has(path))added.set(path,new Map());added.get(path).set(line,text);count(path,text,1);};
    for(const delta of yield request('origin-line-deltas',{baseline,tag})) {
      if(delta.side==='removed')count(delta.path,normalize(delta.text),-1);
      else if(delta.path)add(delta.path,delta.line,normalize(delta.text));
    }
    const unseen=[...new Set(occurrences.map(value=>value.path))].filter(path=>!added.has(path));
    if(unseen.length) {
      const tracked=yield request('origin-tracked-paths',{paths:unseen});
      for(const path of unseen.filter(value=>!tracked.has(value))) {
        const text=yield request('origin-untracked-text',{path});text.split(/\r?\n/u).forEach((line,index)=>add(path,index+1,normalize(line)));
      }
    }
    return new Set(occurrences.filter(value=>(net.get(added.get(value.path)?.get(value.line))??0)>0).map(value=>tagKey(value.path,value.line)));
  }
  return Object.freeze({profile:SOURCE_TAG_ORIGIN_VALUES_PROFILE,carriedTagIdsReplay,storyTagLinesReplay});
}

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



/** Binding rules consume exact diff/source observations, never a checkout or a readiness callback. */
function implementationBindingsIdentity(bindings,sha256Utf8) {return 'sha256:'+sha256Utf8(canonicalJson(bindings));}
export function implementationBindingPolicies(pathSyntax,digests) {
  const {documentationLanguage}=codeDocumentationPolicies(pathSyntax),{sha256Utf8}=textDigestCapability(digests);
  const bindingsDigest=(bindings=[])=>implementationBindingsIdentity(bindings,sha256Utf8);
  const request=(kind,fields)=>Object.freeze({kind,...fields});
function hunksByPath(preview) {
  const byPath = new Map();
  for (const file of preview?.files ?? []) {
    const key = file.pathAfter ?? file.pathBefore;
    if (!key) continue;
    byPath.set(key, (file.hunks ?? []).map((hunk) => ({
      beforeStart: hunk.beforeStart ?? null, beforeLines: hunk.beforeLines ?? null,
      afterStart: hunk.afterStart ?? null, afterLines: hunk.afterLines ?? null
    })));
  }
  return byPath;
}

function* implementationBindingsReplay({ changeSet, required = [], tags = [] }) {
  const entries = new Map((changeSet?.entries ?? []).flatMap((entry) =>
    [entry.newPath, entry.oldPath].filter(Boolean).map((candidate) => [candidate, entry])));
  const planned = [...new Set(required.flatMap((obligation) => obligation.expectedPaths))].filter((candidate) => entries.has(candidate));
  const edited = planned.filter((candidate) => !entries.get(candidate).untracked && entries.get(candidate).status !== 'added');
  const preview = edited.length
    ? yield request('implementation-diff-preview',{changeSet,contextLines:0,paths:edited})
    : { files: [] };
  const hunks = hunksByPath(preview);
  const sources = new Map();
  function* readSource(relative) {
    if(!sources.has(relative))sources.set(relative,yield request('implementation-source',{path:relative,maximumBytes:2*1024*1024}));
    return sources.get(relative);
  }
  const bindings = [];
  const problems = [];
  const problemFindings = [];
  const explanationsMissing = [];
  for (const obligation of [...required].sort((left, right) => left.clauseId.localeCompare(right.clauseId))) {
    const regions = [];
    for (const relative of obligation.expectedPaths.filter((candidate) => entries.has(candidate)).sort()) {
      const entry = entries.get(relative);
      const source = entry.status === 'deleted' ? null : yield* readSource(relative);
      const lines = source == null ? [] : source.split(/\r?\n/u);
      const whole = entry.untracked || entry.status === 'added';
      const regionHunks = entry.status === 'deleted'
        ? [{ beforeStart: 1, beforeLines: null, afterStart: 0, afterLines: 0 }]
        : whole ? [{ beforeStart: 0, beforeLines: 0, afterStart: 1, afterLines: source ? lines.length - /\n$/u.test(source) : 0 }]
          : hunks.get(relative) ?? [];
      const language = documentationLanguage(relative);
      const changedLines = new Set(regionHunks.flatMap((hunk) =>
        Array.from({ length: Math.max(0, Number(hunk.afterLines ?? 0)) }, (_, offset) => Number(hunk.afterStart) + offset)));
      const declarations = source != null && language ? publicDeclarations(source, language) : [];
      const touched = whole ? declarations : changedDeclarations(declarations, changedLines, lines);
      regions.push({
        path: relative,
        change: entry.status === 'deleted' ? 'deleted' : whole ? 'added' : entry.oldPath && entry.oldPath !== entry.newPath ? 'renamed' : 'modified',
        hunks: regionHunks,
        symbols: touched.map(({ name, kind, line }) => ({ name, kind, line })),
        symbolAssurance: language ? 'heuristic' : 'unsupported-language'
      });
    }
    // The explanation sits on a tag line of a delivered path; the first one long enough counts.
    let explanation = null;
    for (const tag of tags.filter((item) => item.clauseId === obligation.clauseId && item.tag === 'clause' && Number.isInteger(item.line))) {
      const source = yield* readSource(tag.sourcePath);
      const text = clauseTagExplanation(source?.split(/\r?\n/u)[tag.line - 1], obligation.clauseId);
      if (text && text.length >= EXPLANATION_LIMITS.minimum) {
        explanation = { text: text.slice(0, EXPLANATION_LIMITS.maximum), path: tag.sourcePath, line: tag.line };
        break;
      }
    }
    const deletionOnly = regions.length > 0 && regions.every((region) => region.change === 'deleted');
    if (!explanation && !deletionOnly && regions.length) {
      const where = tags.find((item) => item.clauseId === obligation.clauseId && item.tag === 'clause');
      explanationsMissing.push({ clauseId: obligation.clauseId, path: where?.sourcePath ?? null, line: where?.line ?? null });
      problems.push(`${obligation.clauseId} needs an explanation of how the change meets it, after its @clause tag${where ? ` in ${where.sourcePath}:${where.line}` : ''}`
        + ` (${EXPLANATION_LIMITS.minimum} to ${EXPLANATION_LIMITS.maximum} characters)`);
      problemFindings.push({ code: 'code.delivery.clause-explanation-missing', path: where?.sourcePath ?? null, value: obligation.clauseId });
    }
    bindings.push({ clauseId: obligation.clauseId, explanation, regions });
  }
  return { bindings, bindingsSha256: bindingsDigest(bindings), problems, problemFindings, explanationsMissing };
}

  return Object.freeze({implementationBindingsReplay,bindingsDigest});
}

export const BINDING_DECISIONS = Object.freeze(['accepted', 'accepted-with-exception']);

/**
 * One decision per binding a step submitted [E2G-011, D7]: approving the step accepts every
 * binding as a batch over their exact digest, unless the reviewer records an exception for one,
 * with its reason. A binding is never rejected inside an approval; returning it for correction is a
 * rejection of the step.
 */
export function reviewBindings(submitted, requested = []) {
  const bindings = submitted?.bindings ?? [];
  const known = new Set(bindings.map((binding) => binding.clauseId));
  if (!bindings.length) {
    if (requested.length) {
      throw new SingularityFlowError('This step submitted no implementation bindings to decide; leave out --binding.', { code: 'IMPLEMENTATION_BINDING_UNKNOWN' });
    }
    return null;
  }
  const chosen = new Map();
  for (const entry of requested) {
    const clauseId = String(entry.clauseId ?? '').toUpperCase();
    if (!known.has(clauseId)) {
      throw new SingularityFlowError(`This step submitted no binding for ${clauseId}; bound: ${[...known].join(', ')}.`, { code: 'IMPLEMENTATION_BINDING_UNKNOWN' });
    }
    if (entry.decision === 'reject') {
      throw new SingularityFlowError(`To return ${clauseId} for correction, reject the step instead of approving it.`, { code: 'IMPLEMENTATION_BINDING_DECISION_INVALID' });
    }
    if (!['accept', 'exception'].includes(entry.decision)) {
      throw new SingularityFlowError(`--binding must be <clause>=accept|exception; got ${entry.decision ?? 'nothing'} for ${clauseId}.`, { code: 'IMPLEMENTATION_BINDING_DECISION_INVALID' });
    }
    const reason = String(entry.reason ?? '').trim();
    if (entry.decision === 'exception' && (reason.length < 20 || reason.length > 1000)) {
      throw new SingularityFlowError(`An exception for ${clauseId} needs a reason of 20 to 1000 characters with --binding-reason.`, { code: 'IMPLEMENTATION_BINDING_REASON_REQUIRED' });
    }
    chosen.set(clauseId, entry.decision === 'exception' ? { decision: 'accepted-with-exception', reason } : { decision: 'accepted' });
  }
  return {
    bindingsSha256: submitted.bindingsSha256,
    decisions: bindings.map((binding) => ({ clauseId: binding.clauseId, ...(chosen.get(binding.clauseId) ?? { decision: 'accepted' }) }))
  };
}

/** Only captured string/byte primitives; policy and every verdict remain in this owner. */
export function codeDeliveryEvidencePolicies(pathSyntax,roots,testFacts,changeValues,byteSyntax) {
  const {path}=configurationPathSyntax(pathSyntax);
  const {plannedImplementationPaths,plannedProductSourcePaths,plannedSupportingFiles,changesProductSource}=plannedClaimPathPolicies(pathSyntax);
  const {applicationPathContext,isApplicationPath,isApplicationChangeEntry}=applicationPathPolicies(roots);
  const {evaluateSourceBoundary}=changeScopePolicies(pathSyntax);
  const {isConfigurationPath}=configurationFilePolicies(pathSyntax);
  const {evaluateStoryProtectedPaths}=configurationMaterializationPolicies(pathSyntax);
  const {isAllowedTestAutomationPath,isSupportingTestResourcePath,isTestSourceName,deliveryPathCohorts,testCommandCoversPath,testCoverageDeliveryPaths}=testDeliveryPolicies(pathSyntax,testFacts);
  const {verifyRepositoryChangeSetIntegrity}=createRepositoryChangeSetCodec(changeValues);
  const {isTestAutomationPath}=sourceBoundaryPolicies(pathSyntax);
  const {classifySupportingChange}=supportingChangePolicies(pathSyntax);
  const {classifyDeliveryChanges,isDocumentationPath}=deliveryClassificationPolicies(pathSyntax,roots);
  const {normalizeExternalCommand}=externalCommandConfigurationPolicies(pathSyntax);
  const {prepareTestReportReader,replayTestReports,persistedOccurrences,testReceiptPassing}=createTestReportCodec(byteSyntax);
  const hash=Object.getOwnPropertyDescriptor(byteSyntax,'sha256').value;
  const from=Object.getOwnPropertyDescriptor(byteSyntax,'from').value;
  const sha256=value=>{const result=Reflect.apply(hash,byteSyntax,[value]);
    if(typeof result!=='string'||!/^[a-f0-9]{64}$/u.test(result))throw new SingularityFlowError('Delivery hashing did not return an exact SHA-256 digest.',{code:'ENGINE_CODE_DELIVERY_DIGEST_INVALID'});
    return result;};
  const utf8=bytes=>Reflect.apply(from,byteSyntax,[bytes]).toString('utf8');
  const receiptDigest=record=>sha256(canonicalJson(record));
  const bindingsDigest=(bindings=[])=>implementationBindingsIdentity(bindings,sha256);
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
function canonicalFinding({ code, path = null, value = null } = {}) {
  const identity = { code: String(code), path: path ?? null,
    value: Array.isArray(value) ? [...new Set(value.map(String))].sort() : value ?? null };
  return { id: `FND-${receiptDigest(identity).slice(0, 24)}`, ...identity };
}
function codeDeliveryCandidateSha256(applicationEntries) {
  return 'sha256:'+receiptDigest(applicationEntries.map(({ status, oldPath, newPath, oldMode, newMode, oldObject, newContent }) =>
    ({ status, oldPath, newPath, oldMode, newMode, oldObject, newContent })));
}
  const canonicalFindingId=identity=>canonicalFinding(identity).id;
  function codeDeliveryCandidateScope(planned,workflow,phase){
    if(!codeCandidateScopeRequired(workflow,phase))return null;
    const allowed=new Set();
    for(const claim of Object.values(mergePlannedClaimRecords(planned))){
      if((claim.steps??[]).length&&!claim.steps.includes(phase.id))continue;
      for(const candidate of [...(claim.expectedPaths??[]),...(claim.tests??[])])allowed.add(candidate);
    }
    for(const candidate of plannedSupportingFiles(planned))allowed.add(candidate);
    for(const candidate of accountedAmendmentPaths(planned))allowed.add(candidate);
    return Object.freeze({allows:candidate=>allowed.has(candidate)||isAllowedTestAutomationPath(candidate),unsafe:()=>true});
  }
  function plannedCodeStepPaths(planned,workflow,phase){
    const sourcePaths=new Set(),testPaths=new Set();
    if(!codeCandidateScopeRequired(workflow,phase))return {sourcePaths:[],testPaths:[]};
    for(const claim of Object.values(mergePlannedClaimRecords(planned))){
      if((claim.steps??[]).length&&!claim.steps.includes(phase.id))continue;
      for(const candidate of claim.expectedPaths??[])sourcePaths.add(candidate);
      for(const candidate of claim.tests??[])testPaths.add(candidate);
    }
    return {sourcePaths:[...sourcePaths].sort(),testPaths:[...testPaths].sort()};
  }

/**
 * Judge each allocated obligation that is not delivered by new or modified product source by its
 * own fulfillment [E2G-010]: behaviour that already exists must still be at its paths, removed
 * behaviour must be gone, and a document or configuration change must change exactly its paths.
 */
function* fulfillmentEvidenceReplay( obligations, changedPaths, deletedPaths) {
  const changed = new Set([...changedPaths, ...deletedPaths]);
  const entries = [];
  const problems = [];
  // Each sentence's identity, in the same order [SDA-AC-022]: the obligation and its exact path.
  const problemFindings = [];
  const problem = (code, clauseId, candidate, sentence) => {
    problems.push(sentence);
    problemFindings.push({ code, path: candidate, value: clauseId });
  };
  for (const obligation of obligations ?? []) {
    if (!['existing', 'removed', 'document', 'configuration', 'evidence'].includes(obligation.fulfillment)) continue;
    const paths = [];
    for (const candidate of obligation.expectedPaths) {
      const secured = yield request('working-path-facts', {candidate, label: `Planned ${obligation.fulfillment} path`});
      const present = Boolean(secured.exists && secured.regular);
      if (obligation.fulfillment === 'evidence' && present && secured.bytes > 16 * 1024 * 1024) {
        throw new SingularityFlowError(`Retained evidence ${candidate} exceeds 16 MiB.`, { code: 'CODE_DELIVERY_EVIDENCE_TOO_LARGE' });
      }
      if (['existing', 'evidence'].includes(obligation.fulfillment)) {
        paths.push({ path: candidate, state: present ? 'present' : 'missing',
          sha256: present ? sha256(yield request('working-path-bytes', {candidate})) : null });
        if (!present) problem(`code.delivery.${obligation.fulfillment}-path-missing`, obligation.clauseId, candidate, `${obligation.clauseId} requires ${obligation.fulfillment}, but ${candidate} does not exist`);
      } else if (obligation.fulfillment === 'removed') {
        paths.push({ path: candidate, state: present ? 'present' : 'absent' });
        if (present) problem('code.delivery.removed-path-present', obligation.clauseId, candidate, `${obligation.clauseId} removes ${candidate}, but it still exists`);
      } else {
        paths.push({ path: candidate, state: changed.has(candidate) ? 'changed' : 'unchanged' });
        if (!changed.has(candidate)) problem(`code.delivery.${obligation.fulfillment}-path-unchanged`, obligation.clauseId, candidate, `${obligation.clauseId} is a ${obligation.fulfillment} change, but ${candidate} did not change`);
      }
    }
    entries.push({ clauseId: obligation.clauseId, fulfillment: obligation.fulfillment, paths });
  }
  return { obligations: entries, problems, problemFindings };
}
  function* preflightUnknownCriteria(criteria,changeSet,inputs){
    const replay=unknownCriterionTagsReplay(criteria,inputs);let step=replay.next();
    while(!step.done){const facts=yield request(step.value.kind,{...step.value,changeSet});step=replay.next(facts);}
    return step.value;
  }

function* plannedSourceClauseBindingsReplay(config, workflow, phase, sourcePaths, {
  deletedSourcePaths = [], changeSet = null
} = {}) {
  if (workflow.resolution?.codeDelivery?.traceability?.sourceBindings !== 'enforce'
      || phase.sourceBoundary === 'test-automation'
      || workflow.resolution?.plannedClaims?.mode !== 'required') {
    return { mode: 'off', required: [], bindings: [], missing: [] };
  }
  const ownerId = workflow.resolution.plannedClaims.owners?.[phase.id];
  const owner = workflow.phases?.[ownerId];
  if (!owner) {
    throw new SingularityFlowError(
      `Code phase '${phase.id}' has no reviewed planning owner for source clause bindings.`,
      { code: 'SPEC_PLANNED_CLAIM_MAP_REQUIRED' }
    );
  }
  const active = yield request('source-binding-records',{});
  const clauseIds = predecessorSpecClauses(active,workflow,phase.id).map(clause=>clause.id);
  const plan = yield request('source-binding-plan',{ownerId,owner,clauseIds,policy:workflow.resolution?.spec??config.spec??{}});
  const available = new Set(sourcePaths);
  // Only obligations this step delivers by new or modified source carry their clause in that source.
  const required = Object.entries(plan.claims ?? {})
    .filter(([, claim]) => plannedClaimAllocatedTo(claim, phase.id) && changesProductSource(claim)
      && claim.testDisposition !== 'not-applicable')
    .map(([rawClauseId, claim]) => {
      const clauseId = normalizeQualifiedClauseId(rawClauseId);
      if (!clauseId) {
        throw new SingularityFlowError(`Planned source clause '${rawClauseId}' is not a qualified ID.`, {
          code: 'CODE_DELIVERY_SOURCE_CLAUSE_ID_INVALID'
        });
      }
      return { clauseId, expectedPaths: plannedProductSourcePaths(claim).sort() };
    })
    .sort((left, right) => left.clauseId.localeCompare(right.clauseId));
  const candidates = [...new Set(sourcePaths)]
    .filter((candidate) => !isAllowedTestAutomationPath(candidate) && !isConfigurationPath(candidate))
    .sort();
  const tagsByPath = new Map();
  for (const relative of candidates) {
    const secured = yield request('source-binding-path',{path:relative});
    if (!secured.exists || !secured.regular) continue;
    if (secured.size >= MAX_BOUND_SOURCE_BYTES) {
      throw new SingularityFlowError(
        `Planned source '${relative}' is too large for exact clause-comment replay (maximum below 16 MiB). Split the source or use a reviewed test-only/not-applicable plan disposition before publication.`,
        { code: 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE', details: { path: relative } }
      );
    }
    const sourceBytes = yield request('source-binding-bytes',{path:relative});
    if (sourceBytes.length >= MAX_BOUND_SOURCE_BYTES) {
      throw new SingularityFlowError(
        `Planned source '${relative}' grew beyond the exact clause-comment replay limit before publication.`,
        { code: 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE', details: { path: relative } }
      );
    }
    tagsByPath.set(relative,(yield request('source-binding-tags',{source:utf8(sourceBytes),path:relative}))
      .filter(tag=>tag.tag==='clause'&&normalizeQualifiedClauseId(tag.clauseId)));
  }
  const approved = new Set(clauseIds.map(normalizeQualifiedClauseId));
  // A tag in one of the Story's own namespaces, the ones its test tags are held to, must name a
  // clause it approved [E2G-011]. In a namespace other Stories share, a changed file may carry an
  // earlier Story's tag, which stays. Without an index only the Work ID is the Story's, as before.
  const criteria = specificationCriteria(active, workflow, config)
    ?? { namespaces: new Set([workflow.workItem.id.toUpperCase()]), sharedNamespaces: new Set() };
  const named = [...tagsByPath].flatMap(([sourcePath, tags]) => tags.map((tag) => ({ ...tag, path: sourcePath })));
  let carried = null;
  const unapproved=[];
  for(const tag of named) {
    if(approved.has(tag.clauseId))continue;
    if(criteria.namespaces.has(namespaceOf(tag.clauseId))&&criteria.sharedNamespaces.has(namespaceOf(tag.clauseId))) {
      carried??=yield request('carried-source-tags',{changeSet,occurrences:named});
    }
    if(storyOwnsTag(criteria,tag.clauseId,()=>carried))unapproved.push({code:'EVIDENCE_CLAUSE_UNAPPROVED',clauseId:tag.clauseId,sourcePath:tag.path,line:tag.line,
      message:`@clause:${tag.clauseId} at ${tag.path}:${tag.line} names a clause this Story has not approved.`});
  }
  if (unapproved.length) throw new SingularityFlowError(
    `Product source names clauses that this Story has not approved: ${unapproved.map((tag) => `${tag.clauseId} at ${tag.sourcePath}:${tag.line}`).join('; ')}. Correct the tag or revise the specification before publishing.`,
    { code: 'EVIDENCE_CLAUSE_UNAPPROVED', details: { findings: unapproved } }
  );
  const tagged = required.flatMap(({ clauseId, expectedPaths }) => expectedPaths.flatMap((sourcePath) =>
    (tagsByPath.get(sourcePath) ?? [])
      .filter((tag) => tag.clauseId === clauseId)
      .map(({ line, tag }) => ({ clauseId, sourcePath, line, tag }))));
  // Each Story numbers its own clauses in a namespace other Stories share, so there a tag binds this
  // Story's clause only where this Story added it; an earlier Story's tag with the same ID names
  // that Story's clause.
  const shared = tagged.filter((binding) => criteria.sharedNamespaces.has(namespaceOf(binding.clauseId)));
  const pathContext = applicationPathContext(config, workflow);
  const own = shared.length ? yield request('story-added-source-tags',{occurrences:shared.map(binding=>({path:binding.sourcePath,line:binding.line})),pathContext}) : null;
  const othersTags = own ? shared.filter((binding) => !own.has(tagKey(binding.sourcePath, binding.line))) : [];
  const bindings = tagged.filter((binding) => !othersTags.includes(binding));
  const deleted = new Set(deletedSourcePaths);
  for (const { clauseId, expectedPaths } of required) {
    for (const sourcePath of expectedPaths) {
      if (deleted.has(sourcePath) && available.has(sourcePath) && !tagsByPath.has(sourcePath)) {
        bindings.push({ clauseId, sourcePath, line: null, tag: 'deletion' });
      }
    }
  }
  const missing = [];
  for (const entry of required.filter(({ clauseId }) => !bindings.some((binding) => binding.clauseId === clauseId))) {
    const others = othersTags.filter((binding) => binding.clauseId === entry.clauseId)
      .map((binding) => ({ path: binding.sourcePath, line: binding.line }));
    const unchanged = yield request('source-binding-unchanged-tags',{entry,available:[...available]});
    missing.push(others.length || unchanged.length ? {
      ...entry, ...(others.length ? { otherStoryTags: others } : {}), ...(unchanged.length ? { unchangedTags: unchanged } : {})
    } : entry);
  }
  return { mode: 'enforce', required, bindings, missing };
}


function* codeDeliveryPreflightReplay(config, workflow, phase, { strictCoverage = false, ignoreDisputes = false, requireReconciled = false } = {}) {
  if (!phaseRequiresCodeDelivery(phase)) return null;
  yield request('prepare-local-exclusions', {});
  if ((phase.writeScope ?? 'artifact-only') !== 'source-and-artifact') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' is a code-generation phase but its write scope does not permit source changes.`,
      { code: 'CODE_DELIVERY_SCOPE_INVALID' }
    );
  }

  yield request('verify-work-interval', {});
  const baselineCommit = phase.generationIntent?.baseline?.commit
    ?? workflow.workIntervals.current.sourceBaseCommit;
  return yield* codeCandidatePreflightReplay(config,workflow,phase,{strictCoverage,ignoreDisputes,requireReconciled,baselineCommit,sourceBasis:null});
}

/** Namespace source identity has its own contract; no revision is presented as a Git commit. */
function* namespaceCodeDeliveryPreflightReplay(config,workflow,phase,{sourceBasis:given,strictCoverage=false,ignoreDisputes=false,requireReconciled=true}={}){
  if(!phaseRequiresCodeDelivery(phase))return null;
  const sourceBasis=codeSourceBasis(given,workflow,phase);
  if(phase.writeScope!=='source-and-artifact')throw new SingularityFlowError('The code phase does not permit application edits.',{code:'CODE_DELIVERY_SCOPE_INVALID'});
  yield request('verify-source-generation',{sourceBasis});
  return yield* codeCandidatePreflightReplay(config,workflow,phase,{strictCoverage,ignoreDisputes,requireReconciled,baselineCommit:null,sourceBasis});
}

function* codeCandidatePreflightReplay(config,workflow,phase,{strictCoverage,ignoreDisputes,requireReconciled,baselineCommit,sourceBasis}){
  const changeSet = yield request('working-change-set', {
    baseCommit: baselineCommit,
    ...(sourceBasis?{sourceBasis}:{}),
    subject: {
      workId: workflow.workItem.id, phase: phase.id, generation: nextPhaseGeneration(phase),
      generationIntentId: sourceBasis?.generationIntentId??phase.generationIntent?.id??null
    }
  });
  const guards = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const protectedResult = evaluateStoryProtectedPaths(changeSet, guards, workflow);
  // A protected file main changed reaches this branch when main is merged in. It is main's own
  // reviewed change, not this generation's, and restoring it would undo main (2026-10-28). The
  // Story still runs on its pinned configuration.
  const fromBase = protectedResult.valid ? null : yield request('merged-base-paths', {paths: protectedResult.violations.map(entry=>entry.path)});
  if (fromBase) protectedResult.violations = protectedResult.violations.filter((entry) => !fromBase.paths.includes(entry.path));
  if (protectedResult.violations.length) {
    const protectedPaths=[...new Set(protectedResult.violations.map(entry=>entry.path))];
    throw (yield request('format-preflight-refusal', {reason: 'protected', protectedPaths}));
  }
  const pathContext = applicationPathContext(config, workflow);
  const allApplicationEntries = changeSet.entries
    .filter((entry) => isApplicationChangeEntry(entry, pathContext));
  // The candidate is what the plan names for this step [E2G-027, D9]. A file no step's plan names
  // stays in the worktree and the tests run without it on a materialized candidate; prose is simply
  // left out. A file another step's plan names belongs to that step's generation, and the tests here
  // would run with it while this generation left it out, so it is refused.
  const scope = yield request('candidate-scope', {});
  const entryPaths = (entry) => [entry.oldPath, entry.newPath].filter(Boolean);
  const excludedChanges = scope ? [...new Set(allApplicationEntries.flatMap(entryPaths))].filter((candidate) => !scope.allows(candidate)).sort() : [];
  const outside = scope ? yield request('outside-candidates', {}) : null;
  const unsafeExclusions = excludedChanges.filter((candidate) => scope.unsafe(candidate) && !outside?.(candidate));
  if (unsafeExclusions.length) {
    throw (yield request('format-preflight-refusal', {reason: 'unsafe', unsafeExclusions}));
  }
  const unresolved = requireReconciled ? yield request('unreconciled-candidates', {scope}) : [];
  if (unresolved.length) throw (yield request('format-preflight-refusal', {reason: 'unreconciled', unresolved}));
  const applicationEntries = scope
    ? allApplicationEntries.filter((entry) => entryPaths(entry).every((candidate) => scope.allows(candidate)))
    : allApplicationEntries;
  const applicationChangeSet = { ...changeSet, entries: applicationEntries };
  const boundaryResult = evaluateSourceBoundary(applicationChangeSet, phase.sourceBoundary, {
    phaseId: phase.id, allowedPath: isAllowedTestAutomationPath
  });
  if (!boundaryResult.valid) {
    throw new SingularityFlowError(
      `Phase ${phase.id} may change test automation only; product-source endpoints are outside its boundary: ${boundaryResult.violations.map((entry) => entry.path).join(', ')}`,
      { code: 'CHANGE_SET_POLICY_VIOLATION' }
    );
  }
  const {changedPaths,changedTestCandidates,deletedPaths,deletedSourcePaths,configurationPaths,changedSourcePaths}=deliveryPathCohorts(applicationEntries);
  const changedEndpointPaths = new Set(applicationEntries.flatMap((entry) =>
    [entry.oldPath, entry.newPath].filter(Boolean)));
  const priorGenerationCommit = phase.generationIntent?.baseline?.previousGenerationCommit ?? null;
  const documentationOnlyCorrection = Number(phase.generation ?? 0) > 0
    && (sourceBasis===null||baselineCommit!==null)
    && priorGenerationCommit === baselineCommit
    && applicationEntries.length > 0
    && applicationEntries.every((entry) => [entry.oldPath, entry.newPath]
      .filter(Boolean).every(isDocumentationPath));
  if (documentationOnlyCorrection) {
    yield request('documentation-baseline', {priorGenerationCommit});
  }
  const sourceExtensions = [...new Set((phase.qualityCommands ?? []).flatMap((command, index) => {
    try { return normalizeExternalCommand(command, index).result?.sourceExtensions ?? []; }
    catch { return []; }
  }))];
  const changedTestPaths = [];
  const supportingTestPaths = [];
  for (const candidate of changedTestCandidates) {
    if (yield request('executable-test-path', {candidate, sourceExtensions})) changedTestPaths.push(candidate);
    else if (isSupportingTestResourcePath(candidate)) supportingTestPaths.push(candidate);
  }
  const symlinks = applicationEntries.filter((entry) => entry.newContent?.kind === 'symlink');
  if (symlinks.length && (workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject') === 'reject') {
    throw new SingularityFlowError(
      `Source or test delivery cannot use symbolic links: ${symlinks.map((entry) => entry.newPath).join(', ')}`,
      { code: 'SYMLINK_DELIVERY_FORBIDDEN' }
    );
  }
  const intentRevalidation = Boolean(
    phase.intentAmendmentRevalidation?.id && !phase.intentAmendmentRevalidation?.revalidatedAt
  );
  // A correction generation may exercise acceptance tests delivered by its previous generation
  // without changing their source merely to satisfy the gate. Reuse only the exact governed test
  // paths from the prior receipt. First generations normally introduce/change their
  // tests; the independently authenticated TRP baseline route below is explicit.
  const reusableTestCandidates = Number(phase.generation ?? 0) > 0
    ? (phase.deliveryEvidence?.testPaths ?? []).filter((candidate) => !changedEndpointPaths.has(candidate))
    : [];
  const reusableTestPaths = yield request('reusable-paths', {candidates: reusableTestCandidates, priorEvidence: phase.deliveryEvidence?.paths, options: {role: 'test', sourceExtensions}});
  // A reviewed pre-feature baseline may supply already-existing test source to the
  // first generation. This only plans the cohort: current execution, exact risk
  // matching, acceptance tags and ordinary source safety remain mandatory below.
  const baselineTestPaths = yield request('reviewed-baseline-tests', {});
  // Behaviour that already exists is verified by the tests the plan names for it, unchanged
  // [E2G-010]; they run and are checked like any delivered test.
  const obligations = yield request('allocated-obligations', {});
  const existingTestPaths = [];
  for (const candidate of new Set((obligations ?? []).filter((obligation) => obligation.fulfillment === 'existing')
    .flatMap((obligation) => obligation.tests ?? []))) {
    if (changedEndpointPaths.has(candidate) || !isAllowedTestAutomationPath(candidate)) continue;
    const secured = yield request('working-path-facts', {candidate, label: 'Planned existing test'});
    if (secured.exists && secured.regular && (yield request('executable-test-path', {candidate, sourceExtensions}))) {
      existingTestPaths.push(candidate);
    }
  }
  const testPaths = [...new Set([...changedTestPaths, ...reusableTestPaths, ...baselineTestPaths, ...existingTestPaths])].sort();
  // A reviewer-returned Testing defect can change only executable tests or their supporting
  // resources. Do not require a fake product-source edit in the new Code generation: reuse the
  // exact prior approved source bytes, but only when the latest open change request was created
  // by the guarded Testing repair route and still binds this Code generation and its old receipt.
  const repairRequest = [...(workflow.changeRequests ?? [])].reverse().find((request) =>
    request.status === 'open' && request.targetPhase === phase.id && request.testingRepair
      && reviewMayReturnToCode(workflow.phases?.[request.sourcePhase], phase));
  const repair = repairRequest?.testingRepair;
  const repairDecision = (workflow.phases?.[repairRequest?.sourcePhase]?.approvals ?? []).find((decision) =>
    decision.decision === 'rejected' && !decision.invalidatedAt
      && decision.target === phase.id && decision.changeRequestId === repairRequest?.id);
  const testOnlyChange = applicationEntries.length > 0
    && applicationEntries.every((entry) => [entry.oldPath, entry.newPath]
      .filter(Boolean).every(isAllowedTestAutomationPath));
  const repairBound = Boolean(repair)
    && Boolean(repairDecision)
    && Number(phase.generation ?? 0) > 0
    && Number(repair.codeGeneration) === Number(phase.generation)
    && repair.codeGenerationCommit === phase.generationCommit
    && String(repair.codeReceiptSha256).replace(/^sha256:/u, '')
      === String(phase.deliveryEvidence?.receiptSha256 ?? '').replace(/^sha256:/u, '')
    && /^sha256:[a-f0-9]{64}$/u.test(repair.confirmation ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(repair.changeSetDigest ?? '')
    && Array.isArray(repair.changedPaths) && repair.changedPaths.length > 0;
  // A confirmed repair whose returned edits were all undone leaves the approved generation exactly
  // as it was: nothing further to change. It carries that generation's source and tests unchanged,
  // runs them again and is reviewed again, as an intent revalidation that changes nothing is.
  const withdrawnRepair = repairBound && !applicationEntries.length;
  const confirmedRepair = repairBound && !changedSourcePaths.length && (testOnlyChange || withdrawnRepair);
  // A reviewer who returned a submitted generation asking only for tests made the same request
  // after submission: its rejection (or reopen) reset exactly this published generation, so the
  // generation is judged as the same test repair. The implementation it carries is the previous
  // generation's exact source bytes, never a claim of new work; a first generation has none.
  const returnRequest = !confirmedRepair && reworkReturnRequest(workflow, phase);
  const reworkRepair = !confirmedRepair && !changedSourcePaths.length && testOnlyChange && Boolean(returnRequest);
  const testOnlyRepair = confirmedRepair || reworkRepair;
  const earlierReturn = !intentRevalidation && !testOnlyRepair && !applicationEntries.length ? earlierReturnRequest(workflow, phase) : null;
  const reusableSourceCandidates = intentRevalidation || testOnlyRepair || documentationOnlyCorrection || earlierReturn
    ? (phase.deliveryEvidence?.sourcePaths ?? []).filter((candidate) =>
      !changedEndpointPaths.has(candidate) && !isDocumentationPath(candidate) && !isConfigurationPath(candidate))
    : [];
  const reusableSourcePaths = yield request('reusable-paths', {candidates: reusableSourceCandidates, priorEvidence: phase.deliveryEvidence?.paths, options: {role: 'source'}});
  const sourcePaths = [...new Set([...changedSourcePaths, ...reusableSourcePaths])].sort();
  const errors = [];
  // Each sentence is presentation; its identity {code, path, value} (never a line or wording) names
  // the finding a dispute or an escalation matches [SDA-AC-022]. Kept in the same order as errors.
  const identities = [];
  const report = (problem, identity) => { errors.push(problem); identities.push(identity); };
  const reportAll = (problems, findings) => problems.forEach((problem, index) => report(problem, findings[index]));
  // What this step owes comes from its allocated obligations [E2G-010]: existing behaviour changes
  // nothing, and test-only, document, configuration and removal work need no new product source.
  const fulfillment = yield* fulfillmentEvidenceReplay(obligations, changedPaths, deletedPaths);
  const changeRequired = !obligations || obligations.some((obligation) => !['existing', 'evidence'].includes(obligation.fulfillment));
  const sourceRequired = !obligations || obligations.some(changesProductSource);

  const unchangedGeneration = !applicationEntries.length && !intentRevalidation && !withdrawnRepair && !earlierReturn && changeRequired;
  if (unchangedGeneration) {
    report('no application source or test paths changed during the work interval', { code: 'code.delivery.generation-unchanged' });
  }
  const implementationMissing = phase.sourceBoundary !== 'test-automation' && !sourcePaths.length && sourceRequired;
  if (implementationMissing) {
    report('no product source path changed; a summary, configuration or test-only edit is not an implementation',
      { code: 'code.delivery.product-source-missing' });
  }
  reportAll(fulfillment.problems, fulfillment.problemFindings);
  const requiredAcIds = yield request('required-acceptance', {});
  // A test is owed only where the plan plans one. Rows the plan reviewed as needing none (a document,
  // configuration, removal or screenshot row whose tests are not applicable, or one proven by
  // inspection) had only a dated dispute past this, and none at all without approvers (2026-10-28).
  const testsOwed = !obligations || requiredAcIds.length > 0 || obligations.some((obligation) =>
    (obligation.tests ?? []).length > 0 || !['not-applicable', 'non-test'].includes(obligation.testDisposition ?? 'unspecified'));
  if (!testPaths.length && testsOwed) {
    // A file named as a test outside every recognised test folder is counted as product source; say
    // so, or the author keeps re-tagging a test the gate never reads.
    const uncounted = changedPaths.filter((candidate) => !isAllowedTestAutomationPath(candidate) && isTestSourceName(candidate));
    report(uncounted.length
      ? `no acceptance test is available for the implementation: ${uncounted.slice(0, 5).join(', ')}${uncounted.length > 5 ? ` and ${uncounted.length - 5} more` : ''} ${uncounted.length === 1 ? 'is' : 'are'} named as tests but not in a recognised test folder (test, tests, spec, __tests__, e2e, src/<name>Test, <Target>Tests, <Project>.Tests), so ${uncounted.length === 1 ? 'it counts' : 'they count'} as product source`
      : 'no acceptance test is available for the implementation', { code: 'code.delivery.acceptance-test-missing' });
  }

  const criteria = specificationCriteria(yield request('specification-records', {}), workflow, config);
  const scanned = yield request('acceptance-tags', {testPaths});
  // In a namespace other Stories share, a test tag names this Story's criterion only where this Story
  // added it: an earlier Story's tag with the same ID neither satisfies nor witnesses it [E2G-015].
  const shared = scanned.locations.filter((location) => criteria?.held.has(location.clauseId)
    && criteria.sharedNamespaces.has(namespaceOf(location.clauseId)));
  const own = shared.length ? yield request('story-added-acceptance-tags', {locations: shared, pathContext}) : null;
  const othersTags = own ? shared.filter((location) => !own.has(tagKey(location.testSource, location.line))) : [];
  const tags = othersTags.length ? withoutTags(scanned, othersTags) : scanned;
  const taggedAcIds = tags.ids;
  const missingAcIds = requiredAcIds.filter((id) => !taggedAcIds.includes(id));
  if (missingAcIds.length) {
    report(`changed tests do not contain required traceability tags: ${missingAcIds.map((id) => `@ac:${id}${otherStoryTagsNote(othersTags
      .filter((location) => location.clauseId === id).map((location) => ({ path: location.testSource, line: location.line })), 'criterion')}`).join(', ')}`,
    { code: 'code.delivery.acceptance-tag-missing', value: missingAcIds });
  }
  // A test carries the nearest tag with its ID at or above its line.
  const othersTag = ({ testSource, clauseId, line }) => line != null && othersTags.some((location) =>
    location.testSource === testSource && location.clauseId === clauseId && location.line === Math.max(0, ...scanned.locations
      .filter((candidate) => candidate.testSource === testSource && candidate.clauseId === clauseId && candidate.line <= line)
      .map((candidate) => candidate.line)));
  const witnessDiscovery = yield request('acceptance-witnesses', {
    testPaths, sourcePaths, requiredAcIds: requiredAcIds.filter((id) => taggedAcIds.includes(id)), bindings: tags.bindings,
    othersTag, executionMode: storyTestScope(workflow)
  });
  reportAll(witnessDiscovery.errors, witnessDiscovery.errorFindings);
  // A tag naming a criterion the specification does not hold is refused while this generation is
  // still editable, not at submission once it has been spent [E2G-015].
  const unknownCriteria = yield* preflightUnknownCriteria(criteria, applicationChangeSet, {
    locations: tags.locations, witnesses: witnessDiscovery.witnesses, unattachedTags: witnessDiscovery.unattachedTags,
    owed: requiredAcIds, changeSet: applicationChangeSet
  });
  if (unknownCriteria.length) {
    const named = unknownCriteria.map((finding) => `@ac:${finding.clauseId} at ${finding.path}${finding.line ? `:${finding.line}` : ''}`).join('; ');
    errors.unshift(criteria ? `tests name criteria the active specification does not hold: ${named}`
      : `tests name criteria, but this Story has no specification index, so no test can witness one: ${named}`);
    identities.unshift({ code: 'code.delivery.criterion-tag-unknown', value: unknownCriteria.map((finding) => finding.clauseId) });
  }
  const sourceBindings = yield request('source-clause-bindings', {sourcePaths, deletedSourcePaths, changeSet: applicationChangeSet});
  // Each obligation delivered in source is bound to its changed hunks and its explanation [E2G-011].
  const bound = sourceBindings.mode === 'enforce' && sourceBindings.required.length
    ? yield request('implementation-bindings', {changeSet, required: sourceBindings.required, tags: sourceBindings.bindings})
    : null;
  if (bound) reportAll(bound.problems, bound.problemFindings);
  const absentTags = sourceBindings.missing.filter((missing) => !missing.unchangedTags?.length);
  if (absentTags.length) {
    report(`planned product source does not contain required clause comments: ${absentTags
      .map(({ clauseId, expectedPaths, otherStoryTags }) => `@clause:${clauseId} in ${expectedPaths.join(' or ')}${otherStoryTagsNote(otherStoryTags)}`).join('; ')}`,
    { code: 'code.delivery.source-clause-tag-missing', value: absentTags.map((missing) => missing.clauseId) });
  }
  // The file holds the tag, but this generation does not deliver that file: say so, and what counts.
  const undeliveredTags = sourceBindings.missing.filter((missing) => missing.unchangedTags?.length);
  if (undeliveredTags.length) {
    report(`required clause comments are only in planned source this generation does not deliver: ${undeliveredTags
      .map(({ clauseId, unchangedTags }) => `@clause:${clauseId} at ${unchangedTags.map((tag) => `${tag.path}:${tag.line}`).join(', ')}`).join('; ')}`
      + '. A clause comment counts in planned source the generation changes, or in the previous generation\'s unchanged source when a reviewer\'s return asked only for tests',
    { code: 'code.delivery.source-clause-tag-undelivered', value: undeliveredTags.map((missing) => missing.clauseId) });
  }
  const enforceCornerCases = workflow.resolution?.codeDelivery?.cornerCaseObligations === 'enforce'
    || config.governance?.requireCornerCaseCoverage === true;
  const enforceAssertionAdequacy = enforceCornerCases
    || workflow.resolution?.codeDelivery?.assertionAdequacy === 'enforce'
    || config.governance?.requireAssertionAdequacy === true;
  let cornerCaseGate = null;
  if (enforceCornerCases || enforceAssertionAdequacy) {
    cornerCaseGate = yield request('corner-case-analysis', {changeSet, sourcePaths, testPaths, enforceCornerCases, enforceAssertionAdequacy});
    reportAll(cornerCaseGate.problems, cornerCaseGate.problemFindings);
    cornerCaseGate.compactMatrix = yield request('compact-corner-cases', {matrix: cornerCaseGate.matrix});
  }
  // The step's approvers may accept these exact problems for this exact candidate as a disputed
  // finding [recoverable-findings M2]; anything else, or any change, still refuses.
  const candidateSha256 = errors.length ? sourceBasis
    ? 'sha256:'+receiptDigest({profile:'sflow-namespace-code-candidate/v1',sourceBasis,entries:applicationEntries})
    : codeDeliveryCandidateSha256(applicationEntries) : null;
  const findings = errors.length ? identities.map((identity) => canonicalFinding(identity)) : [];
  const acceptedDispute = errors.length && !unknownCriteria.length && !ignoreDisputes
    ? (yield request('accepted-dispute', {problems: errors, findings, candidateSha256})).active : null;
  if (errors.length && !acceptedDispute) {
    throw (yield request('format-preflight-refusal', {reason: 'evidence', errors, unknownCriteria, criteria, requiredAcIds, unchangedGeneration, testOnlyChange, implementationMissing, sourceBindings, bound, cornerCaseGate, findings, candidateSha256, fulfillment, sourcePaths, testPaths, missingAcIds, obligations, witnessDiscovery}));
  }

  const delivery = {
    requirement: 'source-and-tests',
    baselineCommit,
    ...(sourceBasis?{sourceBasis}:{}),
    generationIntentId: sourceBasis?.generationIntentId??phase.generationIntent?.id??null,
    changeSet,
    changeClassification: classifyDeliveryChanges(changeSet, {
      generatedRoots: workflow.resolution?.ast?.generatedRoots ?? config.ast?.generatedRoots ?? [],
      pathContext
    }),
    paths: yield request('path-evidence', {paths: [...new Set([
      ...changedPaths, ...deletedPaths, ...reusableSourcePaths, ...reusableTestPaths, ...baselineTestPaths, ...existingTestPaths
    ])].sort(), changeSet}),
    sourcePaths,
    configurationPaths,
    deletedSourcePaths: [...new Set(deletedSourcePaths)].sort(),
    testPaths,
    supportingTestPaths,
    documentationCorrection: documentationOnlyCorrection ? {
      priorGeneration: Number(phase.generation),
      priorGenerationCommit,
      changedPaths: [...new Set(applicationEntries.flatMap((entry) =>
        [entry.oldPath, entry.newPath].filter(Boolean)))].sort(),
      reusedSourcePaths: reusableSourcePaths,
      reusedTestPaths: reusableTestPaths
    } : null,
    intentRevalidation: intentRevalidation ? phase.intentAmendmentRevalidation.id : null,
    ...(earlierReturn ? { earlierReturn: { changeRequestId: earlierReturn.id, targetPhase: earlierReturn.targetPhase, priorGeneration: Number(phase.generation) } } : {}),
    testingRepair: confirmedRepair ? {
      changeRequestId: repairRequest.id,
      priorGeneration: repair.codeGeneration,
      priorReceiptSha256: repair.codeReceiptSha256,
      reusedSourcePaths: reusableSourcePaths
    } : reworkRepair ? {
      changeRequestId: returnRequest.id,
      priorGeneration: Number(phase.generation),
      priorReceiptSha256: phase.deliveryEvidence.receiptSha256,
      reusedSourcePaths: reusableSourcePaths
    } : null,
    acceptanceCriteria: {
      required: requiredAcIds, tagged: taggedAcIds, missing: [], ambiguous: [],
      inferred: tags.inferred, bindings: tags.bindings,
      witnesses: witnessDiscovery.witnesses, unattachedTags: witnessDiscovery.unattachedTags,
      profiles: witnessDiscovery.profiles
    },
    sourceBindings,
    excludedChanges,
    fulfillment: fulfillment.obligations,
    implementationBindings: bound ? { bindings: bound.bindings, bindingsSha256: bound.bindingsSha256 } : null,
    ...(cornerCaseGate?.matrix ? { cornerCaseMatrix: cornerCaseGate.compactMatrix } : {})
  };
  // Shown to whoever reads the result; not serialized into the delivery receipt, whose record
  // family is versioned separately. The dispute itself is the retained, reviewed record.
  if (acceptedDispute) Object.defineProperty(delivery, 'acceptedDispute', { value: acceptedDispute });
  // The preview loads bound Story records; defer that dependency until the kernel is initialized.
  try { yield request('candidate-coverage', {strictCoverage, delivery}); }
  catch (error) {
    // Internal candidate bytes are used to bind risk, not serialized into CLI errors or reports.
    if (error.code === 'SPEC_COVERAGE_INCOMPLETE') Object.defineProperty(error, 'qualityRiskCandidate', { value: delivery });
    throw error;
  }
  return delivery;
}
  return Object.freeze({codeDeliveryReceiptReplay,codeDeliveryPreflightReplay,namespaceCodeDeliveryPreflightReplay,plannedSourceClauseBindingsReplay,safeEvidencePath,bindingsDigest,cornerCaseMatrixDigest,prepareTestReportReader,plannedImplementationPaths,plannedProductSourcePaths,plannedSupportingFiles,changesProductSource,codeDeliveryCandidateScope,plannedCodeStepPaths,canonicalFinding,canonicalFindingId,codeDeliveryCandidateSha256});
}

/** Where a missing clause's tag already is, in a planned file this generation does not change. */
export function unchangedClauseTagsNote(tags = []) {
  if (!tags.length) return '';
  const where = tags.map((tag) => `${tag.path}:${tag.line}`).join(', ');
  return ` (the tag at ${where} is in a file this generation neither changes nor carries, so it binds nothing here: a clause comment counts in planned source the generation changes, or in the previous generation's unchanged source when a reviewer's return asked only for tests)`;
}

/** Why a tag the Story did not add binds nothing here, said after the tag a step still owes. */
export function otherStoryTagsNote(tags = [], noun = 'clause') {
  if (!tags.length) return '';
  const where = tags.map((tag) => `${tag.path}:${tag.line}`).join(', ');
  return tags.length === 1 ? ` (the tag at ${where} is from before this Story, so it names an earlier Story's ${noun})`
    : ` (the tags at ${where} are from before this Story, so they name an earlier Story's ${noun})`;
}

export const CANONICAL_FINDING_ID=/^FND-[a-f0-9]{24}$/u;

/** Select only from authenticated return observations, retaining every earlier unresolved return. */
export function selectCurrentCodeReturn(generation,returns){
  if(!Number.isSafeInteger(generation)||generation<1||!Array.isArray(returns)||returns.length>256
    ||returns.some(row=>typeof row?.id!=='string'||!row.id||!Number.isSafeInteger(row.generation)||row.generation<0||row.generation>generation)
    ||new Set(returns.map(row=>row.id)).size!==returns.length)throw new SingularityFlowError(
      'The Code return inventory has invalid or duplicated original identities.',{code:'ENGINE_STORAGE_CORRUPT'});
  const current=returns.filter(row=>row.generation===generation);
  if(current.length!==1)throw new SingularityFlowError('A Code successor needs exactly one authenticated return for its actual predecessor generation.',{code:'ENGINE_CODE_REWORK_REQUIRED'});
  return {current:current[0].id,earlier:returns.filter(row=>row.generation<generation).map(row=>row.id)};
}
