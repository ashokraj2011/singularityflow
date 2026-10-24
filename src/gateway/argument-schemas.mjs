/**
 * Typed argument schemas for gateway-reachable operations. `[INT:IFC-030]`
 *
 * `sflow_read` and `sflow_run` accept a handle and nothing else `[INT:IFC-013]` `[INT:IFC-015]`;
 * the only place a model's own words become operation arguments is resolution, and this is where
 * they stop being words. Every schema is closed: an unknown field is rejected rather than dropped,
 * because a dropped field is a silent change of meaning — the caller asked for something narrower
 * than what runs.
 *
 * The types are deliberately few. Each one exists because something downstream would otherwise have
 * to guess: a ref reaches argv, a path reaches the file system, an identifier reaches a record
 * lookup, and text reaches a prompt. Anything a schema cannot type, it does not accept.
 */
import { isGitRefName, SingularityFlowError } from '../util.mjs';

const MAX_TEXT = 2000;
const MAX_STRING = 200;

function reject(schemaId, field, detail, value) {
  throw new SingularityFlowError(
    `Argument '${field}' for schema '${schemaId}' ${detail}.`,
    { code: 'INVALID_OPERATION_ARGUMENT', details: { schema: schemaId, field, value } }
  );
}

/**
 * Control characters are rejected everywhere, in every type.
 *
 * A NUL truncates in exactly the layers that matter (argv, paths, C libraries), and a stray newline
 * turns one argument into two in every line-oriented format this product writes. Neither has a
 * legitimate use in an operation argument.
 */
function assertPlain(schemaId, field, value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) reject(schemaId, field, 'contains a control character', value);
}

const TYPES = Object.freeze({
  boolean(schemaId, field, value) {
    if (typeof value !== 'boolean') reject(schemaId, field, 'must be a boolean', value);
    return value;
  },

  integer(schemaId, field, value, spec) {
    if (!Number.isInteger(value)) reject(schemaId, field, 'must be an integer', value);
    if (spec.min != null && value < spec.min) reject(schemaId, field, `must be at least ${spec.min}`, value);
    if (spec.max != null && value > spec.max) reject(schemaId, field, `must be at most ${spec.max}`, value);
    return value;
  },

  /** Short, single-line, bounded. For names and labels a human typed. */
  string(schemaId, field, value, spec) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    assertPlain(schemaId, field, value);
    const max = spec.maxLength ?? MAX_STRING;
    if (!value.trim()) reject(schemaId, field, 'must not be blank', value);
    if (value.length > max) reject(schemaId, field, `must be at most ${max} characters`, value);
    return value;
  },

  /** Prose the user actually wrote — a symptom, a question, a hypothesis. Bounded, still single-block. */
  text(schemaId, field, value, spec) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      reject(schemaId, field, 'contains a control character', value);
    }
    const max = spec.maxLength ?? MAX_TEXT;
    if (!value.trim()) reject(schemaId, field, 'must not be blank', value);
    if (value.length > max) reject(schemaId, field, `must be at most ${max} characters`, value);
    return value;
  },

  enum(schemaId, field, value, spec) {
    if (!spec.values.includes(value)) {
      reject(schemaId, field, `must be one of ${spec.values.join(', ')}`, value);
    }
    return value;
  },

  /** A governed record ID: work IDs, workspace IDs, job IDs. Never a path, never a ref. */
  identifier(schemaId, field, value) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
      reject(schemaId, field, 'is not a valid identifier', value);
    }
    return value;
  },

  /** Opaque, integrity-bound continuation state emitted by a read operation. */
  'opaque-cursor'(schemaId, field, value) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    assertPlain(schemaId, field, value);
    if (!/^astp_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value) || value.length > 16_500) {
      reject(schemaId, field, 'is not a valid AST read cursor', value);
    }
    return value;
  },

  /** A machine-local Evidence Packet expansion handle. Never accepts paths, refs, commands, or URLs. */
  'context-handle'(schemaId, field, value) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    assertPlain(schemaId, field, value);
    if (!/^ctx_[a-f0-9]{32}_[a-f0-9]{32}$/.test(value)) {
      reject(schemaId, field, 'is not a valid sealed context handle', value);
    }
    return value;
  },

  /**
   * A Git ref, commit, or tag — which is to say, something that will reach `git` as argv.
   *
   * The leading-dash rejection is the point: `--upload-pack=…` is a valid-looking "ref" that is
   * really an option, and every Git command that takes a ref also takes options.
   */
  ref(schemaId, field, value) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    if (value.length > MAX_STRING) reject(schemaId, field, `must be at most ${MAX_STRING} characters`, value);
    if (value.endsWith('.lock')) reject(schemaId, field, 'is not a well-formed ref', value);
    if (!isGitRefName(value)) reject(schemaId, field, 'is not a name Git will accept as a ref', value);
    return value;
  },

  /** Repository-relative, and provably so: no absolute root, no traversal, no drive letter. */
  'relative-path'(schemaId, field, value) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    assertPlain(schemaId, field, value);
    if (!value.trim()) reject(schemaId, field, 'must not be blank', value);
    if (value.length > 1024) reject(schemaId, field, 'must be at most 1024 characters', value);
    if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
      reject(schemaId, field, 'must be repository-relative, not absolute', value);
    }
    if (value.split(/[/\\]/).includes('..')) reject(schemaId, field, 'must not traverse outside the repository', value);
    return value;
  },

  /**
   * A location on this machine the user chose — a materialization target, and nothing read from it.
   *
   * Absolute is legitimate here and traversal is not, because a target containing `..` is a target
   * the user cannot verify by reading it.
   */
  'filesystem-path'(schemaId, field, value) {
    if (typeof value !== 'string') reject(schemaId, field, 'must be a string', value);
    assertPlain(schemaId, field, value);
    if (!value.trim()) reject(schemaId, field, 'must not be blank', value);
    if (value.length > 1024) reject(schemaId, field, 'must be at most 1024 characters', value);
    if (value.split(/[/\\]/).includes('..')) reject(schemaId, field, 'must not contain a parent-directory segment', value);
    return value;
  }
});

