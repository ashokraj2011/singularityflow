import { z } from 'zod';
import { gitRepositoryComparisonKey } from '../git-repository-identity.mjs';
import { recordSha256 } from '../records.mjs';
import { isGitRefName, SingularityFlowError } from '../util.mjs';

export const PROVIDER_PROTOCOL = 'sflow-ask-v1';
export const PROVIDER_ROUTE = '/v1/ask';
export const SHARED_FAMILY = 'ask-portable-conversation';
export const PORTABLE_ID = /^askp-[a-f0-9]{32}$/u;
export const STORE_BYTES = 128 * 1024;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const failure = (code, message, details) => new SingularityFlowError(message, { code, details });
export function repositoryScope(url) {
  const key = typeof url === 'string' ? gitRepositoryComparisonKey(url) : null;
  if (!key) throw failure('ASK_PROVIDER_CONFIGURATION_INVALID', 'Configure a credential-free Git repository identity for the Ask provider.');
  return recordSha256(key);
}

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const pathName = z.string().min(1).max(1024).refine(value => !/^[\\/]|^[a-z]:|[\x00-\x1f\\]/iu.test(value) &&
  !value.split('/').some(part => ['', '.', '..'].includes(part)));
const filePath = z.string().min(1).max(1024).refine(value => !value.includes('\0'));
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const branch = z.string().max(240).refine(value => isGitRefName(value) && !value.startsWith('refs/'));
const workKind = z.enum(['story', 'initiative']);
const id = z.string().regex(PORTABLE_ID);
const linkId = z.string().regex(/^ev-[a-f0-9]{24}$/u);
const ordinalKey = z.string().regex(/^choice-[1-3]$/u);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().datetime();

const gitSource = z.strictObject({ kind: z.literal('git-refs'), branches: z.array(branch).min(1).max(2) });
const stateSource = z.strictObject({ kind: z.literal('state'), remote: identifier, branch, repository: hex });
const remoteSource = z.union([gitSource, stateSource]);
const evidenceRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local') }),
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('help'), topic: identifier, sha256: hex.or(sha) }),
  z.strictObject({ kind: z.literal('spec'), reference: z.string().max(160).regex(/^SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*@[1-9][0-9]*$/u),
    stateCommit: commit, manifestSha256: sha, contentSha256: sha }),
  z.strictObject({ kind: z.literal('commit'), commit }),
  z.strictObject({ kind: z.literal('work'), workKind, workId: identifier, commit, path: pathName, sha256: hex }),
  z.strictObject({ kind: z.literal('event'), workKind, workId: identifier, commit, namespace: pathName,
    snapshot: commit, entryHash: hex, path: pathName }),
  z.strictObject({ kind: z.literal('diff'), left: commit, right: commit, path: pathName, oldPath: pathName.nullable(), status: z.enum(['A', 'D', 'M', 'R', 'T']) })
]);
const evidence = z.strictObject({ id: linkId, ref: evidenceRef, source: remoteSource.optional() }).refine(({ ref, source }) => {
  if (['local', 'unavailable', 'help'].includes(ref.kind)) return source === undefined;
  if (['spec', 'event'].includes(ref.kind)) return source?.kind === 'state';
  return source?.kind === 'git-refs' && source.branches.length === (ref.kind === 'diff' ? 2 : 1);
});

// A saved page holds an absolute interval and exact provider checkpoints, never the original question.
const count = z.number().int().min(0).max(100000);
const window = z.strictObject({ startDate: z.string().date(), endDate: z.string().date(), timeZone: pathName,
  anchorInstant: instant.nullable(), calendarConvention: z.literal('iso8601-monday-start'), startInclusive: instant.nullable(), endExclusive: instant });
const checkpoint = z.strictObject({ revision: commit.optional(), left: commit.optional(), right: commit.optional(), snapshot: commit.optional(),
  namespace: pathName.optional(), offset: count.optional(), retrieved: count.optional(), shallow: hex.nullable().optional(),
  retry: z.boolean().optional(), view: hex.optional(), ledgerContinuation: z.string().max(512).regex(/^lp1\.[A-Za-z0-9_-]+$/u).nullable().optional() });
