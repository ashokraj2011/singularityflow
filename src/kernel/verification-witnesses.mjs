import {SingularityFlowError} from '../foundation/failures.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {normalizeQualifiedClauseId} from '../foundation/traceability-ids.mjs';
/** Native witness semantics over explicit declaration and execution observations. No host I/O. */
import {ASSURANCE,TEST_ADAPTER_PROFILES,profileCeiling,verificationExecutionProfiles} from './verification-policy.mjs';
import {externalCommandConfigurationPolicies} from './configuration-path-policies.mjs';
import {testDeliveryPolicies} from './source-path-policies.mjs';
export const IDENTITY_ASSURANCE = Object.freeze(['declared', 'source-bound']);
export const EXECUTION_ASSURANCE = Object.freeze(['none', 'module-observed', 'exact-local-observed', 'exact-authenticated']);
export function combinedAssurance({ identity, execution, passed }) {
  if (!passed || execution === 'none') return IDENTITY_ASSURANCE.includes(identity) ? identity : 'none';
  if (identity !== 'source-bound' && ['exact-local-observed', 'exact-authenticated'].includes(execution)) return 'module-observed';
  return execution;
}

/**
 * Join one exact test declaration to the occurrences of one test run [E2G-016].
 *
 * Pure. A declaration passes only through exactly one occurrence of its own identity (or, for a
 * parameterized declaration, exactly its statically known set of instances, every one passing).
 * An unrelated passing test in the same module, file or run never stands in for it. The outcome is
 * one closed word, from the strongest blocker down: inconclusive (the declaration itself cannot be
 * pinned down), missing, ambiguous, failed, unverified-skipped, flaky, passed.
 */

export const WITNESS_OUTCOMES = Object.freeze([
  'inconclusive', 'missing', 'ambiguous', 'failed', 'unverified-skipped', 'flaky', 'passed'
]);

/** Gap codes that describe a declaration without making its identity unknowable. */
const NON_BLOCKING_GAPS = new Set([]);

