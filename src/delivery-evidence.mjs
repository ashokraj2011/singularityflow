import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import {
  inferModuleTestCommand, isAllowedTestAutomationPath, isExecutableTestSourcePath,
  isSupportingTestResourcePath, readDurableTestObservation, replayLocalJunitObservation,
  resolveAffectedModule, testReceiptPassing
} from './code-delivery-tests.mjs';
import {
  buildRepositoryChangeSet, buildRepositoryTreeChangeSet, evaluateSourceBoundary,
  verifyRepositoryChangeSetIntegrity
} from './repository-change-set.mjs';
import {
  autoCandidateResourceDigest, validateAutoCandidateBinding,
  validateAutoCandidateVerification
} from './auto/auto-candidate.mjs';
import { evaluateStoryProtectedPaths } from './configuration-materialization.mjs';
import { canonicalJson } from './records.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { readRecord } from './schema-migrations.mjs';
import { verifyJunit5SurefireIdentityObservation } from './wel-junit5.mjs';
import { loadActiveSpecRecords, predecessorSpecClauses } from './specifications.mjs';
import { SingularityFlowError, posix, run, secureRepositoryPath, snapshot } from './util.mjs';
import {
  applicationChangeSetProjection, applicationPathContext, isApplicationChangeEntry,
  isGeneratedOutputPath, verifyWorkIntervalBaseline
} from './work-intervals.mjs';

export { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

function pathInside(candidate, root) {
  const value = posix(candidate ?? '');
  const prefix = posix(root ?? '').replace(/\/$/, '');
  return Boolean(value && prefix && (value === prefix || value.startsWith(`${prefix}/`)));
}

/**
 * Describe what each changed path is for without pretending path names prove who authored bytes.
 * Explicit authorship/change-origin declarations live on the generation receipt; this projection
 * only supplies deterministic repository roles and clearly labels its path-policy inference.
 */
export function classifyDeliveryChanges(changeSet, {
  generatedRoots = [], declaredOrigins = [], pathContext = null
} = {}) {
  const roots = [...new Set(generatedRoots.map(posix).filter(Boolean))];
  const entries = (changeSet?.entries ?? [])
    .filter((entry) => isApplicationChangeEntry(entry, pathContext)).map((entry) => {
    const candidate = entry.newPath ?? entry.oldPath;
    const configuredGenerated = roots.some((root) => pathInside(candidate, root));
    const testOutput = /(?:^|\/)(?:\.sflow\/results|coverage|test-results|surefire-reports)(?:\/|$)/i.test(candidate ?? '');
    const compilerOutput = /(?:^|\/)(?:target|build|dist|out)(?:\/(?:classes|generated|resources))?(?:\/|$)/i.test(candidate ?? '');
    const migration = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/i.test(candidate ?? '');
    const test = isAllowedTestAutomationPath(candidate ?? '');
    const tooling = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i.test(candidate ?? '');
    const generated = configuredGenerated || isGeneratedOutputPath(candidate ?? '');
    const role = configuredGenerated ? 'generated-source'
      : testOutput ? 'test-output'
        : compilerOutput ? 'compiler-output'
          : migration ? 'migration'
            : test ? 'test-source'
              : tooling ? 'build-configuration'
                : generated ? 'generated-output' : 'product-source';
    const likelyOrigin = configuredGenerated ? 'code-generator'
      : testOutput ? 'test-runner'
        : compilerOutput ? 'compiler'
          : migration ? 'migration-tool-or-human'
            : 'authorship-declared';
    return {
      changeId: entry.changeId, status: entry.status,
      oldPath: entry.oldPath, newPath: entry.newPath,
      role, generated, likelyOrigin, inference: 'path-policy'
    };
  });
  const counts = Object.fromEntries([...new Set(entries.map((entry) => entry.role))]
    .sort().map((role) => [role, entries.filter((entry) => entry.role === role).length]));
  return {
    schemaVersion: 1, inference: 'path-policy', declaredOrigins: [...declaredOrigins],
    generatedRoots: roots, counts, entries
  };
}

function legacySpecificationText(text) {
  return text
    .replace(/<!-- singularity-flow:metadata[\s\S]*?-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(```|~~~)[^\r\n]*[\r\n][\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/`[^`\r\n]+`/g, '');
}

export async function acceptanceIds(root, config, workflow, phase) {
  if (!config.governance?.requireAcceptanceCriteriaTags) return [];
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const indexed = predecessorSpecClauses(records, workflow, phase.id)
    .filter((clause) => clause.type === 'AC' || /:AC-\d+$/.test(clause.id ?? ''))
    .map((clause) => clause.id);
  if (indexed.length) return [...new Set(indexed)].sort();
  // Compatibility for workflows created before specification indexes existed. New records always
  // preserve the namespace; a legacy bare suffix is normalized only when a configured namespace
  // makes the identity unambiguous.
  const namespace = (workflow.resolution?.spec ?? config.spec)?.namespace ?? null;
  const position = workflow.phaseOrder.indexOf(phase.id);
  const ids = new Set();
  for (const phaseId of workflow.phaseOrder.slice(0, Math.max(0, position))) {
    const prior = workflow.phases[phaseId];
    if (!prior?.requiredArtifact?.path) continue;
    const relative = posix(path.join(
      config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
      prior.requiredArtifact.path
    ));
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Acceptance specification source', type: 'file'
    });
    if (!secured.exists) continue;
    const text = legacySpecificationText(await readFile(secured.absolute, 'utf8'));
    for (const match of text.matchAll(/\b(?:[A-Z0-9][A-Z0-9._-]{0,63}:)?AC-\d+\b/gi)) {
      const value = match[0].toUpperCase();
      ids.add(value.includes(':') ? value : namespace ? `${namespace}:${value}` : value);
    }
  }
  return [...ids].sort();
}

export async function taggedAcceptanceIds(root, testPaths, requiredIds = [], {
  requireNamespaceQualifiedIds = false
} = {}) {
  const exact = new Set();
  const bare = new Set();
  const exactSources = new Map();
  const bareSources = new Map();
  for (const relative of testPaths) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Acceptance test source', type: 'file'
    });
    if (!secured.exists) continue;
    const text = await readFile(secured.absolute, 'utf8');
    for (const match of text.matchAll(/@ac:\s*((?:[A-Z0-9][A-Z0-9._-]{0,63}:)?AC-\d+)/gi)) {
      const value = match[1].toUpperCase();
      const target = value.includes(':') ? exact : bare;
      const sources = value.includes(':') ? exactSources : bareSources;
      target.add(value);
      if (!sources.has(value)) sources.set(value, new Set());
      sources.get(value).add(relative);
    }
  }
  const ambiguous = [];
  const inferred = [];
  const bindings = [];
  for (const clauseId of exact) {
    const suffix = clauseId.slice(clauseId.lastIndexOf(':') + 1);
    const legacyBareMatches = requiredIds.filter((id) => id === suffix);
    const competingQualifiedTags = [...exact].filter((id) => id.endsWith(`:${suffix}`));
    // Some pre-index Stories persist an intrinsically bare AC identity even though their tests
    // already use a namespace-qualified tag. Preserve the stronger test identity and bind it to
    // the one bare durable clause only when there is no competing namespace. This is not suffix
    // guessing: one competing qualified tag makes the binding ambiguous and blocks delivery.
    if (!requiredIds.includes(clauseId) && legacyBareMatches.length === 1) {
      if (competingQualifiedTags.length > 1) {
        ambiguous.push({ suffix, matches: competingQualifiedTags, reason: 'legacy-clause-ambiguous' });
        continue;
      }
      inferred.push(legacyBareMatches[0]);
      for (const testSource of exactSources.get(clauseId) ?? []) {
        bindings.push({
          clauseId: legacyBareMatches[0], testSource,
          bindingAssurance: 'namespace-qualified-legacy-clause', tag: clauseId
        });
      }
      continue;
    }
    for (const testSource of exactSources.get(clauseId) ?? []) {
      bindings.push({ clauseId, testSource, bindingAssurance: 'namespace-qualified' });
    }
  }
  for (const suffix of bare) {
    const matches = requiredIds.filter((id) => id === suffix || id.endsWith(`:${suffix}`));
    const namespacedMatches = matches.filter((id) => id.includes(':'));
    // Installed Stories created before specification indexes may legitimately have only a bare
    // clause identity. Namespace enforcement cannot invent a namespace for those records; it
    // becomes mandatory as soon as the pinned specification supplies one. This keeps the new
    // policy strict for modern records without making legacy, intrinsically bare identities
    // impossible to satisfy.
    if (requireNamespaceQualifiedIds && namespacedMatches.length) {
      ambiguous.push({ suffix, matches, reason: 'namespace-required' });
      continue;
    }
    if (matches.length === 1) {
      inferred.push(matches[0]);
      for (const testSource of bareSources.get(suffix) ?? []) {
        bindings.push({
          clauseId: matches[0], testSource,
          bindingAssurance: requireNamespaceQualifiedIds ? 'namespace-not-applicable' : 'legacy-inferred'
        });
      }
    }
    else if (matches.length > 1) ambiguous.push({ suffix, matches });
    else {
      exact.add(suffix);
      for (const testSource of bareSources.get(suffix) ?? []) {
        bindings.push({ clauseId: suffix, testSource, bindingAssurance: 'legacy-unresolved' });
      }
    }
  }
  return {
    ids: [...new Set([...exact, ...inferred])].sort(), inferred: inferred.sort(), ambiguous,
    bindings: bindings.sort((left, right) => left.clauseId.localeCompare(right.clauseId) || left.testSource.localeCompare(right.testSource))
  };
}