const intent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('commits'), revision: branch }),
  z.strictObject({ kind: z.literal('comparison'), left: branch, right: branch, path: pathName.nullable(), patch: z.boolean() }),
  z.strictObject({ kind: z.literal('work-history'), mode: z.enum(['history', 'activity-during', 'completed-during', 'currently-complete', 'as-of']),
    workKind: workKind.nullable(), workId: identifier.nullable().optional() })
]);
const privateReference = z.strictObject({ localId: linkId });
const history = z.union([privateReference, z.strictObject({ unavailable: z.literal(true) }), z.strictObject({ intent, window: window.nullable(), start: checkpoint,
  next: checkpoint.nullable(), source: remoteSource }).refine(value => {
  const checkpoints = [value.start, value.next].filter(Boolean);
  if (value.intent.kind === 'commits') return value.source.kind === 'git-refs' && value.source.branches.length === 1 && value.window &&
    checkpoints.every(item => item.revision === value.start.revision && item.revision && !item.left && !item.right && !item.snapshot);
  if (value.intent.kind === 'comparison') return value.source.kind === 'git-refs' && value.source.branches.length === 2 &&
    checkpoints.every(item => item.left && item.right && item.left === value.start.left && item.right === value.start.right && !item.revision && !item.snapshot);
  return value.source.kind === 'state' && checkpoints.every(item => item.snapshot && item.snapshot === value.start.snapshot && !item.revision && !item.left && !item.right &&
    item.namespace === `${value.source.remote}/${value.source.branch}`);
})]);
export const sharedContextSchema = z.strictObject({
  result: z.strictObject({ id: z.string().regex(/^ask-[a-f0-9]{32}$/u).nullable().optional(), refs: z.array(evidence).max(100),
    history: history.nullable(), pending: z.union([privateReference, z.strictObject({ kind: z.enum(['discovery', 'story-spec', 'work']),
      choices: z.array(z.strictObject({ id: identifier, kind: workKind.or(z.literal('help')), key: ordinalKey })).min(1).max(3)
    })]).nullable() }),
  selected: evidence.nullable(), reads: z.number().int().min(1).max(24), explanationUsed: z.boolean(),
  localTask: linkId.optional(),
  taskPublication: evidence.optional()
}).refine(value => !value.taskPublication || (value.localTask && value.taskPublication.ref.kind === 'work' &&
  value.taskPublication.ref.workKind === 'story'));

const scopeFields = { provider: slug, workspace: slug, repository: hex };
export const providerRequest = z.discriminatedUnion('operation', [
  z.strictObject({ ...scopeFields, operation: z.literal('describe') }),
  z.strictObject({ ...scopeFields, operation: z.literal('read'), id: id.nullable(), expected: revision.nullable() }),
  z.strictObject({ ...scopeFields, operation: z.literal('create'), id, context: sharedContextSchema }),
  z.strictObject({ ...scopeFields, operation: z.literal('update'), id, expected: revision, context: sharedContextSchema }),
  z.strictObject({ ...scopeFields, operation: z.literal('forget'), id, expected: revision })
]);

const accessGrant = z.strictObject({ tokenSha256: hex, owner: identifier, workspace: slug, repository: filePath, expiresAt: instant.optional() });
export const serverConfiguration = z.strictObject({ schemaVersion: z.literal(1), name: slug, directory: filePath,
  host: z.string().min(1).max(255).optional(), port: z.number().int().min(0).max(65535).optional(),
  tls: z.strictObject({ key: filePath, cert: filePath }).optional(), grants: z.array(accessGrant).max(1024) });

export const clientConfiguration = z.strictObject({ schemaVersion: z.literal(1), bindings: z.array(z.strictObject({
  provider: slug, endpoint: z.string().url().max(512), workspace: slug, repository: filePath,
  remote: identifier.optional(), tokenFile: filePath
})).max(64) });

export const sharedRecordSchema = sharedContextSchema.safeExtend({ schemaVersion: z.literal(1), id, scope: hex,
  revision, updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
