/**
 * Refusing to commit a secret.
 *
 * A credential that reaches a commit is not undone by deleting it in the next one: it is in the
 * history, on every clone, and in whatever mirrored it. The only cheap moment is before the commit
 * exists, so this runs at the one place every governed commit passes through and says no.
 *
 * Three properties matter more than clever detection:
 *
 *   - **It fails closed.** A scanner that cannot read a file, or that throws, refuses the commit. A
 *     secret check that quietly passes when it breaks is worse than none, because people stop
 *     looking.
 *   - **It never prints the secret.** Findings carry a redacted preview. A refusal that echoes the
 *     credential into a terminal, a CI log and a scrollback buffer has published it more widely than
 *     the commit would have.
 *   - **A waiver is explicit, local and reasoned.** Real repositories contain example keys and test
 *     fixtures. The escape hatch is a comment on the offending line with a reason, so it appears in
 *     the diff, is reviewed with the change, and cannot be set once in a config file and forgotten.
 *
 * Detection is deliberately conservative. Every rule here matches a credential format that is
 * recognisable on sight — a provider prefix, a key armour header — plus one entropy-gated rule for
 * assignments that look like `password = "..."`. Broad guessing produces noise, and a check people
 * routinely override is a check that is not running.
 */
import { SingularityFlowError } from './util.mjs';

/**
 * The waiver marker.
 *
 * A reason is required rather than optional: `sflow-allow-secret` alone would become a reflex, and
 * the reason is what a reviewer reads when deciding whether the line is really an example.
 */
export const WAIVER = /sflow-allow-secret:\s*(\S.*?)\s*$/;

/**
 * How much of a match is safe to show.
 *
 * Enough to find the line, never enough to use. Four leading characters identifies which credential
 * is meant when several are present; the rest is the length only, because "how long was it" helps
 * nobody impersonate anything.
 */
export function redact(value) {
  const text = String(value ?? '');
  if (text.length <= 8) return `${'*'.repeat(text.length)}`;
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(12, text.length - 4))} (${text.length} chars)`;
}

/** Shannon entropy in bits per character: high for random secrets, low for prose and identifiers. */
export function entropy(value) {
  const text = String(value ?? '');
  if (!text.length) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * The rules.
 *
 * `id` is stable and is what a waiver and a report name. `severity` is `certain` for formats that
 * cannot plausibly be anything else, and `likely` for the entropy-gated shapes where a human should
 * look. Both refuse a commit; the distinction is what the message says, because "this is definitely
 * an AWS key" and "this looks like a password" deserve different sentences.
 */
export const SECRET_RULES = Object.freeze([
  { id: 'private-key', severity: 'certain', label: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'aws-access-key', severity: 'certain', label: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', severity: 'certain', label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'slack-token', severity: 'certain', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Named by format, not by vendor: this repository does not carry vendor names, and the pattern
  // documents which provider it is more precisely than a label would.
  { id: 'model-provider-key', severity: 'certain', label: 'model provider API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', severity: 'certain', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { id: 'google-api-key', severity: 'certain', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token', severity: 'certain', label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'stripe-key', severity: 'certain', label: 'Stripe secret key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'jwt', severity: 'likely', label: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  /**
   * Credentials inside a URL. A remote whose host is prefixed with a user and password is the
   * commonest way a token reaches a repository, and it looks like no key to any prefix rule.
   */
  {
    id: 'url-credentials',
    severity: 'certain',
    label: 'credentials in a URL',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@([^\s/:?#]+)/g,
    /**
     * A credential pointed at a reserved example domain is documentation.
     *
     * RFC 2606 and RFC 6761 set aside `example.com`, `.test`, `.invalid` and `localhost` precisely so
     * they can be written down. This repository's own tests use them to assert that embedded
     * credentials are *refused* — the tests proving the guard works looked exactly like the thing
     * the guard forbids.
     *
     * The host is what is checked, not the password, so a real credential pointed at a real host is
     * still caught however innocuous it looks.
     */
    accept(host) {
      return !/(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i.test(String(host ?? ''));
    }
  },
  {
    id: 'assigned-secret',
    severity: 'likely',
    label: 'assigned credential',
    // `password = "…"`, `api_key: '…'`, `SECRET_TOKEN="…"`. The value is captured so entropy can
    // decide, because `password = "changeme"` in a test fixture is not a leak and `password =
    // "Xq7#mA2..."` is.
    /**
     * No leading `\b`. `_` is a word character, so `\bpassword` never matches `db_password` — and
     * `db_password`, `API_KEY` and `client_secret` are the forms people actually write. The boundary
     * looked right and silently exempted the common case.
     */
    pattern: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/gi,
    /**
     * The value has to look random. Placeholders, references and obvious examples do not.
     *
     * Without this the rule fires on `password: "${DB_PASSWORD}"`, on `token: "your-token-here"`,
     * and on every documentation snippet — and a check that cries wolf on documentation is one
     * people learn to wave through.
     */
    accept(value) {
      if (/^\$?\{?\{?[A-Z][A-Z0-9_]*\}?\}?$/.test(value)) return false;       // ${ENV_VAR}
      if (/^<[^>]+>$/.test(value)) return false;                              // <your-token>
      if (/(?:example|placeholder|redacted|changeme|xxx+|your[-_]|dummy|sample|fake|test)/i.test(value)) return false;
      if (/^[*.]+$/.test(value)) return false;                                // ****
      /**
       * Whitespace means prose, not a credential.
       *
       * Entropy alone does not separate them: `the quick brown fox` scores above 3.4, so
       * `password: "see the docs for how to set this"` would be reported and the rule would be
       * waved through by everyone. Credentials essentially never contain spaces.
       *
       * The cost is a space-separated passphrase, which this rule will miss. That is the right
       * trade: the provider-format rules above catch real keys whatever they contain, and a rule
       * that fires on sentences is a rule that gets disabled.
       */
      if (/\s/.test(value)) return false;
      /**
       * An identifier or a path is not a credential.
       *
       * Every false positive this rule produced on its own repository was one of these: a
       * SecretStorage *key name* (`singularityFlow.jira.token`), a fixture id
       * (`singularity-flow-visual-fixture`), and a file path
       * (`singularity/work-items/REF-1/context/session.json`). All assigned to a variable called
       * `token` or `secret`, all above the entropy threshold, none of them secret.
       *
       * A path contains a separator. An identifier is words joined by single dots, dashes or
       * underscores. Real credentials are dense runs of mixed characters and do not decompose into
       * pronounceable segments.
       *
       * The cost is a passphrase-style password like `correct-horse-battery`, which this will miss —
       * the same trade as whitespace above, and for the same reason: a rule that fires on every key
       * name in the codebase is a rule that gets turned off.
       */
      if (value.includes('/') || value.includes('\\')) return false;
      if (/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+$/.test(value)) return false;
      return entropy(value) >= 3.4;
    }
  }
]);