async function pathEvidence(root, paths, { changeSet = null } = {}) {
  const records = [];
  for (const relative of paths) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Delivery evidence path', allowFinalSymlink: true
    });
    const absolute = secured.absolute;
    const info = secured.entry;
    const current = info?.isSymbolicLink()
      ? { exists: true, size: info.size, sha256: null }
      : await snapshot(absolute);
    const endpoint = changeSet?.entries?.find((entry) => entry.newPath === relative || entry.oldPath === relative) ?? null;
    const gitlink = endpoint?.newPath === relative && endpoint?.newMode === '160000';
    const removed = !current.exists && endpoint?.oldPath === relative && endpoint?.oldObject;
    const baselineKind = endpoint?.oldMode === '160000' ? 'gitlink' : 'blob';
    const baselineVerified = removed
      ? run('git', ['cat-file', '-e', `${endpoint.oldObject}^{${baselineKind === 'gitlink' ? 'commit' : 'blob'}}`], {
        cwd: root, allowFailure: true
      }).status === 0
      : false;
    records.push({
      path: relative,
      kind: isAllowedTestAutomationPath(relative) ? 'test' : 'source',
      fileKind: gitlink ? 'gitlink' : !info ? 'missing' : info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'regular-file' : 'non-regular',
      exists: gitlink || current.exists,
      size: gitlink ? null : current.size,
      sha256: gitlink ? endpoint.newObject : current.sha256,
      ...(removed ? {
        verifiedAbsence: baselineVerified,
        baseline: { object: endpoint.oldObject, mode: endpoint.oldMode, kind: baselineKind }
      } : {}),
      ...(gitlink ? { gitlink: { commit: endpoint.newObject, mode: endpoint.newMode } } : {})
    });
  }
  return records;
}

async function validatedReusablePaths(root, candidates, priorEvidence, { role, sourceExtensions = [] }) {
  const prior = new Map((priorEvidence ?? []).map((record) => [record.path, record]));
  const current = await pathEvidence(root, candidates);
  const valid = [];
  for (const record of current) {
    const previous = prior.get(record.path);
    if (role === 'source' && record.fileKind === 'missing' && previous?.fileKind === 'missing'
      && previous.verifiedAbsence === true && previous.baseline?.object) {
      const kind = previous.baseline.kind === 'gitlink' ? 'commit' : 'blob';
      const available = run('git', ['cat-file', '-e', `${previous.baseline.object}^{${kind}}`], {
        cwd: root, allowFailure: true
      }).status === 0;
      if (available) { valid.push(record.path); continue; }
    }
    if (role === 'source' && record.fileKind === 'gitlink' && previous?.fileKind === 'gitlink'
      && record.sha256 === previous.sha256) {
      valid.push(record.path); continue;
    }
    const executable = role !== 'test' || await isExecutableTestSourcePath(root, record.path, { sourceExtensions });
    if (!previous || previous.fileKind !== 'regular-file' || record.fileKind !== 'regular-file'
        || !previous.sha256 || previous.sha256 !== record.sha256 || !executable) {
      throw new SingularityFlowError(
        `Previously governed ${role} path '${record.path}' is missing, replaced, symbolic, no longer executable, or differs from its prior evidence. Change or restore it in the current generation.`,
        { code: 'CODE_DELIVERY_REUSE_INVALID' }
      );
    }
    valid.push(record.path);
  }
  return valid;
}

