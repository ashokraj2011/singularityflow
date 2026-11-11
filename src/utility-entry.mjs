/**
 * Closed, read-only utility entry contract. No config, Git, provider or registry imports:
 * eligibility and pause are decided before repository discovery.
 */
const FORMS = Object.freeze({
  status: { max: 2, options: ['json', 'for-agent', 'submission-readiness', 'brief'] },
  progress: { max: 2, options: ['json', 'for-agent'] },
  nextsteps: { max: 2, options: ['json', 'for-agent'] },
  'session current': { min: 2, max: 2, options: ['json', 'for-agent', 'no-model'] },
  'session status': { min: 2, max: 2, options: ['json', 'no-model'] },
  'session context': { min: 2, max: 2, options: ['json', 'no-model', 'work-id', 'slice', 'max-output-bytes'] },
  'phase show': { min: 2, max: 3, options: ['json', 'for-agent'] },
  'review-source context': { min: 2, max: 3, options: ['json', 'for-agent', 'no-model', 'work-id'] },
  'review-source status': { min: 3, max: 3, options: ['json', 'work-id'] },
  'review-source check': { min: 3, max: 3, options: ['json', 'work-id', 'report-file'] },
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
    && Object.keys(options).every(key => key === 'utility-entry' || form.options.includes(key)
      // Observability must not disable invocation-local reuse and change the path being measured.
      || ['timings', 'timing'].includes(key) && options[key] === true)
    && (positionals[0] !== 'inputs' || options['dry-run'] === true)
    && (positionals[0] !== 'report' || options.format === 'json')
    && !positionals.includes('--'));
}

// These read one Story named by their operand; `--work-id` names it the same way. /sf-status keeps an explicit Work
// ID, and `status --work-id X --utility-entry` was refused without saying which option or what to run (2026-11-11).
const WORK_ID_OPERAND = new Set(['status', 'progress', 'nextsteps']);

/** The request with `--work-id` as the operand of a command that takes one, or as it was. */
function withWorkIdOperand(positionals, options) {
  const workId = options['work-id'];
  if (!WORK_ID_OPERAND.has(positionals[0]) || typeof workId !== 'string' || !workId || positionals.length !== 1) return { positionals, options };
  const { 'work-id': named, ...rest } = options;
  return { positionals: [...positionals, named], options: rest };
}

const shellWord = (value) => (/^[A-Za-z0-9._:/=@-]+$/u.test(value) ? value : JSON.stringify(value));

/** Which options the form does not admit, and the exact read it does admit, for the refusal to name. */
function utilityEntryCorrection(positionals, options) {
  const pair = positionals.slice(0, 2).join(' ');
  const key = Object.hasOwn(FORMS, pair) ? pair : positionals[0];
  const form = Object.hasOwn(FORMS, key) && key !== 'session' && !key.startsWith('session ') ? FORMS[key] : null;
  if (!form || positionals.length < (form.min ?? 1) || positionals.length > form.max || positionals.includes('--')) return { unknown: [], command: null };
  const unknown = Object.keys(options).filter((name) => name !== 'utility-entry' && !form.options.includes(name)
    && !(['timings', 'timing'].includes(name) && options[name] === true));
  const kept = Object.entries(options).filter(([name, value]) => form.options.includes(name) && !['json', 'for-agent'].includes(name)
    && (value === true || typeof value === 'string'));
  const command = ['singularity-flow', ...positionals.map(shellWord),
    ...kept.flatMap(([name, value]) => (value === true ? [`--${name}`] : [`--${name}`, shellWord(value)])),
    ...(positionals[0] === 'report' && options.format !== 'json' ? ['--format', 'json'] : []),
    ...(positionals[0] === 'inputs' && options['dry-run'] !== true ? ['--dry-run'] : []),
    '--utility-entry', '--for-agent', '--json'].join(' ');
  return { unknown, command };
}

export function validateUtilityEntry(positionals, options) {
  ({ positionals, options } = withWorkIdOperand(positionals, options));
  if (options['utility-entry'] !== true || options.json !== true || options['for-agent'] !== true
      // Session has its own agent envelope/guard. Share its read scope, not a second wrapper.
      || positionals[0] === 'session'
      || !scopedUtilityRead(positionals, options)) {
    const { unknown, command } = utilityEntryCorrection(positionals, options);
    throw Object.assign(new Error('--utility-entry requires an allowlisted read with --for-agent --json; mutations, output files and unknown options are not admitted.'
      + `${unknown.length ? ` Not admitted in this read: ${unknown.map((name) => `--${name}`).join(', ')}.` : ''}`
      + `${command ? ` The read it admits: ${command}` : ''}`), {
      code: 'UTILITY_ENTRY_REQUEST_INVALID', details: { notAdmitted: unknown.map((name) => `--${name}`), command }
    });
  }
}

export function withoutUtilityEntry(argv) {
  const end = argv.indexOf('--');
  const kept = argv.filter((token, index) => (end >= 0 && index > end) || token !== '--utility-entry');
  // `--work-id X` becomes the operand validateUtilityEntry admitted it as.
  if (!WORK_ID_OPERAND.has(kept[0]) || kept.includes('--')) return kept;
  const at = kept.findIndex((token) => token === '--work-id' || token.startsWith('--work-id='));
  const operands = kept.slice(1).filter((token, index, rest) => !token.startsWith('--') && !(index > 0 && rest[index - 1] === '--work-id'));
  if (at < 0 || operands.length) return kept;
  const value = kept[at].includes('=') ? kept[at].slice('--work-id='.length) : kept[at + 1];
  if (!value || value.startsWith('--')) return kept;
  const without = kept.filter((_, index) => index !== at && !(index === at + 1 && !kept[at].includes('=')));
  return [without[0], value, ...without.slice(1)];
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
