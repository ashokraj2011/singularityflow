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
  schema('work-subject-v1', { workId: required('identifier') }),
  schema('work-list-v1', {
    group: optional('enum', { values: WORK_GROUPS }),
    includeCompleted: optional('boolean')
  }),
  schema('work-handoff-v1', {
    workId: required('identifier'),
    includeLocalChanges: optional('boolean')
  }),
  schema('work-start-intake-v1', {
    source: optional('enum', { values: ['jira', 'initiative', 'story', 'bug-report', 'idea', 'repository-observation', 'finding'] }),
    workspaceId: optional('identifier'),
    repositoryId: optional('identifier'),
    workType: optional('identifier'),
    summary: optional('text')
  }),
  schema('work-start-v1', { intakeId: required('identifier') }),
  schema('work-draft-save-v1', { intakeId: required('identifier'), label: required('string') }),
  schema('workspace-switch-v1', { workspaceId: required('identifier') }),
  schema('workspace-materialize-v1', {
    workspaceId: required('identifier'),
    targetPath: required('filesystem-path')
  }),
  schema('impact-quick-v1', {
    baseRef: optional('ref'),
    targetRef: optional('ref'),
    includeWorktree: optional('boolean')
  }),
  schema('impact-what-if-v1', { proposal: required('text'), scope: optional('identifier') }),
  schema('repository-explore-v1', {
    repositoryId: required('identifier'),
    path: optional('relative-path'),
    question: optional('text')
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
    sinceRef: optional('ref')
  }),
  schema('watch-create-v1', { subjectId: required('identifier'), predicate: required('identifier') }),
  schema('watch-revoke-v1', { watchId: required('identifier') }),
  schema('help-explain-v1', { question: required('text'), topic: optional('identifier') })
]);

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