/** Refuse a code phase before generation state or telemetry is mutated. */
export async function evaluateCodeDeliveryPreflight(root, config, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase)) return null;
  if ((phase.writeScope ?? 'artifact-only') !== 'source-and-artifact') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' is a code-generation phase but its write scope does not permit source changes.`,
      { code: 'CODE_DELIVERY_SCOPE_INVALID' }
    );
  }

  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  await verifyWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory });
  const baselineCommit = phase.generationIntent?.baseline?.commit
    ?? workflow.workIntervals.current.sourceBaseCommit;
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: baselineCommit,
    subject: {
      workId: workflow.workItem.id, phase: phase.id, generation: phase.generation + 1,
      generationIntentId: phase.generationIntent?.id ?? null
    }
  });
  const guards = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const protectedResult = evaluateStoryProtectedPaths(changeSet, guards, workflow);
  if (!protectedResult.valid) {
    throw new SingularityFlowError(
      `Generation cannot modify protected process paths: ${protectedResult.violations.map((entry) => `${entry.endpoint} ${entry.path}`).join(', ')}`,
      { code: 'CHANGE_SET_POLICY_VIOLATION' }
    );
  }
  const pathContext = applicationPathContext(config, workflow);
  const applicationEntries = changeSet.entries
    .filter((entry) => isApplicationChangeEntry(entry, pathContext));
  const applicationChangeSet = { ...changeSet, entries: applicationEntries };
  const boundaryResult = evaluateSourceBoundary(applicationChangeSet, phase.sourceBoundary, {
    phaseId: phase.id, allowedPath: isAllowedTestAutomationPath
  });
  if (!boundaryResult.valid) {
    throw new SingularityFlowError(
      `Phase ${phase.id} may change test automation only; product-source endpoints are outside its governed boundary: ${boundaryResult.violations.map((entry) => entry.path).join(', ')}`,
      { code: 'CHANGE_SET_POLICY_VIOLATION' }
    );
  }
  const currentPaths = applicationEntries
    .filter((entry) => entry.status !== 'deleted' && entry.newPath
      && (entry.newContent?.kind === 'regular-file' || entry.newMode === '160000'))
    .map((entry) => entry.newPath);
  const changedPaths = [...new Set(currentPaths)].sort();
  const changedEndpointPaths = new Set(applicationEntries.flatMap((entry) =>
    [entry.oldPath, entry.newPath].filter(Boolean)));
  const changedTestCandidates = changedPaths.filter(isAllowedTestAutomationPath);
  const sourceExtensions = [...new Set((phase.qualityCommands ?? []).flatMap((command, index) => {
    try { return normalizeExternalCommand(command, index).result?.sourceExtensions ?? []; }
    catch { return []; }
  }))];
  const changedTestPaths = [];
  const supportingTestPaths = [];
  for (const candidate of changedTestCandidates) {
    if (await isExecutableTestSourcePath(root, candidate, { sourceExtensions })) changedTestPaths.push(candidate);
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
  // paths from the prior receipt; first generations still have to introduce/change their tests.
  const reusableTestCandidates = Number(phase.generation ?? 0) > 0
    ? (phase.deliveryEvidence?.testPaths ?? []).filter((candidate) => !changedEndpointPaths.has(candidate))
    : [];
  const reusableTestPaths = await validatedReusablePaths(
    root, reusableTestCandidates, phase.deliveryEvidence?.paths, { role: 'test', sourceExtensions }
  );
  const testPaths = [...new Set([...changedTestPaths, ...reusableTestPaths])].sort();
  const deletedSourcePaths = applicationEntries
    .filter((entry) => entry.oldPath && entry.oldPath !== entry.newPath
      && !isAllowedTestAutomationPath(entry.oldPath))
    .map((entry) => entry.oldPath);
  const changedSourcePaths = [...new Set([
    ...changedPaths.filter((candidate) => !isAllowedTestAutomationPath(candidate)),
    ...deletedSourcePaths
  ])].sort();
  const reusableSourceCandidates = intentRevalidation
    ? (phase.deliveryEvidence?.sourcePaths ?? []).filter((candidate) => !changedEndpointPaths.has(candidate))
    : [];
  const reusableSourcePaths = await validatedReusablePaths(
    root, reusableSourceCandidates, phase.deliveryEvidence?.paths, { role: 'source' }
  );
  const sourcePaths = [...new Set([...changedSourcePaths, ...reusableSourcePaths])].sort();
  const errors = [];

  if (!applicationEntries.length && !intentRevalidation) {
    errors.push('no application source or test paths changed during the governed work interval');
  }
  if (phase.sourceBoundary !== 'test-automation' && !sourcePaths.length) {
    errors.push('no product source path changed; a summary or test-only edit is not an implementation');
  }
  if (!testPaths.length) errors.push('no acceptance test is available for the implementation');

  const requiredAcIds = await acceptanceIds(root, config, workflow, phase);
  const tags = await taggedAcceptanceIds(root, testPaths, requiredAcIds, {
    requireNamespaceQualifiedIds: workflow.resolution?.codeDelivery?.traceability?.requireNamespaceQualifiedIds === true
  });
  if (tags.ambiguous.length) {
    const namespaceRequired = tags.ambiguous.some((item) => item.reason === 'namespace-required');
    throw new SingularityFlowError(
      namespaceRequired
        ? `Acceptance tags must be namespace-qualified: ${tags.ambiguous.map((item) => item.suffix).join(', ')}`
        : `Bare acceptance tag is ambiguous: ${tags.ambiguous.map((item) => `${item.suffix} -> ${item.matches.join(', ')}`).join('; ')}`,
      { code: namespaceRequired ? 'AC_NAMESPACE_REQUIRED' : 'AC_NAMESPACE_AMBIGUOUS' }
    );
  }
  const taggedAcIds = tags.ids;
  const missingAcIds = requiredAcIds.filter((id) => !taggedAcIds.includes(id));
  if (missingAcIds.length) {
    errors.push(`changed tests do not contain required traceability tags: ${missingAcIds.map((id) => `@ac:${id}`).join(', ')}`);
  }
  if (errors.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} has no publishable code delivery:\n- ${errors.join('\n- ')}\n`
      + 'Implement the approved behavior, add acceptance-mapped tests, and publish again.',
      { code: 'CODE_DELIVERY_EVIDENCE_REQUIRED' }
    );
  }

  return {
    requirement: 'source-and-tests',
    baselineCommit,
    generationIntentId: phase.generationIntent?.id ?? null,
    changeSet,
    changeClassification: classifyDeliveryChanges(changeSet, {
      generatedRoots: workflow.resolution?.ast?.generatedRoots ?? config.ast?.generatedRoots ?? [],
      pathContext
    }),
    paths: await pathEvidence(root, [...new Set([
      ...changedPaths, ...deletedSourcePaths, ...reusableSourcePaths, ...reusableTestPaths
    ])].sort(), { changeSet }),
    sourcePaths,
    deletedSourcePaths: [...new Set(deletedSourcePaths)].sort(),
    testPaths,
    supportingTestPaths,
    intentRevalidation: intentRevalidation ? phase.intentAmendmentRevalidation.id : null,
    acceptanceCriteria: {
      required: requiredAcIds, tagged: taggedAcIds, missing: [], ambiguous: [],
      inferred: tags.inferred, bindings: tags.bindings
    }
  };
}

function commandText(command) {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.join(' ');
  if (Array.isArray(command?.argv)) return command.argv.join(' ');
  return String(command?.command ?? '');
}

function commandTokens(command) {
  if (Array.isArray(command)) return command.map(String);
  if (Array.isArray(command?.argv)) return command.argv.map(String);
  return commandText(command).trim().split(/\s+/).filter(Boolean);
}

function executableName(value) {
  return path.basename(String(value ?? '')).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
}

/** A code receipt must execute tests; lint/compile/diff commands alone are not sufficient. */
export function isTestQualityCommand(command) {
  if (command && typeof command === 'object' && !Array.isArray(command) && command.kind != null) {
    return command.kind === 'test';
  }
  const [rawExecutable, ...rawArguments] = commandTokens(command);
  const executable = executableName(rawExecutable);
  const args = rawArguments.map((argument) => argument.toLowerCase());
  const hasTask = (names) => args.some((argument) => names.has(argument.replace(/^.*:/, '')));

  if (['mvn', 'mvnw'].includes(executable)) return hasTask(new Set(['test', 'verify', 'integration-test']));
  if (['gradle', 'gradlew'].includes(executable)) return hasTask(new Set(['test', 'check']));
  if (['go', 'cargo', 'dotnet', 'swift'].includes(executable)) return args[0] === 'test';
  if (['pytest', 'jest', 'vitest', 'mocha'].includes(executable)) return true;
  if (['python', 'python3', 'py'].includes(executable)) {
    return args.some((argument, index) => argument === '-m' && ['pytest', 'unittest'].includes(args[index + 1]));
  }
  if (executable === 'node') return args.some((argument) => argument === '--test' || argument.startsWith('--test='));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (args[0] === 'test') return true;
    const script = args[0] === 'run' ? args[1] : args[0];
    return /(^|[:_-])(test|tests|acceptance|e2e|integration|unit)(?:$|[:_.-])/.test(script ?? '');
  }
  if (['npx', 'pnpx', 'yarnx', 'bunx'].includes(executable)) {
    const packageIndex = args.findIndex((argument) => !argument.startsWith('-'));
    const runner = executableName(args[packageIndex]);
    const runnerArgs = args.slice(packageIndex + 1);
    if (['jest', 'vitest', 'mocha'].includes(runner)) return true;
    if (runner === 'playwright') return runnerArgs.includes('test');
  }
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    return /(^|[._-])(test|tests|acceptance|e2e)(?:[._-]|$)/.test(executableName(args[0]));
  }
  return /(^|[._-])(test|tests|acceptance|e2e)(?:[._-]|$)/.test(executable);
}

/** Repository-native, deterministic defaults. No model is needed to identify a build manifest. */
export async function inferRepositoryTestCommands(root) {
  const regular = async (relative) => (await secureRepositoryPath(root, relative, {
    label: 'Repository test manifest', type: 'file'
  })).exists;
  const inferred = async (system, manifest) => {
    const command = await inferModuleTestCommand(root, { root: '.', system, manifest });
    const legacyRootIds = {
      maven: 'maven-tests', gradle: 'gradle-tests', go: 'go-tests', rust: 'cargo-tests',
      python: 'python-tests', node: 'node-tests'
    };
    return command ? [{ ...command, id: legacyRootIds[system] ?? command.id }] : [];
  };
  if (await regular('mvnw') || await regular('pom.xml')) return inferred('maven', 'pom.xml');
  if (await regular('gradlew') || await regular('build.gradle') || await regular('build.gradle.kts')) {
    return inferred('gradle', await regular('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle');
  }
  if (await regular('go.mod')) return inferred('go', 'go.mod');
  if (await regular('Cargo.toml')) return inferred('rust', 'Cargo.toml');
  if (await regular('pyproject.toml') || await regular('pytest.ini')) {
    return inferred('python', await regular('pyproject.toml') ? 'pyproject.toml' : 'pytest.ini');
  }
  if (await regular('package.json')) {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const script = String(manifest.scripts?.test ?? '').trim();
    if (script && !/no test specified/i.test(script)) return inferred('node', 'package.json');
  }
  return [];
}

export async function resolveDeliveryQualityCommands(root, phase) {
  const configured = [...(phase.qualityCommands ?? [])];
  if (!phaseRequiresCodeDelivery(phase)) return configured;
  const inferred = [];
  const deliveryPaths = [...new Set([
    ...(phase.deliveryEvidence?.sourcePaths ?? []),
    ...(phase.deliveryEvidence?.testPaths ?? [])
  ])];
  const modules = new Map();
  for (const candidate of deliveryPaths) {
    const module = await resolveAffectedModule(root, candidate).catch((error) => {
      if (error?.code === 'TEST_MODULE_UNCOVERED') return null;
      throw error;
    });
    if (module) modules.set(`${module.root}:${module.system}`, module);
  }
  for (const module of modules.values()) {
    const command = await inferModuleTestCommand(root, module);
    if (command) inferred.push(command);
  }
  if (!inferred.length) inferred.push(...await inferRepositoryTestCommands(root));
  if (!inferred.length) {
    const tests = phase.deliveryEvidence?.testPaths ?? [];
    if (tests.length && tests.every((candidate) => /\.(?:c|m)?js$/i.test(candidate))) {
      inferred.push({
        id: 'node-tests', kind: 'test',
        argv: ['node', '--test', '--test-reporter=junit', ...tests],
        workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: '.sflow/results/node-tests.xml', minimumDiscovered: 1 }
      });
    }
  }
  const seen = new Set(configured.map(commandText));
  return [...configured, ...inferred.filter((command) => command && !seen.has(commandText(command)))];
}

function receiptDigest(record) {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

function pathCoveredByRoots(candidate, roots = []) {
  return roots.some((root) => root === '.' || candidate === root
    || candidate.startsWith(`${root.replace(/\/$/, '')}/`));
}

function safeEvidencePath(value) {
  const candidate = String(value ?? '');
  return candidate && !path.posix.isAbsolute(candidate) && !candidate.includes('\\')
    && !candidate.includes(':') && !candidate.includes('\0')
    && !candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

const MODEL_ASSURANCE_RANK = Object.freeze({
  unavailable: 0, 'host-observed': 1, 'provider-reported': 2, 'policy-selected': 3
});
function modelAssuranceRank(value) {
  return MODEL_ASSURANCE_RANK[value === 'observed' ? 'host-observed' : value] ?? -1;
}

/**
 * Re-verify the durable code-delivery receipt without consulting current source bytes.
 * Source policy is replayed from the change set committed with the generation; test receipts are
 * hash-bound by the ready receipt written at submission.
 */
export async function verifyCodeDeliveryReceipt(root, receipt, {
  protectedPaths = [],
  configurationSource = null,
  sourceBoundary = 'unrestricted',
  symlinkPolicy = 'reject',
  minimumDiscovered = 1,
  minimumPassed = 1,
  requireAffectedModuleCoverage = true,
  minimumModelAssurance = 'unavailable',
  evidenceCommit = null,
  pathContext = null
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!receipt || receipt.kind !== 'code-delivery' || Number(receipt.schemaVersion) !== 2) {
    return { valid: false, errors: ['code-delivery v2 receipt is unavailable'] };
  }
  if (receipt.status !== 'ready') fail(`code-delivery receipt is ${receipt.status ?? 'unavailable'}`);

  const generationCommit = receipt.tree?.generationCommit;
  if (!generationCommit) fail('generation commit is absent');
  else {
    const tree = run('git', ['rev-parse', '--verify', `${generationCommit}^{tree}`], { cwd: root, allowFailure: true });
    if (tree.status !== 0) fail(`generation commit ${generationCommit} is unavailable`);
    else if (tree.stdout.trim() !== receipt.tree?.generationTree) fail('generation tree differs from the committed generation');
  }

  let changeSet = null;
  if (!generationCommit || !receipt.changeSet?.path) fail('committed repository change set is absent');
  else {
    const historical = run('git', ['show', `${generationCommit}:${receipt.changeSet.path}`], { cwd: root, allowFailure: true });
    if (historical.status !== 0) fail('repository change set was not committed with the generation');
    else {
      try { changeSet = readRecord('repository-change-set', historical.stdout).record; }
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
        const candidate = validateAutoCandidateBinding(receipt.autoCandidate);
        const verification = validateAutoCandidateVerification(
          receipt.autoCandidateVerification
        );
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
          const publishedCandidate = applicationChangeSetProjection(buildRepositoryTreeChangeSet(root, {
            baseTree: candidate.repository.baselineTree,
            targetTree: receipt.tree.generationTree,
            subject: { kind: 'auto-candidate', id: candidate.attemptId }
          }), pathContext);
          const publishedResourceDigest = autoCandidateResourceDigest(publishedCandidate, {
            baselineTree: candidate.repository.baselineTree,
            candidateSha256: candidate.candidateSha256
          });
          if (publishedResourceDigest !== candidate.applicationResourceDigest) {
            fail('Auto Candidate resource delta differs from the published generation tree');
          }
        }
      } catch (error) {
        fail(`Auto Candidate binding is invalid: ${error.message}`);
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

  const executions = new Map();
  for (const execution of receipt.testExecutions ?? []) {
    let testReceipt;
    try {
      const source = evidenceCommit
        ? run('git', ['show', `${evidenceCommit}:${execution.receiptPath}`], {
          cwd: root, allowFailure: true, encoding: 'buffer'
        })
        : null;
      if (source && source.status !== 0) throw new Error(`not present in evidence commit ${evidenceCommit}`);
      const storedBytes = source
        ? source.stdout
        : await readDurableTestObservation(root, execution.receiptPath);
      const storedRecord = JSON.parse(Buffer.isBuffer(storedBytes) ? storedBytes.toString('utf8') : storedBytes);
      // The binding was created over the version that was actually stored. Verify those raw
      // canonical bytes before applying an additive schema migration; hashing the migrated shape
      // would make every valid historical v1 receipt appear tampered after v2 ships.
      if (receiptDigest(storedRecord) !== String(execution.receiptSha256 ?? '').replace(/^sha256:/, '')) {
        fail(`test receipt ${execution.commandId} differs from its bound digest`);
      }
      testReceipt = readRecord('test-execution', storedRecord).record;
    }
    catch (error) {
      fail(`test receipt ${execution.commandId} is unavailable: ${error.message}`);
      continue;
    }
    const observation = testReceipt.testcaseObservation;
    if (observation?.status === 'observed') {
      if (testReceipt.assurance !== 'module-executed' || testReceipt.testcaseExecutionProven !== false) {
        fail(`test receipt ${execution.commandId} does not preserve module execution as its sole authority`);
      }
      if (observation.assurance !== 'testcase-local-observed') {
        fail(`test receipt ${execution.commandId} overstates its local observation assurance`);
      }
      if (![true, false].includes(observation.exact) || observation.verdict !== 'inconclusive') {
        fail(`test receipt ${execution.commandId} presents a local observation with an invalid exactness or verdict`);
      }
      if (testReceipt.candidate != null || testReceipt.program != null || testReceipt.attempt != null) {
        fail(`test receipt ${execution.commandId} invents unavailable Candidate, Program, or attempt authority`);
      }
      const requiredBindingGaps = [
        'sgos-candidate-unavailable',
        'gvm-program-unavailable',
        'durable-attempt-id-and-nonce-unavailable',
        ...(observation.exact === true ? [] : ['exact-static-test-identity-unavailable']),
        'reviewed-witness-mapping-unavailable'
      ];
      if (!requiredBindingGaps.every((gap) => observation.bindingGaps?.includes(gap))) {
        fail(`test receipt ${execution.commandId} does not disclose its unavailable exact bindings`);
      }
      if (testReceipt.adapter !== 'junit-xml'
          || observation.profile !== 'junit5-surefire-v1'
          || testReceipt.adapterIdentity?.id !== observation.profile) {
        fail(`test receipt ${execution.commandId} local JUnit profile binding is inconsistent`);
      }
      const localExecution = testReceipt.localExecution;
      const startedAt = Date.parse(localExecution?.startedAt ?? '');
      const completedAt = Date.parse(localExecution?.completedAt ?? '');
      const observedCommit = localExecution?.sourceCommit;
      const observedCommitExists = observedCommit
        ? run('git', ['rev-parse', '--verify', `${observedCommit}^{commit}`], {
          cwd: root, allowFailure: true
        }).status === 0
        : false;
      const followsGeneration = observedCommitExists && generationCommit
        ? run('git', ['merge-base', '--is-ancestor', generationCommit, observedCommit], {
          cwd: root, allowFailure: true
        }).status === 0
        : false;
      if (!followsGeneration
          || localExecution?.sourceTreeSha256 !== receipt.tree?.workingStateDigest
          || !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
        fail(`test receipt ${execution.commandId} local execution context is not bound to the retained generation`);
      }
      let exactReplay = null;
      if (observation.exact === true) {
        exactReplay = await verifyJunit5SurefireIdentityObservation(root, observation, {
          evidenceCommit
        });
        for (const error of exactReplay.errors) fail(`test receipt ${execution.commandId} ${error}`);
      } else if ((observation.occurrences ?? []).some((occurrence) => occurrence.exact !== false
          || occurrence.verdict !== 'inconclusive'
          || occurrence.logicalTestId != null
          || occurrence.declarationSha256 != null)) {
        fail(`test receipt ${execution.commandId} overstates a name-only JUnit occurrence`);
      }
      if (!observation.rawReports?.length) {
        fail(`test receipt ${execution.commandId} has no durable raw report evidence`);
      }
      const replayReports = [];
      const referencedPaths = new Set();
      let replayable = true;
      for (const report of observation.rawReports ?? []) {
        const contentAddressedPath = typeof report.path === 'string'
          && report.path.includes('/context/code-delivery/tests/raw/')
          && report.path.endsWith(`/${report.sha256}.xml`);
        if (!safeEvidencePath(report.path) || !contentAddressedPath
            || !/^[0-9a-f]{64}$/.test(report.sha256 ?? '')
            || !Number.isInteger(report.bytes) || report.bytes < 0) {
          fail(`test receipt ${execution.commandId} contains an invalid raw report reference`);
          replayable = false;
          continue;
        }
        if (referencedPaths.has(report.path)) {
          fail(`test receipt ${execution.commandId} repeats a raw report reference`);
          replayable = false;
          continue;
        }
        referencedPaths.add(report.path);
        try {
          let bytes;
          if (evidenceCommit) {
            const raw = run('git', ['show', `${evidenceCommit}:${report.path}`], {
              cwd: root, allowFailure: true, encoding: 'buffer'
            });
            if (raw.status !== 0) throw new Error(`not present in evidence commit ${evidenceCommit}`);
            bytes = raw.stdout;
          } else {
            bytes = await readDurableTestObservation(root, report.path, {
              expectedSha256: report.sha256,
              expectedBytes: report.bytes
            });
          }
          if (createHash('sha256').update(bytes).digest('hex') !== report.sha256
              || (Number.isInteger(report.bytes) && bytes.length !== report.bytes)) {
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
      if (replayable && replayReports.length === observation.rawReports?.length) {
        try {
          const replay = replayLocalJunitObservation(replayReports);
          if (canonicalJson(replay.tests) !== canonicalJson(testReceipt.tests)) {
            fail(`test receipt ${execution.commandId} module counts do not replay from its raw reports`);
          }
          const expectedRawOccurrences = exactReplay?.rawOccurrences ?? observation.occurrences ?? [];
          const parserMatches = observation.exact === true
            ? observation.parser?.id === 'jdk-compiler-tree-api'
            : canonicalJson(replay.testcaseObservation.parser) === canonicalJson(observation.parser);
          if (!parserMatches
              || canonicalJson(replay.testcaseObservation.occurrences)
                !== canonicalJson(expectedRawOccurrences)) {
            fail(`test receipt ${execution.commandId} normalized testcase observation does not replay`);
          }
          if (replay.result.sha256 !== testReceipt.result?.sha256
              || replay.result.bytes !== testReceipt.result?.bytes) {
            fail(`test receipt ${execution.commandId} aggregate result binding does not replay`);
          }
          const storedFiles = testReceipt.result?.files ?? [];
          if (storedFiles.length !== replay.result.files.length
              || storedFiles.some((file, index) => !safeEvidencePath(file.sourcePath)
                || file.sha256 !== replay.result.files[index].sha256
                || file.bytes !== replay.result.files[index].bytes)) {
            fail(`test receipt ${execution.commandId} report-set binding does not replay`);
          }
        } catch (error) {
          fail(`test receipt ${execution.commandId} raw report replay failed: ${error.message}`);
        }
      }
    } else if (observation && (observation.assurance !== 'unavailable'
        || !['unavailable', 'unsupported'].includes(observation.status))) {
      fail(`test receipt ${execution.commandId} contains an unsupported testcase assurance claim`);
    }
    if (!testReceiptPassing(testReceipt, minimumDiscovered, minimumPassed)) fail(`test receipt ${execution.commandId} is not passing`);
    executions.set(execution.commandId, testReceipt);
  }
  if (!executions.size) fail('no passing test-execution receipt is bound');
  for (const binding of bindings) {
    const execution = executions.get(binding.commandId);
    if (!execution || !pathCoveredByRoots(binding.testSource, execution.affectedRoots)) {
      fail(`acceptance clause ${binding.clauseId} is not covered by its bound test command`);
    }
  }
  if (requireAffectedModuleCoverage) {
    for (const sourcePath of receipt.changeSet?.sourcePaths ?? []) {
      if (![...executions.values()].some((execution) => pathCoveredByRoots(sourcePath, execution.affectedRoots))) {
        fail(`affected source path ${sourcePath} has no passing module test receipt`);
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