export const ARGUMENT_TYPES = Object.freeze(Object.keys(TYPES));

/** Every group a work item can appear in `[INT:REQ-060]`. */
export const WORK_GROUPS = Object.freeze([
  'active', 'waiting-on-you', 'waiting-on-others', 'recovery-required', 'recently-completed'
]);

/** The subjects a typed comparison can take, both sides resolved exactly `[INT:REQ-186]`. */
export const COMPARISON_SUBJECTS = Object.freeze([
  'build', 'branch', 'commit', 'release', 'worktree', 'artifact', 'generation', 'plan', 'provider-observation'
]);

function schema(id, fields) {
  if (!/-v[1-9][0-9]*$/.test(id)) {
    throw new SingularityFlowError(`Argument schema '${id}' must end in a version suffix such as '-v1'.`, {
      code: 'UNVERSIONED_ARGUMENT_SCHEMA', details: { schema: id }
    });
  }
  for (const [field, spec] of Object.entries(fields)) {
    if (!TYPES[spec.type]) {
      throw new SingularityFlowError(`Argument schema '${id}' field '${field}' has unknown type '${spec.type}'.`, {
        code: 'UNKNOWN_ARGUMENT_TYPE', details: { schema: id, field, type: spec.type, known: ARGUMENT_TYPES }
      });
    }
    if (spec.type === 'enum' && !spec.values?.length) {
      throw new SingularityFlowError(`Argument schema '${id}' field '${field}' is an enum with no values.`, {
        code: 'EMPTY_ARGUMENT_ENUM', details: { schema: id, field }
      });
    }
  }
  return Object.freeze({ id, fields: Object.freeze(fields) });
}

const required = (type, extra = {}) => ({ type, required: true, ...extra });
const optional = (type, extra = {}) => ({ type, required: false, ...extra });