/**
 * Files whose content is not worth scanning.
 *
 * Binary and lockfiles only. Deliberately not a list of "safe" directories: `test/` is exactly where
 * a real key gets pasted "just to check", and exempting it would put the blind spot where the risk
 * is.
 */
const SKIP_PATH = /(?:^|\/)(?:node_modules|\.git)\/|\.(?:png|jpg|jpeg|gif|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|vsix)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

export function scannablePath(filePath) {
  return !SKIP_PATH.test(String(filePath ?? ''));
}

/**
 * Every finding in one file's content.
 *
 * Line-by-line so a finding can name a line and so a waiver can sit on the line it excuses. A
 * waiver on a line suppresses every rule on that line: a line with two credentials is one mistake
 * with one reason, and demanding a marker per rule would push people toward a blanket ignore.
 */
export function scanText(content, { path: filePath = '<input>' } = {}) {
  const findings = [];
  const lines = String(content ?? '').split('\n');
  lines.forEach((line, index) => {
    const waiver = WAIVER.exec(line);
    for (const rule of SECRET_RULES) {
      // Regexes are `g` and therefore stateful; a shared `lastIndex` would make the second file
      // scanned start mid-line and miss what the first one found.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const value = match[1] ?? match[0];
        if (rule.accept && !rule.accept(value)) continue;
        findings.push(Object.freeze({
          rule: rule.id,
          label: rule.label,
          severity: rule.severity,
          path: filePath,
          line: index + 1,
          // Never the value. Everything a reader needs to find it, nothing they need to use it.
          preview: redact(value),
          waived: Boolean(waiver),
          reason: waiver?.[1] ?? null
        }));
      }
    }
  });
  return findings;
}

/**
 * Scan a set of `{ path, content }` entries.
 *
 * Content is passed in rather than read here, so the caller decides what is being scanned — the
 * staged blob, the working tree, a commit's tree — and the scanner cannot be pointed at the wrong
 * one by accident.
 */
export function scanEntries(entries = []) {
  const findings = [];
  const skipped = [];
  for (const entry of entries) {
    const filePath = String(entry?.path ?? '');
    if (!scannablePath(filePath)) { skipped.push(filePath); continue; }
    if (typeof entry?.content !== 'string') {
      // Fail closed: a file that could not be read is not a file that is known to be clean.
      throw new SingularityFlowError(
        `Cannot scan '${filePath}' for secrets: its content was not readable. The commit is refused because an unscannable file is not a scanned file.`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    findings.push(...scanText(entry.content, { path: filePath }));
  }
  return Object.freeze({
    resultType: 'secret-scan',
    schemaVersion: 1,
    findings: Object.freeze(findings),
    /** What must stop a commit, as opposed to what was reviewed and excused on the line. */
    blocking: Object.freeze(findings.filter((finding) => !finding.waived)),
    waived: Object.freeze(findings.filter((finding) => finding.waived)),
    skipped: Object.freeze(skipped),
    scanned: entries.length - skipped.length,
    clean: findings.every((finding) => finding.waived)
  });
}

/**
 * What the refusal says.
 *
 * Names the file and line, what was found, and how to proceed either way — remove it, or waive it
 * with a reason. A refusal that only says "secrets detected" sends people looking for a way to turn
 * the check off.
 */
export function secretRefusal(scan) {
  if (!scan.blocking.length) return null;
  const lines = [
    `Refused: ${scan.blocking.length} possible secret${scan.blocking.length === 1 ? '' : 's'} in the content about to be committed.`,
    ''
  ];
  for (const finding of scan.blocking) {
    lines.push(`  ${finding.path}:${finding.line} — ${finding.label} [${finding.rule}] ${finding.preview}`);
  }
  lines.push(
    '',
    'A credential in a commit is in the history on every clone, and deleting it later does not remove it.',
    'Remove the value and use a secret store, or — if this is genuinely an example — mark the line:',
    '',
    '    # sflow-allow-secret: <why this is not a real credential>',
    '',
    'The marker is per line and needs a reason, so it appears in the diff and is reviewed with the change.'
  );
  if (scan.waived.length) {
    lines.push('', `${scan.waived.length} finding(s) already carry a waiver and were allowed.`);
  }
  return lines.join('\n');
}
