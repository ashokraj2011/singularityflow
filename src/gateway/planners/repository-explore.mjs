/**
 * Deterministic, bounded repository orientation for the golden journey.
 *
 * This planner deliberately returns repository shape rather than source bodies. A developer can
 * learn where the application starts, how it is built, and which files are structurally central
 * without placing a repository dump in a result card or a model prompt.
 */
import { loadDefinition } from '../../config.mjs';
import { worldModelSourceSnapshot } from '../../grounding.mjs';
import { deriveRepositoryFacts } from '../../repository-facts.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';

const startsWithPath = (candidate, prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`);

function scopedSource(source, requestedPath) {
  if (!requestedPath) return source;
  const files = source.files.filter((entry) => startsWithPath(entry.path, requestedPath));
  return {
    ...source,
    scope: { sourceRoots: [requestedPath], sharedRoots: [], all: false },
    files
  };
}

function repositoryMatches(root, requested, context) {
  if (!requested) return true;
  const known = new Set([
    root,
    context.repositoryId,
    context.repository?.id,
    context.repository?.name
  ].filter(Boolean).map(String));
  return known.has(String(requested));
}

export function repositoryExploreResult({ repositoryId, path = null, question = null, facts, source, subject = null } = {}) {
  const empty = facts.counts.files === 0;
  return sflowResult({
    kind: 'read',
    operation: { id: 'repository.explore', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { repository: repositoryId, files: String(facts.counts.files) }
    },
    effects: noEffects(),
    why: [{
      code: 'repository.explore.bounded-facts', source: 'deterministic', reference: source.sha256,
      slots: { files: String(facts.counts.files), path: path ?? '.' }
    }],
    warnings: empty ? [{
      code: 'repository.explore.empty-scope', source: 'unavailable', slots: { path: path ?? '.' }
    }] : [],
    preserved: preservedAll('repository.explore.nothing-was-carried-out', { reference: repositoryId }),
    restState: 'informational',
    data: {
      repository: repositoryId,
      sourceRevision: source.sha256,
      scope: { path, files: facts.counts.files, all: source.scope?.all === true },
      queryProvided: Boolean(question),
      overview: {
        counts: facts.counts,
        frameworks: facts.frameworks.slice(0, 40),
        manifests: facts.manifests.slice(0, 30),
        entryPoints: facts.entryPoints.slice(0, 30),
        commands: facts.commands.slice(0, 40),
        mostDependedOn: facts.mostImported.slice(0, 30),
        mostChanged: facts.mostChanged.slice(0, 30),
        tests: facts.tests.slice(0, 100),
        unindexed: facts.unindexed.slice(0, 100)
      },
      bounds: {
        sourceBodiesIncluded: false,
        maximumEntriesPerCategory: 100,
        complete: facts.unindexed.length === 0
      }
    }
  });
}

export async function repositoryExplore({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) {
    throw new SingularityFlowError('repository.explore requires the repository root it should read.', {
      code: 'REPOSITORY_EXPLORE_NO_ROOT'
    });
  }
  if (!repositoryMatches(root, args.repositoryId, context)) {
    return sflowResult({
      kind: 'refusal',
      operation: { id: 'repository.explore', classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { repository: args.repositoryId } },
      effects: noEffects(),
      why: [{ code: 'repository.explore.wrong-repository', source: 'deterministic', slots: { repository: args.repositoryId } }],
      preserved: preservedAll('repository.explore.nothing-was-carried-out', { reference: args.repositoryId }),
      restState: 'blocked'
    });
  }
  const definition = await loadDefinition(root).catch(() => ({}));
  const source = scopedSource(await worldModelSourceSnapshot(root, definition), args.path ?? null);
  const facts = await deriveRepositoryFacts(root, source, { churn: false });
  return repositoryExploreResult({
    repositoryId: args.repositoryId,
    path: args.path ?? null,
    question: args.question ?? null,
    facts,
    source,
    subject
  });
}
