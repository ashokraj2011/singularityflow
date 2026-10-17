/**
 * Closed, read-only utility entry contract. No config, Git, provider or registry imports:
 * eligibility and pause are decided before repository discovery.
 */
const FORMS = Object.freeze({
  status: { max: 2, options: ['json', 'for-agent', 'submission-readiness', 'brief'] },
  progress: { max: 2, options: ['json', 'for-agent'] },
  nextsteps: { max: 2, options: ['json', 'for-agent'] },
  'phase show': { min: 2, max: 3, options: ['json', 'for-agent'] },
  inputs: { max: 2, options: ['json', 'for-agent', 'dry-run'] },
  report: { max: 2, options: ['json', 'for-agent', 'format'] },
  logs: { max: 1, options: ['json', 'for-agent', 'level', 'event', 'since', 'tail'] },
  'workflow list': { max: 2, options: ['json', 'for-agent', 'for-start'] },
  'agents list': { max: 2, options: ['json', 'for-agent'] },
  'agents mappings': { max: 2, options: ['json', 'for-agent'] },
  'agents status': { max: 3, options: ['json', 'for-agent'] },
  'skill list': { max: 2, options: ['json', 'for-agent'] },
  'skill show': { min: 3, max: 3, options: ['json', 'for-agent'] },
  'instruction list': { max: 2, options: ['json', 'for-agent'] },
  'instruction show': { min: 3, max: 3, options: ['json', 'for-agent'] }
});

/** Also used to opt narrowly read-only handlers into one invocation-local read scope. */
export function scopedUtilityRead(positionals, options = {}) {
  const pair = positionals.slice(0, 2).join(' ');
  const key = Object.hasOwn(FORMS, pair) ? pair : positionals[0];
  const form = Object.hasOwn(FORMS, key) ? FORMS[key] : null;
  return Boolean(form && positionals.length >= (form.min ?? 1) && positionals.length <= form.max
    && Object.keys(options).every(key => key === 'utility-entry' || form.options.includes(key))
    && (positionals[0] !== 'inputs' || options['dry-run'] === true)
    && (positionals[0] !== 'report' || options.format === 'json')
    && !positionals.includes('--'));
}

export function validateUtilityEntry(positionals, options) {
  if (options['utility-entry'] !== true || options.json !== true || options['for-agent'] !== true
      || !scopedUtilityRead(positionals, options)) {
    throw Object.assign(new Error('--utility-entry requires an allowlisted read with --for-agent --json; mutations, output files and unknown options are not admitted.'), {
      code: 'UTILITY_ENTRY_REQUEST_INVALID'
    });
  }
}

export function withoutUtilityEntry(argv) {
  const end = argv.indexOf('--');
  return argv.filter((token, index) => (end >= 0 && index > end) || token !== '--utility-entry');
}

export function utilityResult(entry, data) {
  if (!entry.repositoryPath) throw Object.assign(new Error('Utility entry did not resolve a repository.'), { code: 'UTILITY_ENTRY_BINDING_REQUIRED' });
  const workId = data?.workId ?? data?.workItem?.id;
  const phase = data?.phase ?? data?.currentPhase;
  return { schemaVersion: 1, resultType: 'sflow-utility-entry', paused: false,
    repositoryPath: entry.repositoryPath, operation: entry.operation,
    ...(typeof workId === 'string' ? { workId } : {}),
    ...(typeof phase === 'string' ? { phase } : {}),
    // This is a successful read, never permission to author, publish or approve.
    readCompleted: true, data };
}