export const ARGUMENT_SCHEMAS = Object.freeze([
  schema('no-arguments-v1', {}),
  schema('work-subject-v1', {
    workId: required('identifier'),
    workKind: optional('enum', { values: ['story', 'initiative'] })
  }),
  schema('auto-flight-v1', { flightId: required('identifier') }),
  schema('auto-story-v1', { workId: required('identifier') }),
  schema('auto-plan-v1', { planId: required('identifier') }),
  schema('governed-goal-v1', {
    goalId: required('identifier'),
    criterionId: optional('identifier')
  }),
  schema('work-list-v1', {
    group: optional('enum', { values: WORK_GROUPS }),
    includeCompleted: optional('boolean')
  }),
  schema('work-handoff-v1', {
    workId: required('identifier'),
    workKind: optional('enum', { values: ['story', 'initiative'] }),
    includeLocalChanges: optional('boolean')
  }),
  schema('context-brief-v1', {
    workId: optional('identifier'),
    flightPlanId: optional('identifier'),
    expandHandle: optional('context-handle'),
    slice: optional('enum', { values: ['brief', 'impact', 'world-model', 'ast', 'evidence', 'history', 'observation'] }),
    maxOutputBytes: optional('integer', { min: 4096, max: 128 * 1024 })
  }),
  schema('work-start-intake-v1', {
    source: optional('enum', { values: [
      'jira', 'github-issue', 'manual', 'initiative', 'story', 'bug-report', 'idea',
      'repository-observation', 'finding'
    ] }),
    shape: optional('enum', { values: ['initiative', 'epic', 'story'] }),
    workspaceId: optional('identifier'),
    repositoryId: optional('identifier'),
    workType: optional('identifier'),
    summary: optional('text'),
    // A complete proposal: the kernel records it as session data and plans its start `[INT:CON-064]`.
    workId: optional('identifier'),
    title: optional('string'),
    description: optional('text'),
    acceptanceCriteria: optional('text'),
    baseBranch: optional('ref'),
    tracker: optional('enum', { values: ['none', 'jira', 'github'] }),
    trackerKey: optional('string')
  }),
  schema('work-start-v1', { intakeId: required('identifier') }),
  /**
   * The typed intake a host form hands `kernel.recordIntake` `[INT:REQ-066]` `[INT:CON-065]`.
   *
   * Not an operation argument: no model-facing tool accepts it. It is the record the work-start
   * planner normalizes into the exact preview a person confirms, and it lives only in the session.
   */
  schema('work-intake-record-v1', {
    workId: required('identifier'),
    shape: optional('enum', { values: ['initiative', 'epic', 'story'] }),
    workType: required('identifier'),
    tracker: optional('enum', { values: ['none', 'jira', 'github'] }),
    trackerKey: optional('string'),
    title: optional('string'),
    description: optional('text'),
    acceptanceCriteria: optional('text'),
    baseBranch: optional('ref'),
    source: optional('enum', { values: [
      'jira', 'github-issue', 'manual', 'initiative', 'story', 'bug-report', 'idea', 'repository-observation', 'finding'
    ] })
  }),
  schema('work-draft-save-v1', { intakeId: required('identifier'), label: required('string') }),
  schema('workspace-switch-v1', { workspaceId: required('identifier') }),
  schema('workspace-bootstrap-status-v1', { bootstrapId: required('identifier') }),
  schema('workspace-materialize-v1', {
    workspaceId: required('identifier'),
    targetPath: required('filesystem-path')
  }),
  schema('impact-quick-v1', {
    baseRef: optional('ref'),
    targetRef: optional('ref'),
    includeWorktree: optional('boolean'),
    // A host model's answer to the assisted relay; validated against the facts, never trusted.
    interpretation: optional('text', { maxLength: 8000 })
  }),
  schema('impact-what-if-v1', { proposal: required('text'), scope: optional('relative-path') }),
  schema('repository-explore-v1', {
    repositoryId: optional('identifier'),
    path: optional('relative-path'),
    question: optional('text')
  }),
  schema('repository-query-v1', {
    query: required('enum', { values: [
      'repositories', 'status', 'branches', 'tags', 'log', 'commit', 'path-history', 'blame', 'diff',
      'merge-base', 'contains', 'search', 'version-commit', 'build-commit'
    ] }),
    repositoryId: optional('identifier'),
    revision: optional('ref'),
    base: optional('ref'),
    path: optional('relative-path'),
    text: optional('string', { maxLength: 500 }),
    lineStart: optional('integer', { min: 1 }),
    lineEnd: optional('integer', { min: 1 }),
    version: optional('string', { maxLength: 128 }),
    buildId: optional('identifier'),
    max: optional('integer', { min: 1, max: 500 })
  }),
  schema('ast-context-v1', {
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 })
  }),
  schema('ast-query-v1', {
    predicate: required('enum', { values: ['symbol', 'import', 'language', 'path'] }),
    value: required('string', { maxLength: 500 }),
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 })
  }),
  schema('ast-symbol-v1', {
    name: optional('string', { maxLength: 500 }),
    symbolId: optional('string', { maxLength: 1000 }),
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 }),
    maxFacts: optional('integer', { min: 1, max: 1000 }),
    maxOutputBytes: optional('integer', { min: 16384, max: 4194304 }),
    cursor: optional('string', { maxLength: 16384 })
  }),
  schema('ast-symbol-id-v1', {
    symbolId: required('string', { maxLength: 1000 }),
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 }),
    maxFacts: optional('integer', { min: 1, max: 1000 }),
    maxOutputBytes: optional('integer', { min: 16384, max: 4194304 }),
    cursor: optional('string', { maxLength: 16384 })
  }),
  schema('ast-module-v1', {
    module: required('string', { maxLength: 1000 }),
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 }),
    maxFacts: optional('integer', { min: 1, max: 1000 }),
    maxOutputBytes: optional('integer', { min: 16384, max: 4194304 }),
    cursor: optional('string', { maxLength: 16384 })
  }),
  schema('ast-context-v2', {
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 }),
    maxFacts: optional('integer', { min: 1, max: 10000 }),
    maxOutputBytes: optional('integer', { min: 16384, max: 4 * 1024 * 1024 }),
    cursor: optional('opaque-cursor')
  }),
  schema('ast-query-v2', {
    predicate: optional('enum', { values: ['symbol', 'import', 'language', 'path'] }),
    value: optional('string', { maxLength: 500 }),
    path: optional('relative-path'),
    all: optional('boolean'),
    maxFiles: optional('integer', { min: 1, max: 10000 }),
    maxFacts: optional('integer', { min: 1, max: 10000 }),
    maxOutputBytes: optional('integer', { min: 16384, max: 4 * 1024 * 1024 }),
    cursor: optional('opaque-cursor')
  }),
  schema('ast-evidence-replay-v1', {
    receipt: required('relative-path')
  }),
  schema('intent-trace-v1', {
    repositoryId: required('identifier'),
    path: required('relative-path'),
    lineStart: optional('integer', { min: 1 }),
    lineEnd: optional('integer', { min: 1 })
  }),
  schema('compare-v1', {
    subjectKind: required('enum', { values: COMPARISON_SUBJECTS }),
    left: required('string'),
    right: required('string')
  }),
  schema('problem-investigate-v1', {
    symptom: required('text'),
    repositoryId: optional('identifier'),
    sinceRef: optional('ref'),
    // §10.1's other inputs: missing ones stay unknown, never filled in `[INT:CON-091]`.
    expected: optional('text'),
    environment: optional('string'),
    observedVersion: optional('string', { maxLength: 128 }),
    observedBuildId: optional('identifier'),
    since: optional('string', { maxLength: 64 }),
    reproduction: optional('text'),
    lastKnownGood: optional('ref'),
    stopAfter: optional('enum', { values: [
      'incident-facts', 'build-provenance', 'repository-state', 'change-range', 'tests', 'ownership-and-active-work', 'deterministic-impact'
    ] }),
    interpretation: optional('text', { maxLength: 8000 })
  }),
  schema('build-read-v1', { branch: optional('ref'), limit: optional('integer', { min: 1, max: 100 }) }),
  schema('investigation-bisect-v1', {
    good: required('ref'),
    bad: optional('ref'),
    testCommandId: required('identifier'),
    maxSteps: optional('integer', { min: 3, max: 32 }),
    repositoryId: optional('identifier')
  }),
  schema('watch-create-v1', { subjectId: required('identifier'), predicate: required('identifier') }),
  schema('watch-revoke-v1', { watchId: required('identifier') }),
  schema('help-explain-v1', { question: required('text'), topic: optional('identifier') }),
  ...hostActionSchemas()
]);

