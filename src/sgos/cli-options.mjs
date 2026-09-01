/**
 * Closed option vocabulary for the SGOS shell surface.
 *
 * The product-wide argument reader is intentionally permissive for compatibility with the older
 * lifecycle CLI. SGOS is a smaller fail-closed surface: every command action declares the options
 * it consumes, so a misspelling cannot silently turn a requested constraint into an unconstrained
 * execution.
 */
import { SingularityFlowError } from '../util.mjs';

const GLOBAL = Object.freeze(['json', 'timings']);
const PLATFORM_IDENTITY_CLAIMS = Object.freeze([
  'actor', 'reviewer', 'activated-by', 'revoked-by'
]);

function optionSet(...specific) {
  return Object.freeze([...new Set([...GLOBAL, ...specific])].sort());
}

const CAS = Object.freeze(['expected-revision', 'expected-state-sha256']);
const STORE = Object.freeze(['store']);
const PACK_READ = Object.freeze([...STORE, 'trust']);
const PLATFORM_MUTATION = Object.freeze([...CAS, ...PLATFORM_IDENTITY_CLAIMS]);

/** One exact option contract for every action registered as an SGOS operation. */
export const SGOS_CLI_OPTIONS = Object.freeze({
  intent: Object.freeze({
    capture: optionSet('out'),
    packet: optionSet('answers', 'out'),
    confirm: optionSet('answers', 'confirm', 'confirmed-at', 'out'),
    workflow: optionSet('policy', 'declaration', 'out'),
    'ratification-packet': optionSet(
      'workflow', 'policy', 'registry', 'storage-profile-sha256', 'coverage', 'out'
    ),
    ratify: optionSet(
      'workflow', 'policy', 'registry', 'storage-profile-sha256', 'coverage',
      'confirm', 'decided-at', 'out'
    ),
    show: optionSet(),
    validate: optionSet(),
    compile: optionSet('workflow', 'ratification', 'policy', 'registry', 'out')
  }),
  program: Object.freeze({
    show: optionSet(),
    validate: optionSet(),
    explain: optionSet(),
    simulate: optionSet(),
    'what-if': optionSet('without-device'),
    'fault-plan': optionSet('target', 'failure'),
    approve: optionSet('confirm', 'approved-at')
  }),
  process: Object.freeze({
    list: optionSet(),
    status: optionSet(),
    graph: optionSet(),
    fsck: optionSet(),
    start: optionSet(
      'compiler-request', 'binding', 'subject', 'subject-kind', 'process-id',
      'intent', 'workflow', 'ratification', 'policy', 'registry'
    ),
    step: optionSet('allow-model', 'expected-revision'),
    run: optionSet('maximum-parallel', 'allow-model', 'expected-revision'),
    pause: optionSet('expected-revision'),
    stop: optionSet('expected-revision'),
    resume: optionSet('confirm', 'expected-revision'),
    recover: optionSet('attempt-id', 'resolution', 'confirm'),
    replay: optionSet('from', 'confirm'),
    fork: optionSet('from', 'label', 'confirm'),
    quarantine: optionSet('confirm'),
    archive: optionSet('confirm')
  }),
  policy: Object.freeze({
    status: optionSet(),
    fsck: optionSet(),
    plan: optionSet('invalidate-process'),
    apply: optionSet('invalidate-process', 'expected-revision', 'confirm')
  }),
  task: Object.freeze({
    list: optionSet(),
    show: optionSet(),
    evidence: optionSet(),
    retry: optionSet('confirm')
  }),
  request: Object.freeze({
    list: optionSet('process'),
    show: optionSet('process'),
    // `authority` is deliberately recognized here so the command can return its stronger,
    // security-specific refusal instead of reducing an attempted self-grant to a typo.
    respond: optionSet(
      'process', 'option', 'decision', 'confirm', 'input-json', 'sensitive-handle', 'authority',
      'expected-revision', 'expected-process-sha256'
    )
  }),
  evidence: Object.freeze({
    export: optionSet('out'),
    verify: optionSet()
  }),
  candidate: Object.freeze({
    list: optionSet(),
    show: optionSet(),
    'diff-argv': optionSet(),
    freeze: optionSet('subject'),
    verify: optionSet('commands', 'timeout-ms'),
    publish: optionSet('target-branch', 'remote', 'confirm')
  }),
  'execution-unit': Object.freeze({
    list: optionSet(),
    doctor: optionSet()
  }),
  device: Object.freeze({
    list: optionSet(),
    doctor: optionSet(),
    intent: optionSet(),
    result: optionSet(),
    invoke: optionSet('request'),
    recover: optionSet('request'),
    revoke: optionSet('reason', 'confirm')
  }),
  'authority-store': Object.freeze({
    init: optionSet(...STORE),
    status: optionSet(...STORE),
    verify: optionSet(...STORE),
    recover: optionSet(...STORE, 'confirm'),
    'signer-create': optionSet(...STORE, 'signer'),
    export: optionSet(...STORE, 'out', 'signer'),
    inspect: optionSet(...STORE),
    import: optionSet(...STORE, 'confirm'),
    rollback: optionSet(...STORE, 'receipt', 'confirm')
  }),
  pack: Object.freeze({
    list: optionSet(...PACK_READ),
    active: optionSet(...PACK_READ),
    show: optionSet(...PACK_READ),
    propose: optionSet(...PACK_READ, 'signed-pack', ...PLATFORM_MUTATION),
    review: optionSet(...PACK_READ, 'review', ...PLATFORM_MUTATION),
    activate: optionSet(
      ...PACK_READ, 'domain', 'pack', 'review-sha256', 'confirm', ...PLATFORM_MUTATION
    ),
    revoke: optionSet(...PACK_READ, 'pack', 'confirm', 'reason', ...PLATFORM_MUTATION)
  }),
  learn: Object.freeze({
    list: optionSet(...PACK_READ, 'role', 'pack'),
    show: optionSet(...PACK_READ, 'role', 'pack'),
    start: optionSet(...PACK_READ, 'role', 'pack', 'module'),
    inspect: optionSet(...PACK_READ, 'role', 'pack', 'module'),
    'explain-change': optionSet(...PACK_READ, 'role', 'pack', 'module'),
    quiz: optionSet(...PACK_READ, 'role', 'pack', 'module', 'answers'),
    'teach-back': optionSet(...PACK_READ, 'role', 'pack', 'module', 'answers')
  }),
  memory: Object.freeze({
    inspect: optionSet(...STORE),
    dependencies: optionSet(...STORE),
    register: optionSet(...STORE, 'candidate', ...PLATFORM_MUTATION),
    promote: optionSet(...STORE, 'confirm', 'reason', ...PLATFORM_MUTATION)
  }),
  'meta-tool': Object.freeze({
    list: optionSet(...STORE),
    propose: optionSet(
      ...STORE, 'trace-trust', 'evaluator-trust', 'candidate', 'traces', ...PLATFORM_MUTATION
    ),
    evaluation: optionSet(
      ...STORE, 'trace-trust', 'evaluator-trust', 'evaluation', ...PLATFORM_MUTATION
    ),
    promote: optionSet(
      ...STORE, 'trace-trust', 'evaluator-trust',
      'candidate-sha256', 'evaluation-sha256', 'confirm-candidate', 'confirm-evaluation',
      'decision', 'reason', ...PLATFORM_MUTATION
    )
  })
});