function sameList(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fileMatches(occurrenceFile, sourcePath) {
  if (!occurrenceFile) return null;
  const file = String(occurrenceFile).replaceAll('\\', '/');
  // Playwright names a spec's file from its test directory, which may sit below the repository root.
  return file === sourcePath || file.endsWith(`/${sourcePath}`) || sourcePath.endsWith(`/${file}`);
}

function blockingGaps(declaration) {
  return (declaration.gaps ?? []).filter((entry) => !NON_BLOCKING_GAPS.has(entry.code));
}

function candidateOccurrences(declaration, occurrences, language) {
  if (language === 'java') {
    const className = declaration.className ?? `${declaration.packageName}.${declaration.classPath.join('$')}`;
    const inClass = occurrences.filter((occurrence) => occurrence.className === className);
    if (declaration.parameters) {
      const method = declaration.methodName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const instance = new RegExp(`^${method}(?:\\(.*\\))?\\[\\d+\\]$`, 'u');
      return inClass.filter((occurrence) => instance.test(occurrence.name ?? ''));
    }
    return inClass.filter((occurrence) => occurrence.name === declaration.methodName || occurrence.name === `${declaration.methodName}()`);
  }
  if (language === 'python') {
    // pytest's class is the file's dotted module path from the directory it ran in: a suffix of the declaration's.
    return occurrences.filter((occurrence) => occurrence.className && `.${declaration.className}`.endsWith(`.${occurrence.className}`)
      && (declaration.parameters ? String(occurrence.name).startsWith(`${declaration.methodName}[`) : occurrence.name === declaration.methodName));
  }
  // A persisted attempt names an occurrence's describe path `suitePath`; a fresh parse, `ancestorTitles`.
  const inSuite = occurrences.filter((occurrence) => sameList(occurrence.suitePath ?? occurrence.ancestorTitles ?? [], declaration.suitePath));
  const named = declaration.parameters
    ? (() => {
      if (!declaration.parameters.titlePattern) return [];
      const pattern = new RegExp(declaration.parameters.titlePattern, 'u');
      return inSuite.filter((occurrence) => pattern.test(occurrence.name ?? ''));
    })()
    : inSuite.filter((occurrence) => occurrence.name === declaration.name);
  // A report that names each occurrence's file narrows the match to this declaration's file.
  if (declaration.framework === 'node:test') {
    // Names alone can credit another file; line identity also excludes helper-created tests.
    return named.filter((occurrence) => occurrence.file === declaration.sourcePath
      && occurrence.line === declaration.line);
  }
  if (named.some((occurrence) => fileMatches(occurrence.file, declaration.sourcePath) != null)) {
    return named.filter((occurrence) => fileMatches(occurrence.file, declaration.sourcePath) !== false);
  }
  return named;
}

function outcomeOf(occurrences) {
  if (occurrences.some((occurrence) => occurrence.outcome === 'failed')) return 'failed';
  if (occurrences.some((occurrence) => occurrence.outcome === 'skipped')) return 'unverified-skipped';
  if (occurrences.some((occurrence) => occurrence.flaky === true)) return 'flaky';
  return 'passed';
}

/**
 * The result of one declaration in one run. `run` is the enclosing command's own result: a test
 * that passed inside a run that failed, timed out or was interrupted does not pass.
 */
export function joinDeclaration(declaration, occurrences, { language, runner = null, run = { completed: true, succeeded: true } } = {}) {
  const gaps = blockingGaps(declaration);
  const reasons = gaps.map((entry) => entry.code);
  if (declaration.parameters && language === 'java' && runner === 'gradle') {
    reasons.push('PARAMETERIZED_RUNNER_NAMING_UNSUPPORTED');
  }
  if (reasons.length) return { outcome: 'inconclusive', reasons, occurrences: [] };
  const matched = candidateOccurrences(declaration, occurrences ?? [], language);
  const summary = matched.map((occurrence) => ({
    name: occurrence.name ?? null, outcome: occurrence.outcome, flaky: occurrence.flaky === true
  }));
  if (!matched.length) return { outcome: 'missing', reasons: ['NO_OCCURRENCE'], occurrences: [] };
  if (declaration.parameters) {
    const expected = declaration.parameters.count;
    // A pytest parametrize set is known only at run time (count null): every instance that ran must pass.
    if (matched.length < expected) return { outcome: 'missing', reasons: ['INSTANCES_MISSING'], expected, occurrences: summary };
    if (expected != null && matched.length > expected) return { outcome: 'ambiguous', reasons: ['INSTANCES_EXCEED_DECLARATION'], expected, occurrences: summary };
  } else if (matched.length > 1 && !(declaration.framework === 'playwright' && new Set(matched.map((occurrence) => occurrence.project ?? null)).size === matched.length)) {
    // A Playwright test runs once in each project; every project's run must pass. The same project twice is ambiguous.
    return { outcome: 'ambiguous', reasons: ['DUPLICATE_OCCURRENCE'], occurrences: summary };
  }
  const outcome = outcomeOf(matched);
  if (outcome === 'passed' || outcome === 'flaky') {
    if (!run.completed) return { outcome: 'inconclusive', reasons: ['RUN_INCOMPLETE'], occurrences: summary };
    if (!run.succeeded) return { outcome: 'failed', reasons: ['RUN_FAILED'], occurrences: summary };
  }
  return { outcome, reasons: [], occurrences: summary, ...(declaration.parameters ? { expected: declaration.parameters.count } : {}) };
}

/**
 * How each criterion witness stands against the run of its candidate [E2G-016, E2G-017].
 *
 * Pure, and safe for every surface. An exact witness (the Jest, Vitest or JUnit 5 declaration a
 * tag sits on) passes only through its own single occurrence in the authoritative attempt of its
 * command: the latest terminal attempt of the published candidate. A file-level witness (a module
 * whose adapter only counts tests) passes when that module command passed, and says so:
 * module-observed. Each witness must reach the strongest assurance its module's adapter can produce
 * (D2); a pass below it is an assurance shortfall, not a pass.
 */

const OUTCOME_STATUS = Object.freeze({
  passed: 'met', flaky: 'inconclusive', failed: 'failed', 'unverified-skipped': 'missing',
  missing: 'missing', ambiguous: 'inconclusive', inconclusive: 'inconclusive',
  'passed-with-skips': 'inconclusive', unavailable: 'inconclusive', 'not-run': 'pending'
});

/** A short human name for a witness: the test's identity, or its file. */
export function witnessLabel(witness) {
  const identity = witness.identity ?? {};
  if (identity.className) return `${identity.className}#${identity.methodName}`;
  if (identity.name != null) return `'${[...(identity.suitePath ?? []), identity.name].join(' › ')}' in ${witness.testSource}`;
  return witness.testSource;
}

function declarationOf(witness) {
  const identity = witness.identity ?? {};
  return identity.className
    ? { className: identity.className, methodName: identity.methodName, parameters: witness.parameters ?? null, gaps: [] }
    : { sourcePath: witness.testSource, framework: identity.framework, line: witness.line,
      suitePath: identity.suitePath ?? [], name: identity.name, parameters: witness.parameters ?? null, gaps: [] };
}

function attemptRun(attempt) {
  return {
    completed: attempt.terminal !== false && attempt.timedOut !== true && !['blocked', 'unavailable'].includes(attempt.status),
    succeeded: attempt.status === 'passed' && (attempt.exitCode ?? 0) === 0 && Number(attempt.tests?.failed ?? 0) === 0
  };
}

/**
 * One witness's result. `attempt` is the authoritative attempt of the witness's command, or null
 * when none ran; `submitted` says whether the delivery reached submission (only then is an absent
 * result missing rather than pending).
 */
export function witnessResult(witness, attempt, { submitted = true, enforceAssertionAdequacy = false } = {}) {
  const profile = witness.profile ?? 'module-counts-v1';
  const requiredAssurance = profileCeiling(profile);
  const base = {
    label: witnessLabel(witness), clauseId: witness.clauseId, testSource: witness.testSource, profile,
    commandId: witness.commandId ?? null, identityKey: witness.logicalTestId ?? null, requiredAssurance,
    attemptId: attempt?.attemptId ?? null,
    ...(witness.assertions ? { assertions: witness.assertions } : {})
  };
  const finish = (result) => {
    const passed = result.status === 'met';
    const assurance = combinedAssurance({ identity: result.identity, execution: result.execution, passed });
    const shortfall = passed && ASSURANCE.indexOf(assurance) < ASSURANCE.indexOf(requiredAssurance);
    return { ...base, ...result, assurance, status: shortfall ? 'inconclusive' : result.status, shortfall };
  };
  if (!attempt) {
    return finish({
      outcome: 'not-run', status: submitted ? 'missing' : 'pending',
      identity: witness.identity && !(witness.gaps ?? []).length ? 'source-bound' : 'declared', execution: 'none', reasons: ['NO_ATTEMPT']
    });
  }
  const run = attemptRun(attempt);
  if (!witness.identity) {
    if (witness.resultAdapter === 'node-tap' || attempt.adapter === 'node-tap' || profile === 'node-test-v1') return finish({
      outcome: 'inconclusive', status: 'inconclusive', identity: 'declared', execution: 'none',
      reasons: ['NODE_TEST_EXACT_IDENTITY_REQUIRED']
    });
    const skipped = Number(attempt.tests?.skipped ?? 0);
    const outcome = !run.completed ? 'unavailable' : !run.succeeded ? 'failed' : skipped > 0 ? 'passed-with-skips' : 'passed';
    return finish({ outcome, status: OUTCOME_STATUS[outcome], identity: 'declared', execution: run.succeeded ? 'module-observed' : 'none', skipped, reasons: [] });
  }
  if ((witness.gaps ?? []).length) {
    return finish({ outcome: 'inconclusive', status: 'inconclusive', identity: 'declared', execution: run.succeeded ? 'module-observed' : 'none', reasons: [...witness.gaps] });
  }
  const adapter = TEST_ADAPTER_PROFILES[profile] ?? {};
  let joined = joinDeclaration(declarationOf(witness), attempt.occurrences ?? [], { language: adapter.language, runner: adapter.runner ?? null, run });
  // A run that failed or ended without a result for this test proves nothing about it either way.
  if (joined.outcome === 'missing' && !run.succeeded) {
    joined = { outcome: run.completed ? 'failed' : 'unavailable', reasons: ['RUN_FAILED_WITHOUT_RESULT'], occurrences: [] };
  }
  // Exact execution was observed only when this test's own occurrence was found and judged.
  const observed = (joined.occurrences ?? []).length > 0 && ['passed', 'flaky', 'failed', 'unverified-skipped'].includes(joined.outcome);
  const checkAdequacy = enforceAssertionAdequacy || witness.enforceAssertionAdequacy === true;
  if (checkAdequacy && joined.outcome === 'passed' && witness.assertions && witness.assertions.adequacy !== 'adequate') {
    const adequacyReason = witness.assertions.adequacy === 'tautological'
      ? 'TEST_ASSERTION_TAUTOLOGICAL'
      : 'TEST_ASSERTION_MISSING';
    return finish({
      outcome: 'inconclusive', status: 'inconclusive', identity: 'source-bound',
      execution: observed ? 'exact-local-observed' : run.succeeded ? 'module-observed' : 'none',
      reasons: [adequacyReason], occurrences: joined.occurrences ?? []
    });
  }
  return finish({
    outcome: joined.outcome, status: OUTCOME_STATUS[joined.outcome] ?? 'inconclusive', identity: 'source-bound',
    execution: observed ? 'exact-local-observed' : run.succeeded ? 'module-observed' : 'none',
    reasons: joined.reasons ?? [], occurrences: joined.occurrences ?? []
  });
}

/**
 * A criterion's witnesses under an `all` contract: every witness must pass at its required
 * assurance; the strongest blocker wins; the rung is the weakest any witness reached. An empty
 * witness set never passes.
 */
export function aggregateWitnesses(results) {
  if (!results.length) return { status: 'missing', assurance: 'none', identity: 'none', execution: 'none' };
  const statuses = results.map((entry) => entry.status);
  const weaker = (list, left, right) => (list.indexOf(left) <= list.indexOf(right) ? left : right);
  return {
    status: ['failed', 'inconclusive', 'missing', 'pending'].find((value) => statuses.includes(value)) ?? 'met',
    assurance: results.map((entry) => entry.assurance).reduce((left, right) => weaker(ASSURANCE, left, right)),
    identity: results.some((entry) => entry.identity === 'declared') ? 'declared' : 'source-bound',
    execution: results.map((entry) => entry.execution).reduce((left, right) => weaker(EXECUTION_ASSURANCE, left, right))
  };
}



/** One witness result in words, for review and submission surfaces; the evaluator stays the authority. */


/** Witness results grouped by criterion, each with the `all` aggregate of its witnesses. */
export function criterionResults(results) {
  const byClause = new Map();
  for (const result of results) byClause.set(result.clauseId, [...(byClause.get(result.clauseId) ?? []), result]);
  return [...byClause.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([clauseId, entries]) => ({ clauseId, ...aggregateWitnesses(entries), witnesses: entries }));
}

export function testCommandProvenance(phase, command) {
  return command?.storyDecision ? 'story-decision' : (phase.qualityCommands ?? []).includes(command) ? 'configured' : 'inferred';
}

export function acceptanceWitnessPolicies(pathSyntax,testFacts){
 const {normalizeExternalCommand}=externalCommandConfigurationPolicies(pathSyntax),{testCommandCoversPath}=testDeliveryPolicies(pathSyntax,testFacts);
 const {profileForCommand,profileIsExact,testAdapterProfile}=verificationExecutionProfiles(pathSyntax),witnessRequest=(kind,fields)=>Object.freeze({kind,...fields});
function witnessIdentity(declaration) {
  return declaration.schema === 'junit5-method-v2' || declaration.framework === 'pytest'
    ? { className: declaration.className, methodName: declaration.methodName, signature: declaration.signature }
    : { framework: declaration.framework, suitePath: declaration.suitePath, name: declaration.name };
}
function* commandForTestFileReplay(commands, file) {
  const depth = (command) => Math.max(...(command.affectedRoots ?? ['.']).map((entry) => (entry === '.' ? 0 : entry.split('/').length)));
  const covering = commands.filter((command) => testCommandCoversPath(command, file)).sort((left, right) => depth(right) - depth(left));
  if (covering.length < 2) return covering[0] ?? null;
  const text = yield witnessRequest('witness-command-source',{file});
  const browser = /(?:^|-)(?:playwright(?:-ct)?|cypress(?:-component)?)-tests$/u;
  const runner = /@playwright\/experimental-ct-/u.test(text) ? /(?:^|-)playwright-ct-tests$/u : /['"]@playwright\/test['"]/u.test(text) ? /(?:^|-)playwright-tests$/u
    : /(?:^|\/)cypress\/|\.cy\.[cm]?[jt]sx?$/u.test(file) ? (/component/u.test(file) ? /cypress-component-tests$/u : /(?:^|-)cypress-tests$/u) : null;
  return covering.find((command) => (runner ? runner.test(command.id) : !browser.test(command.id))) ?? covering[0];
}
function* discoverAcceptanceWitnessesReplay(phase, {
  testPaths, sourcePaths = [], requiredAcIds = [], bindings = [], othersTag = () => false,
  executionMode = 'changed-and-affected'
} = {}) {
  const commands = [];
  for (const [index, command] of (yield witnessRequest('witness-test-commands',{phase:{...phase,deliveryEvidence:{...(phase.deliveryEvidence??{}),sourcePaths,testPaths}},executionMode})).entries()) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || command.kind !== 'test') continue;
    try { commands.push({ ...normalizeExternalCommand(command, index), provenance: testCommandProvenance(phase, command) }); }
    catch { /* the test preflight reports it */ }
  }
  const taggedFiles = [...new Set(bindings.map((binding) => binding.testSource))].sort();
  const groups = new Map();
  const fileProfile = new Map();
  for (const file of taggedFiles) {
    const command = yield witnessRequest('witness-command-for-file',{commands,file});
    const profile = command ? profileForCommand(command) : 'module-counts-v1';
    fileProfile.set(file, { profile, commandId: command?.id ?? null, resultAdapter: command?.result?.adapter ?? null });
    const key = `${profile}\u0000${command?.id ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const witnesses = [];
  const unattachedTags = [];
  for (const [key, files] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [profile, commandId] = key.split('\u0000');
    if (!profileIsExact(profile)) {
      for (const binding of bindings.filter((entry) => files.includes(entry.testSource))) {
        witnesses.push({
          clauseId: binding.clauseId, testSource: binding.testSource, profile, commandId: commandId || null,
          resultAdapter: fileProfile.get(binding.testSource).resultAdapter, identity: null, logicalTestId: null,
          declarationSha256: null, supportSha256: null, line: null, parameters: null, skipped: false,
          exact: false, gaps: ['ADAPTER_COUNTS_ONLY']
        });
      }
      continue;
    }
    const discovered = yield witnessRequest('witness-declarations',{profile,files});
    for (const declaration of discovered.declarations) {
      for (const clauseId of declaration.clauseIds) {
        if (othersTag({ testSource: declaration.sourcePath, clauseId, line: declaration.line })) continue;
        witnesses.push({
          clauseId, testSource: declaration.sourcePath, profile, commandId: commandId || null,
          resultAdapter: testAdapterProfile(profile).resultAdapter,
          identity: witnessIdentity(declaration), logicalTestId: declaration.logicalTestId,
          declarationSha256: declaration.declarationSha256, supportSha256: declaration.supportSha256 ?? null,
          ...(declaration.assertions ? { assertions: declaration.assertions } : {}),
          line: declaration.line, parameters: declaration.parameters ?? null, skipped: declaration.skipped === true,
          exact: declaration.gaps.length === 0, gaps: declaration.gaps.map((entry) => entry.code)
        });
      }
    }
    for (const tag of discovered.unattachedTags) {
      const clauseIds = tag.clauseIds.filter((clauseId) => !othersTag({ testSource: tag.sourcePath, clauseId, line: tag.line }));
      if (clauseIds.length) unattachedTags.push({ testSource: tag.sourcePath, line: tag.line, clauseIds, code: tag.code, message: tag.message });
    }
    for (const [file, gaps] of Object.entries(discovered.fileGaps)) {
      if (!discovered.unattachedTags.some((tag) => tag.sourcePath === file)) {
        unattachedTags.push({ testSource: file, line: null, clauseIds: bindings.filter((entry) => entry.testSource === file).map((entry) => entry.clauseId), code: gaps[0].code, message: gaps[0].message });
      }
    }
  }
  const errors = [];
  const errorFindings = [];
  for (const clauseId of requiredAcIds) {
    const sources = bindings.filter((binding) => binding.clauseId === clauseId).map((binding) => binding.testSource);
    if (!sources.length || !sources.every((file) => profileIsExact(fileProfile.get(file)?.profile ?? 'module-counts-v1'))) continue;
    if (witnesses.some((witness) => witness.clauseId === clauseId && witness.identity)) continue;
    const where = unattachedTags.filter((tag) => tag.clauseIds.includes(clauseId))
      .map((tag) => `${tag.testSource}${tag.line ? `:${tag.line}` : ''} (${tag.message})`);
    errors.push(`@ac:${clauseId} is not on a test: ${where.join('; ') || sources.join(', ')}. Put the tag in a comment on the line directly above the test that verifies ${clauseId}.`);
    errorFindings.push({ code: 'code.delivery.acceptance-tag-unattached', value: clauseId });
  }
  return {
    witnesses: witnesses.sort((left, right) => left.clauseId.localeCompare(right.clauseId)
      || left.testSource.localeCompare(right.testSource) || (left.line ?? 0) - (right.line ?? 0)),
    unattachedTags,
    profiles: [...fileProfile.entries()].map(([testSource, entry]) => ({ testSource, ...entry,
      ceiling: testAdapterProfile(entry.profile).ceiling })),
    errors, errorFindings
  };
}
 return Object.freeze({discoverAcceptanceWitnessesReplay,commandForTestFileReplay});
}

/** Bound test evidence only; a passing path does not satisfy its whole verification contract. */
export const TEST_WITNESS_INSPECTION_PROFILE='sflow-test-witness-inspection/v1';
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const count=value=>Number.isSafeInteger(value)&&value>=0,id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value),
  sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value),opaque=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u0020\u007f]/u.test(value),
  reference=value=>exact(value,['namespace','sha256','bytes'])&&value.namespace==='evidence'&&sha(value.sha256)&&count(value.bytes),statuses=['met','missing','failed','inconclusive','pending'];
export function testWitnessInspectionManifest(workId,phaseId,facts,maximumEntries){
  const bad=()=>{throw new SingularityFlowError('The witness inspector returned another or unbounded evidence view.',{code:'ENGINE_PORT_RESULT_INVALID'});};
  if(!exact(facts,['workId','phase','revision','authorityVersion','configuration','draft','status','plan','source','checks','control','repositories','totals','paths','truncated','requiredPolicyOwners'])
    ||facts.workId!==workId||facts.phase!==phaseId||!opaque(facts.revision)||!opaque(facts.authorityVersion)
    ||!['missing-draft','stale-draft','not-code-generation','missing-source-evidence','observed','pending-owner'].includes(facts.status)
    ||!exact(facts.configuration,['key','content'])||!opaque(facts.configuration.key)||!exact(facts.configuration.content,['namespace','sha256','bytes'])
    ||facts.configuration.content.namespace!=='config'||!sha(facts.configuration.content.sha256)||!count(facts.configuration.content.bytes)
    ||!Array.isArray(facts.repositories)||facts.repositories.length>32||!Array.isArray(facts.paths)||facts.paths.length>maximumEntries
    ||!Array.isArray(facts.requiredPolicyOwners)||facts.requiredPolicyOwners.length>128||facts.requiredPolicyOwners.some(value=>!id(value))
    ||!exact(facts.totals,['paths','witnesses',...statuses])||Object.values(facts.totals).some(value=>!count(value))||typeof facts.truncated!=='boolean')bad();
  const draft=facts.draft;
  if(draft!==null&&(!exact(draft,['generation','revision','bodySha256','baseRevision'])||!count(draft.generation)||draft.generation<1||!opaque(draft.revision)||!sha(draft.bodySha256)||!opaque(draft.baseRevision)))bad();
  if(facts.status==='missing-draft'?draft!==null:draft===null)bad();
  if(facts.status==='stale-draft'?draft.baseRevision===facts.revision:draft!==null&&draft.baseRevision!==facts.revision)bad();
  for(const [kind,binding]of [['source',facts.source],['checks',facts.checks],['control',facts.control]])if(binding!==null){
    if(!exact(binding,['operationId','record','index'])||!id(binding.operationId)||!exact(binding.record,['key','version','content'])||!opaque(binding.record.key)||!opaque(binding.record.version)
      ||!reference(binding.record.content)||!exact(binding.index,['key','version'])||!opaque(binding.index.key)||!opaque(binding.index.version))bad();
    const prefix=kind==='checks'?'phase-checks':kind==='control'?'source-control':'source-retention';if(!binding.record.key.startsWith(prefix+'/')||!binding.index.key.startsWith(prefix+'/'))bad();
  }
  if(facts.plan!==null){const plan=facts.plan;
    if(!exact(plan,['phase','generation','publication','reviewPacket','planned','indices',...(Object.hasOwn(plan,'repositoryPlan')?['repositoryPlan']:[])])||!id(plan.phase)||!count(plan.generation)||plan.generation<1
      ||!['publication','reviewPacket','planned',...(plan.repositoryPlan?['repositoryPlan']:[])].every(key=>reference(plan[key]))||!Array.isArray(plan.indices)||plan.indices.length>4096)bad();
    for(const index of plan.indices)if(!exact(index,['phase','record'])||!id(index.phase)||!reference(index.record))bad();
  }
  const repositories=new Set();for(const row of facts.repositories){if(!exact(row,['id','sourceMatched','checksMatched'])||!id(row.id)||repositories.has(row.id)||typeof row.sourceMatched!=='boolean'
    ||row.checksMatched!==null&&typeof row.checksMatched!=='boolean'||(facts.checks===null)!==(row.checksMatched===null))bad();repositories.add(row.id);}
  let size=0,witnesses=0;const keys=new Set(),totals=Object.fromEntries(statuses.map(status=>[status,0]));let truncated=facts.paths.length<facts.totals.paths;
  for(const row of facts.paths){
    if(!exact(row,['repositoryId','clauseId','slot','role','testSource','profile','status','assurance','requiredAssurance','witnessCount','witnesses','truncated','gaps'])
      ||!repositories.has(row.repositoryId)||normalizeQualifiedClauseId(row.clauseId)!==row.clauseId||!id(row.slot)||!['primary','supporting'].includes(row.role)||!id(row.profile)
      ||!statuses.includes(row.status)||!ASSURANCE.includes(row.assurance)||!ASSURANCE.includes(row.requiredAssurance)||!count(row.witnessCount)||!Array.isArray(row.witnesses)
      ||row.witnesses.length>64||row.witnesses.length>row.witnessCount||row.truncated!==(row.witnesses.length<row.witnessCount)||!Array.isArray(row.gaps)||row.gaps.length>128
      ||row.gaps.some(value=>typeof value!=='string'||value.length>128))bad();
    sourceRelativePath(row.testSource);const key=[row.repositoryId,row.clauseId,row.slot,row.testSource].join('\0');if(keys.has(key))bad();keys.add(key);
    for(const witness of row.witnesses)if(!exact(witness,['logicalTestId','declarationSha256','line','outcome','status','assurance','identity','execution','requiredAssurance','attemptId','reasons'])
      ||witness.logicalTestId!==null&&!opaque(witness.logicalTestId)||witness.declarationSha256!==null&&!/^(?:sha256:)?[a-f0-9]{64}$/u.test(witness.declarationSha256)
      ||witness.line!==null&&(!count(witness.line)||witness.line<1)||!statuses.includes(witness.status)||!['passed','flaky','failed','unverified-skipped','missing','ambiguous','inconclusive','passed-with-skips','unavailable','not-run'].includes(witness.outcome)
      ||!ASSURANCE.includes(witness.assurance)||!['declared','source-bound'].includes(witness.identity)||!EXECUTION_ASSURANCE.includes(witness.execution)||!ASSURANCE.includes(witness.requiredAssurance)
      ||witness.attemptId!==null&&!opaque(witness.attemptId)||!Array.isArray(witness.reasons)||witness.reasons.length>128||witness.reasons.some(value=>typeof value!=='string'||value.length>128))bad();
    totals[row.status]++;witnesses+=row.witnessCount;truncated||=row.truncated;size+=new TextEncoder().encode(JSON.stringify(row)).byteLength;
  }
  if(size>65536||facts.truncated!==truncated||statuses.reduce((sum,key)=>sum+facts.totals[key],0)!==facts.totals.paths
    ||statuses.some(key=>totals[key]>facts.totals[key])||witnesses>facts.totals.witnesses||!truncated&&(witnesses!==facts.totals.witnesses||statuses.some(key=>totals[key]!==facts.totals[key])))bad();
  if(facts.status==='observed'&&(!facts.source||!facts.plan||!facts.repositories.length))bad();
  const actions=[],action=(operation,inputs,required=[],prerequisites=[])=>actions.push({operation,inputs,required,prerequisites});
  if(facts.status==='missing-draft')action('phase.prepare',{workId,phaseId});
  else if(facts.status==='stale-draft')action('phase.draft.rebase',{workId,phaseId,expectedRevision:draft.revision,confirm:draft.bodySha256},['operationId','reason']);
  else if(facts.status==='missing-source-evidence'||facts.repositories.some(row=>!row.sourceMatched))action('phase.source.retain',{workId,phaseId},['operationId']);
  if(facts.source&&(!facts.checks||facts.repositories.some(row=>row.checksMatched===false)))action('phase.checks.run',{workId,phaseId},['operationId']);
  if(facts.requiredPolicyOwners.includes('source-tag-origin'))action('phase.source-control.retain',{workId,phaseId},['operationId'],['origin-bound-source-control-reader','original-source-bytes-available']);
  if(facts.totals.failed||facts.totals.inconclusive||facts.totals.missing)action('phase.prepare',{workId,phaseId},[],['repair-observed-test-witness-gaps']);
  return {schemaVersion:1,contract:TEST_WITNESS_INSPECTION_PROFILE,...facts,actions,observationsOnly:true,testEvidenceOnly:true,
    verificationContractsCombined:false,publicationReadinessInspected:false,applicationAcceptanceEstablished:false};
}
