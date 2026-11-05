/**
 * What leaves this laptop, and what a model is shown. A shared checkpoint, a published revision and a
 * published split are immutable once pushed, so this is the only cheap moment: every specification
 * publisher sends its exact files through `publishCheckedFiles`, and only what ships is judged. It uses
 * the repository's own secret scanner and shares its waiver, and adds what that scanner cannot judge,
 * links. A value is judged by its shape, so an ordinary specification is not refused for `?auth=true` or
 * a documentation address. A refusal names where to look, how to clear it, and never the value. It fails
 * closed: a scan that breaks shares nothing, and the writing stays saved either way.
 */
import { entropy, redact, SECRET_RULES, scanEntries, WAIVER } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';

const SHOWN_FINDINGS = 3;
/** The scanner's own exemption: a credential pointed at a reserved example host is documentation. */
const reservedExampleHost = (host) => !SECRET_RULES.find((rule) => rule.id === 'url-credentials').accept(host);
export const WITHHELD = '[withheld: looks like a secret]';

/** A parameter named for a credential. Pagination cursors are named for tokens too, and mean nothing to anyone else. */
const CREDENTIAL_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'signature', 'sig', 'jwt', 'auth', 'authorization', 'bearer', 'apikey']);
const NOT_A_CREDENTIAL = new Set(['page', 'next', 'prev', 'continuation', 'cursor', 'sync', 'csrf']);
function credentialName(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase().split(/[-_.]+/u).filter(Boolean);
  if (words.some((word) => NOT_A_CREDENTIAL.has(word))) return false;
  if (words.some((word) => CREDENTIAL_WORDS.has(word))) return true;
  // `key` alone, or an API, access or private key: `?key=PROJ-1` is judged by its value, `?keyboard=` never is.
  const key = words.lastIndexOf('key');
  return key >= 0 && (words.length === 1 || ['api', 'access', 'private', 'secret', 'auth', 'x'].includes(words[key - 1]));
}

/** Whether a value could be a credential: not a placeholder, a plain word or a short flag. */
function credentialShaped(raw) {
  const value = String(raw ?? '').trim();
  if (value.length < 8) return false;
  if (/^(?:<.*>|\{.*\}|\[.*\]|\$.*|%.*%|[.*x_-]+)$/iu.test(value)) return false;
  if (/example|placeholder|redacted|changeme|your[-_]|dummy|sample|fake/iu.test(value)) return false;
  if (/^[a-z]+(?:[-_. ][a-z]+)*$/iu.test(value) && value.length < 20) return false;
  if (/^\d+$/u.test(value) && value.length < 16) return false;
  return entropy(value) >= 2.5;
}