/**
 * Refuse unknown SGOS options before a handler reads repository or operational state.
 *
 * `--out` has an established, explicit refusal on non-authoring actions. Keep that diagnostic while
 * moving it before execution; in particular, it must never be discovered only after a mutating
 * Process action has completed.
 */
export function validateSgosCliOptions(command, action, options = {}) {
  const available = SGOS_CLI_OPTIONS[command]?.[action];
  if (!available) {
    throw new SingularityFlowError(`SGOS option contract is missing for '${command} ${action}'.`, {
      code: 'SGOS_OPTION_CONTRACT_MISSING', details: { command, action }
    });
  }
  const supportsOutput = (command === 'intent' && [
    'capture', 'packet', 'confirm', 'workflow', 'ratification-packet', 'ratify', 'compile'
  ].includes(action)) || (command === 'evidence' && action === 'export')
    || (command === 'authority-store' && action === 'export');
  if (Object.hasOwn(options, 'out') && !supportsOutput) {
    throw new SingularityFlowError(
      `--out is not supported by ${command}.${action}; it is available only for Intent record authoring, Process Evidence export, and signed Authority Store export.`,
      { code: 'SGOS_OUTPUT_NOT_SUPPORTED', details: { operation: `${command}.${action}` } }
    );
  }
  const accepted = new Set(available);
  const unknown = Object.keys(options).filter((key) => !accepted.has(key)).sort();
  if (!unknown.length) return;
  const rendered = unknown.map((key) => `--${key}`);
  throw new SingularityFlowError(
    `${unknown.length === 1 ? 'Unknown option' : 'Unknown options'} ${rendered.map((key) => `'${key}'`).join(', ')}`
      + ` for '${command} ${action}'. Available: ${available.map((key) => `--${key}`).join(', ')}.`,
    {
      code: 'SGOS_UNKNOWN_OPTION',
      details: { command, action, unknown: rendered, available: available.map((key) => `--${key}`) }
    }
  );
}