/**
 * The host actions a result may name, and nothing else. `[INT:IFC-061]` `[INT:CON-130]`
 *
 * One list for every host: the kernel validates against it when a result is emitted, and the
 * receiving editor validates against it again before it opens anything, so the two checks cannot
 * disagree about what an action is. A host action opens a trusted view; it is never a command line,
 * never a lifecycle step, and never part of a publication — the view it opens does its own work
 * behind its own confirmation, exactly as if the person had opened it from the menu.
 *
 * Every argument is an opaque identifier, an enum or a bounded integer `[INT:CON-131]`: there is no
 * text, path or ref type here, so a deep link has nowhere to carry a command even before the
 * command-text check below looks for one.
 */
export const HOST_ACTIONS = Object.freeze([
  'vscode.selectWorkspace', 'vscode.attachRepository', 'vscode.openArtifact', 'vscode.openReviewCeremony',
  'vscode.openJourney', 'vscode.openImpact', 'vscode.openInvestigation', 'vscode.openContextReceipt',
  'vscode.openHandoff', 'vscode.openProgress', 'vscode.focusCopilot'
]);

/** Why a host action was dropped or refused: a slot value, never prose. */
export const HOST_ACTION_REFUSALS = Object.freeze([
  'malformed', 'not-allowlisted', 'argument-unknown', 'argument-missing', 'argument-invalid', 'command-text',
  'fallback-missing', 'not-available-in-this-build', 'context-changed'
]);

