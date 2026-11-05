/**
 * The check before a draft leaves this laptop, for a shared checkpoint and a published revision alike.
 * Both are immutable once pushed, so this is the only cheap moment. It uses the repository's own secret
 * scanner and shares its waiver; a refusal names where to look and never the value. It fails closed:
 * a scan that breaks shares nothing, and the writing stays saved either way.
 */
import { credentialUrlParameter } from '../documents-read.mjs';
import { redact, scanEntries, WAIVER } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';

const SHOWN_FINDINGS = 3;

/**
 * Links in a text that carry a credential parameter with a real-looking value, as findings of the same
 * shape as the scanner's. A placeholder (`?token=<TOKEN>`, `?sig=...`) is how documentation writes one.
 * Not a scanner rule: a commit scan is not where a URL's meaning is judged.
 */
function scanCredentialUrls(content, { path: filePath }) {
  const findings = [];
  String(content ?? '').split('\n').forEach((line, index) => {
    const waiver = WAIVER.exec(line);
    for (const [link] of line.matchAll(/\bhttps?:\/\/[^\s"'`<>()[\]]+/giu)) {
      let parsed;
      try { parsed = new URL(link); } catch { continue; }
      const name = credentialUrlParameter(parsed);
      if (!name) continue;
      const value = parsed.searchParams.get(name) ?? new URLSearchParams(parsed.hash.replace(/^#/u, '')).get(name) ?? '';
      if (!value.trim() || /^(?:[.*x]+|\{.*\}|\$.*)$/iu.test(value)) continue;
      findings.push({ rule: 'url-credential-parameter', label: `an access credential in a link's '${name}' parameter`,
        path: filePath, line: index + 1, preview: redact(value), waived: Boolean(waiver) });
    }
  });
  return findings;
}

/** Every string a draft holds, each under a name a person can follow. */
function draftTexts(value, at, entries) {
  if (typeof value === 'string') entries.push({ path: at, content: value, forceScan: true });
  else if (Array.isArray(value)) value.forEach((item, index) => draftTexts(item, `${at}[${index}]`, entries));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) draftTexts(item, at ? `${at}.${key}` : key, entries);
  return entries;
}

const place = ({ path, line }) => (path === 'spec' ? `line ${line} of the text` : path === 'title' ? 'the title' : path);

/** Refuse a draft a scan cannot clear. `verb` says what did not happen: 'shared' or 'published'. */
export function assertDraftShareable(specId, draft, { verb = 'shared', code = 'SPEC_SHARED_DRAFT_SECRET' } = {}) {
  let blocking;
  try {
    const entries = draftTexts(draft, '', []);
    blocking = [...scanEntries(entries).blocking, ...entries.flatMap((entry) => scanCredentialUrls(entry.content, { path: entry.path })).filter((finding) => !finding.waived)];
  } catch (error) {
    throw new SingularityFlowError(`Not ${verb}: this draft could not be checked for secrets (${error.message}). Your writing is saved on this laptop and nothing left it. Try again; writing can continue.`,
      { code: 'SPEC_SHARE_CHECK_FAILED', cause: error, details: { specId, nextAction: `singularity-flow spec author status ${specId} --json` } });
  }
  if (!blocking.length) return;
  const shown = blocking.slice(0, SHOWN_FINDINGS).map((finding) => `${finding.label} at ${place(finding)} (${finding.preview})`).join('; ');
  const more = blocking.length > SHOWN_FINDINGS ? `, and ${blocking.length - SHOWN_FINDINGS} more` : '';
  // No "secret:" here, and the waiver is in words: the error scrubber reads either as a credential and blanks the rest.
  throw new SingularityFlowError(`Not ${verb}: this draft holds something that looks private, ${shown}${more}. Your writing is saved on this laptop and nothing left it; a shared copy could not be taken back. Remove the value. If it is only an example, end that line with the scanner's waiver marker, sflow-allow-secret, then a colon and why it is safe.`, {
    code, details: { specId, findings: blocking.map(({ rule, label, path, line, preview }) => ({ rule, label, path, line, preview })),
      nextAction: `singularity-flow spec author status ${specId} --json` }
  });
}