/** An address's parameters, however they were written: repeated, separated by `;` or `&amp;`, in the query or the fragment. */
function linkParameters(link) {
  const at = link.search(/[?#]/u);
  if (at < 0) return [];
  return link.slice(at + 1).replaceAll('&amp;', '&').split(/[&;?#]/u).flatMap((pair) => {
    const equals = pair.indexOf('=');
    if (equals <= 0) return [];
    let value = pair.slice(equals + 1);
    try { value = decodeURIComponent(value); } catch { /* the raw value is what ships */ }
    return [{ name: pair.slice(0, equals), value, raw: pair.slice(equals + 1) }];
  });
}

/** Secrets in the path of a known webhook address: the address is the credential. */
const PATH_SECRET = /^(?:hooks\.slack\.com\/services\/|(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\/|[a-z0-9-]+\.webhook\.office\.com\/webhookb2\/|outlook\.office(?:365)?\.com\/webhook\/)/iu;

/** Every credential a link carries, as `{ label, value }`; a reserved example host carries none. */
export function linkCredentials(link) {
  const shape = /^[a-z][a-z0-9+.-]*:\/\/(?:([^\s/?#@]*)@)?([^\s/?#:@]*)/iu.exec(link);
  if (!shape || reservedExampleHost(shape[2])) return [];
  const found = [];
  if (shape[1] && !shape[1].includes(':') && credentialShaped(shape[1])) found.push({ label: 'an access credential in a link’s address', value: shape[1] });
  if (PATH_SECRET.test(link.slice(link.indexOf('://') + 3))) found.push({ label: 'a webhook address, which is itself a credential', value: link.slice(link.indexOf('://') + 3).split(/[?#]/u)[0].split('/').slice(1).join('/') });
  for (const { name, value, raw } of linkParameters(link)) {
    if (credentialName(name) && credentialShaped(value)) found.push({ label: `an access credential in a link’s '${name}' parameter`, value: raw });
  }
  return found;
}

/** The links in a line. Stops only at what ends an address in prose, and gives back closing punctuation it does not own. */
function linksIn(line) {
  return [...line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/giu)].map(([match]) => {
    let link = match.replace(/[.,:!?]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (link.endsWith(close) && link.split(close).length > link.split(open).length) link = link.slice(0, -1);
    }
    return link.replace(/[.,:!?]+$/u, '');
  });
}

function scanLinks({ path, content }) {
  const findings = [];
  String(content ?? '').split('\n').forEach((line, index) => {
    const waived = WAIVER.test(line);
    for (const link of linksIn(line)) {
      for (const { label, value } of linkCredentials(link)) findings.push({ rule: 'url-credential', label, path, line: index + 1, preview: redact(value), waived });
    }
  });
  return findings;
}

/** Every string under `at`. Parents' clauses are pinned copies of what the state branch already holds, so they are not judged again. */
function textsOf(value, at, entries) {
  if (typeof value === 'string') entries.push({ path: at, content: value, forceScan: true });
  else if (Array.isArray(value)) value.forEach((item, index) => textsOf(item, `${at}[${index}]`, entries));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) if (key !== 'origins') textsOf(item, at ? `${at}.${key}` : key, entries);
  }
  return entries;
}

/** The text of each file exactly as it ships. A record is read field by field, so a line is a line of the writing. */
function shippedTexts(files) {
  return Object.entries(files).flatMap(([file, bytes]) => {
    const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    if (!file.endsWith('.json')) return [{ path: file.split('/').at(-1), content: text, forceScan: true }];
    return textsOf(JSON.parse(text), file.split('/').at(-1).replace(/^[a-f0-9]{64}\.json$/u, 'checkpoint.json'), []);
  });
}

function findingsIn(entries) {
  return [...scanEntries(entries).blocking, ...entries.flatMap(scanLinks).filter((finding) => !finding.waived)];
}

/** Where a finding is, in a person's words, and what clears it. Some fields are history nobody can edit. */
function placeOf({ path, line }, specId) {
  const field = path.replace(/^checkpoint\.json\.draft\./u, '').replace(/^manifest\.json\./u, '').replace(/^research\.json\.items/u, 'research').replace(/^gaps\.json\.events/u, 'gaps');
  if (field.startsWith('split.json')) return { where: 'the split plan', clear: 'Change the plan and propose it again.' };
  if (field === 'spec' || field === 'spec.md') return { where: `line ${line} of the text`, clear: 'Remove the value. If it is only an example, end that line with the scanner’s waiver marker, sflow-allow-secret, then a colon and why it is safe.' };
  if (field === 'title') return { where: 'the title', clear: 'Change the title.' };
  const item = /^(sources|research|proposals|assisted\.findings)\[(\d+)\]/u.exec(field);
  if (item?.[1] === 'sources') return { where: `source ${Number(item[2]) + 1}`, clear: `Remove that source: singularity-flow spec author source ${specId} --remove <SRC-ID>.` };
  if (item?.[1] === 'research') return { where: `research item ${Number(item[2]) + 1}`, clear: `Remove that item: singularity-flow spec author research ${specId} --remove <R-ID>.` };
  if (item?.[1] === 'proposals') return { where: `Copilot suggestion ${Number(item[2]) + 1}`, clear: 'Reject that suggestion; a rejected one is not shared.' };
  if (item?.[1] === 'assisted.findings') return { where: `review finding ${Number(item[2]) + 1}`, clear: 'Settle that finding; a settled one is not shared.' };
  const recorded = { gaps: 'decisions', checklist: 'checklist decisions', 'quality.json': 'quality report', assisted: 'review findings' }[field.split(/[[]|\.(?!json)/u)[0]] ?? 'history';
  return { where: `the recorded ${recorded}`, clear: 'It is history and cannot be edited, so start another draft from your text: singularity-flow spec author new --from <FILE>.' };
}

/** Refuse files a scan cannot clear. `verb` says what did not happen: 'shared' or 'published'. */
export function assertFilesShareable(specId, files, { verb = 'shared', code = 'SPEC_SHARED_DRAFT_SECRET' } = {}) {
  let findings;
  try { findings = findingsIn(shippedTexts(files)); }
  catch (error) {
    throw new SingularityFlowError(`Not ${verb}: this could not be checked for secrets (${error.message}). Your writing is saved on this laptop and nothing left it. Try again; writing can continue.`,
      { code: 'SPEC_SHARE_CHECK_FAILED', cause: error, details: { specId, nextAction: `singularity-flow spec author status ${specId} --json` } });
  }
  if (!findings.length) return;
  const placed = findings.map((finding) => ({ ...finding, ...placeOf(finding, specId) }));
  const shown = placed.slice(0, SHOWN_FINDINGS).map(({ label, where, preview }) => `${label} at ${where} (${preview})`).join('; ');
  const more = placed.length > SHOWN_FINDINGS ? `, and ${placed.length - SHOWN_FINDINGS} more` : '';
  const clears = [...new Set(placed.slice(0, SHOWN_FINDINGS).map(({ clear }) => clear))].join(' ');
  // No "secret:" in this sentence: the host's error scrubber reads that as a credential and blanks the rest.
  throw new SingularityFlowError(`Not ${verb}: this holds something that looks private, ${shown}${more}. Your writing is saved on this laptop and nothing left it; a shared copy could not be taken back. ${clears}`, {
    code, details: { specId, findings: placed.map(({ rule, label, path, line, preview, where }) => ({ rule, label, path, line, preview, where })),
      nextAction: `singularity-flow spec author status ${specId} --json` }
  });
}

/** The one way a specification file reaches the state branch: what ships is judged first. */
export async function publishCheckedFiles(root, ledger, files, message, options, { specId, verb, code }) {
  assertFilesShareable(specId, files, { verb, code });
  const { publishToStateBranch } = await import('../ledger.mjs');
  return publishToStateBranch(root, ledger, files, message, options);
}

/** A person's request or selected wording, before it goes to chat: what would stop it, if anything. */
export function screenText(text) {
  const entries = [{ path: 'text', content: String(text ?? ''), forceScan: true }];
  return findingsIn(entries).map(({ label, line, preview }) => ({ label, line, preview }));
}

/** One text with credential-shaped values replaced, for a model. A line a person waived stays as it is. */
function withholdText(text, counted) {
  return text.split('\n').map((line) => {
    if (WAIVER.test(line)) return line;
    let out = line;
    for (const rule of SECRET_RULES) {
      out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (whole, group) => {
        const value = typeof group === 'string' ? group : whole;
        if (rule.accept && !rule.accept(value)) return whole;
        counted.count += 1;
        // This rule captures the host to judge it; what it holds back is everything before the host.
        return rule.id === 'url-credentials' ? whole.replace(/\/\/[^@]*@/u, `//${WITHHELD}@`) : whole.replace(value, WITHHELD);
      });
    }
    for (const link of linksIn(out)) {
      for (const { value } of linkCredentials(link)) {
        if (out.includes(value)) { out = out.replaceAll(value, WITHHELD); counted.count += 1; }
      }
    }
    return out;
  }).join('\n');
}

/**
 * What `spec author` shows anyone but the person's own page: every string with its secret-shaped values
 * withheld, including a value a person typed, an old source's link and a saved version. The person's
 * Studio asks with --for-person, which an agent is refused.
 */
export function withholdForModel(value) {
  const counted = { count: 0 };
  const walk = (item) => {
    if (typeof item === 'string') return withholdText(item, counted);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return { value: walk(value), withheld: counted.count };
}