function hostActionSchemas() {
  const work = { workId: optional('identifier'), workKind: optional('enum', { values: ['story', 'initiative'] }) };
  const fields = {
    'vscode.selectWorkspace': { workspaceId: optional('identifier') },
    'vscode.attachRepository': { workspaceId: optional('identifier'), repositoryId: optional('identifier') },
    'vscode.openArtifact': { workId: required('identifier'), phase: optional('identifier'), artifactId: optional('identifier') },
    'vscode.openReviewCeremony': {
      workId: required('identifier'), workKind: optional('enum', { values: ['story', 'initiative'] }),
      phase: optional('identifier'), generation: optional('integer', { min: 0, max: 1_000_000 })
    },
    'vscode.openJourney': work,
    'vscode.openImpact': { ...work, flightPlanId: optional('identifier') },
    'vscode.openInvestigation': { investigationId: optional('identifier'), workId: optional('identifier') },
    'vscode.openContextReceipt': { receiptId: optional('identifier'), workId: optional('identifier') },
    'vscode.openHandoff': { workId: required('identifier'), workKind: optional('enum', { values: ['story', 'initiative'] }) },
    'vscode.openProgress': { jobId: optional('identifier'), workId: optional('identifier') },
    'vscode.focusCopilot': {}
  };
  return Object.entries(fields).map(([id, entry]) => schema(hostActionSchemaId(id), entry));
}

/** `vscode.openReviewCeremony` → `host-action-vscode-open-review-ceremony-v1`. */
export function hostActionSchemaId(id) {
  return `host-action-${String(id).replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-v1`;
}

/**
 * Text that reads as something to run rather than something to look up. `[INT:CON-131]`
 *
 * Whitespace, shell metacharacters, a URI scheme and a leading option dash: none can appear in an
 * identifier, so this only changes *which* reason a rejected value is recorded under — and "this
 * argument carried a command" is the reason a reviewer of the record needs to see.
 */
function looksLikeCommandText(value) {
  return typeof value === 'string'
    && (/[\s;|&`$<>(){}\\'"]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith('-'));
}

const ARGUMENT_REFUSALS = Object.freeze({
  UNKNOWN_OPERATION_ARGUMENT: 'argument-unknown',
  MISSING_OPERATION_ARGUMENT: 'argument-missing',
  INVALID_OPERATION_ARGUMENT: 'argument-invalid'
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Validate one host action against the allowlist and its typed schema. Never throws.
 * `[INT:IFC-061]` `[INT:CON-130]` `[INT:CON-131]`
 *
 * Returns the accepted action — the allowlisted ID and exactly the arguments its schema accepted —
 * or the reason it was refused. The refused record names the action only when the name is itself a
 * plain dotted identifier, so a tampered action cannot smuggle its payload into the reason.
 */
export function validateHostAction(candidate) {
  const refused = (reason, action = 'unknown', field = null) => Object.freeze({ ok: false, action, reason, field });
  if (!isRecord(candidate)) return refused('malformed');
  const named = typeof candidate.id === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(candidate.id) ? candidate.id : 'unknown';
  const extra = Object.keys(candidate).find((key) => !['id', 'arguments'].includes(key));
  if (extra) return refused('malformed', named, extra.slice(0, 64));
  if (!HOST_ACTIONS.includes(candidate.id)) return refused('not-allowlisted', named);
  const args = candidate.arguments === undefined ? {} : candidate.arguments;
  if (!isRecord(args)) return refused('malformed', named, 'arguments');
  for (const [field, value] of Object.entries(args)) {
    if (looksLikeCommandText(value)) return refused('command-text', named, field.slice(0, 64));
  }
  try {
    const accepted = validateArguments(hostActionSchemaId(candidate.id), args);
    return Object.freeze({ ok: true, hostAction: Object.freeze({ id: candidate.id, arguments: accepted }) });
  } catch (error) {
    const field = typeof error?.details?.field === 'string' ? error.details.field.slice(0, 64) : null;
    return refused(ARGUMENT_REFUSALS[error?.code] ?? 'argument-invalid', named, field);
  }
}

/**
 * A deep link's query, as the host action it names. `[INT:CON-131]`
 *
 * `?action=vscode.openJourney&workId=WRK-1` — the action and its arguments, nothing else. Every
 * query value is a string, so an integer field is converted only when its schema says it is one and
 * the digits say so; a repeated key is malformed rather than resolved by picking one. The result
 * still goes through {@link validateHostAction}: parsing a link is not accepting it.
 */
export function hostActionFromLink(query) {
  const params = new URLSearchParams(String(query ?? ''));
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size || !params.has('action')) return { malformed: true };
  const id = params.get('action');
  const fields = argumentSchema(hostActionSchemaId(id))?.fields ?? {};
  const args = {};
  for (const [key, value] of params) {
    if (key === 'action') continue;
    args[key] = fields[key]?.type === 'integer' && /^[0-9]{1,9}$/.test(value) ? Number(value) : value;
  }
  return { id, arguments: args };
}

const BY_ID = new Map(ARGUMENT_SCHEMAS.map((entry) => [entry.id, entry]));

export function argumentSchema(id) {
  return BY_ID.get(id) ?? null;
}

export function hasArgumentSchema(id) {
  return BY_ID.has(id);
}

/**
 * Validate proposed arguments against a schema, returning the accepted values and nothing else.
 *
 * Absent optional fields stay absent rather than becoming `null`: a field the caller did not send
 * and a field the caller sent as empty are different requests, and the planner has to be able to
 * tell them apart.
 */
export function validateArguments(schemaId, proposed = {}) {
  const entry = BY_ID.get(schemaId);
  if (!entry) {
    throw new SingularityFlowError(`Unknown argument schema '${schemaId}'.`, {
      code: 'UNKNOWN_ARGUMENT_SCHEMA', details: { schema: schemaId }
    });
  }
  if (proposed == null || typeof proposed !== 'object' || Array.isArray(proposed)) {
    throw new SingularityFlowError(`Arguments for '${schemaId}' must be an object.`, {
      code: 'INVALID_OPERATION_ARGUMENT', details: { schema: schemaId }
    });
  }

  const known = Object.keys(entry.fields);
  for (const field of Object.keys(proposed)) {
    if (!known.includes(field)) {
      throw new SingularityFlowError(
        `'${field}' is not an argument of '${schemaId}'.`
        + ` Accepted: ${known.length ? known.join(', ') : 'none'}.`,
        { code: 'UNKNOWN_OPERATION_ARGUMENT', details: { schema: schemaId, field, accepted: known } }
      );
    }
  }

  const accepted = {};
  for (const [field, spec] of Object.entries(entry.fields)) {
    const value = proposed[field];
    if (value === undefined) {
      /**
       * Missing and wrong are different answers, and the caller has to be able to tell them apart.
       *
       * A wrong value is a refusal: the caller said something the operation cannot accept. A missing
       * one is a question the resolver can still ask — and returning "invalid" for both is what turns
       * "which Story did you mean?" into a dead end.
       */
      if (spec.required) {
        throw new SingularityFlowError(`Argument '${field}' for schema '${schemaId}' is required.`, {
          code: 'MISSING_OPERATION_ARGUMENT', details: { schema: schemaId, field }
        });
      }
      continue;
    }
    accepted[field] = TYPES[spec.type](schemaId, field, value, spec);
  }
  return Object.freeze(accepted);
}
