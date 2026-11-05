/**
 * Whether a setting in a shared config file holds a real value (docs/SPEC-ENVIRONMENT-FILES-v2.md), and
 * what a link carries. People write these unquoted, which the scanner's assignment rule cannot see. The
 * name and the value both have to say so, because a check that cries wolf gets waved through.
 */
import { configShapedPath } from './local-config-policy.mjs';

/** A commit refuses a new value. `SINGULARITY_FLOW_CONFIG_VALUES=warn` holds that off for a team that needs time. */
export const CONFIG_VALUES_DEFAULT = 'refuse';
export const configValuesRefused = (env = process.env) => (env.SINGULARITY_FLOW_CONFIG_VALUES || CONFIG_VALUES_DEFAULT) === 'refuse';

const MAXIMUM_LINE = 4_096;

/** Shannon entropy in bits per character. */
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

/** RFC 2606 and RFC 6761 hosts: a credential pointed at one is documentation. */
export const reservedExampleHost = (host) => /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/iu.test(String(host ?? ''));

const wordsOf = (name) => String(name).replace(/([a-z0-9])([A-Z])|([A-Z])([A-Z][a-z])/gu, (_, a, b, c, d) => (a ? `${a}_${b}` : `${c}_${d}`)).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);

/** A parameter named for a credential. Pagination cursors are named for tokens too, and mean nothing to anyone else. */
const CREDENTIAL_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'signature', 'sig', 'jwt', 'auth', 'authorization', 'bearer', 'apikey']);
const NOT_A_CREDENTIAL = new Set(['page', 'next', 'prev', 'continuation', 'cursor', 'sync', 'csrf']);
function credentialName(name) {
  const words = wordsOf(name);
  if (words.some((word) => NOT_A_CREDENTIAL.has(word))) return false;
  if (words.some((word) => CREDENTIAL_WORDS.has(word))) return true;
  // `key` alone, or an API, access or private key: `?key=PROJ-1` is judged by its value, `?keyboard=` never is.
  const key = words.lastIndexOf('key');
  return key >= 0 && (words.length === 1 || ['api', 'access', 'private', 'secret', 'auth', 'x'].includes(words[key - 1]));
}

/** Whether a link's value could be a credential: not a placeholder, a plain word or a short flag. */
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
  // `token@host`, and `:password@host`, which the scanner's user-and-password rule does not see.
  if (shape[1] && (!shape[1].includes(':') || shape[1].startsWith(':')) && credentialShaped(shape[1].replace(/^:/u, ''))) found.push({ label: 'an access credential in a link’s address', value: shape[1] });
  if (PATH_SECRET.test(link.slice(link.indexOf('://') + 3))) found.push({ label: 'a webhook address, which is itself a credential', value: link.slice(link.indexOf('://') + 3).split(/[?#]/u)[0].split('/').slice(1).join('/') });
  for (const { name, value, raw } of linkParameters(link)) {
    if (credentialName(name) && credentialShaped(value)) found.push({ label: `an access credential in a link’s '${name}' parameter`, value: raw });
  }
  return found;
}

const SETTING_WORD = /(?:password|passwd|passphrase|secret|token|apikey|credentials?|jwt|bearer|salt)$|^(?:pass|pwd)$/u;
const WEAK_WORDS = new Set(['key', 'auth']);
const ENV_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'pass', 'credential', 'credentials', 'auth']);
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'auth', 'signing', 'encryption', 'client', 'x', 'account', 'shared']);
// `password_prod` and `password2` name the same thing as `password`.
const ENVIRONMENT_WORDS = new Set(['prod', 'production', 'dev', 'development', 'test', 'uat', 'qa', 'stage', 'staging', 'local', 'old', 'new']);
const NOT_A_VALUE = /^(?:<.*>|\{.*\}|\[.*\]|\$\{.*\}|%.*%|@.*@?|__.*__|[.*x_-]+|~?\.{0,2}\/.*|true|false|yes|no|on|off|null|none|nil|undefined|enabled|disabled|required|optional|\d{1,15})$/iu;
/** Encrypted, or a pointer to where the secret really lives. */
const STORED_ELSEWHERE = /^(?:(?:ENC|DEC)[([].*[)\]]|\{cipher\}.*|(?:vault|arn|ssm|sm|kms|secretsmanager|azurekeyvault|sops|op|ref|env|file|classpath)[:+].*)$/iu;
const WRITTEN_AS_A_PLACEHOLDER = /example|placeholder|redacted|change[-_]?me|your[-_]|dummy|sample|fake|xxx/iu;
const EMBEDDED_CREDENTIAL = /(?:^|[;?&\s])(?:password|pwd|accountkey|sharedaccesskey|sharedaccesssignature)\s*=\s*([^;&\s]+)/iu;
const AUTHORIZATION = /^(?:basic|bearer|token)\s+(\S{8,})$/iu;
/** A file or a store path: `certs/client.key`, `kv/data/app`. */
const A_PATH = /^[\w.-]+(?:\/[\w.-]+)*\.(?:key|pem|crt|cer|p12|pfx|jks|json|ya?ml|txt|env|properties)$|^[a-z0-9_-]+(?:\/[a-z0-9_-]+)+$/u;

/** A word such as a label, a name or a constant, not a credential: `Password`, `prod-db-2`, `my-secret-v2`, `DB_CREDENTIALS`. */
const namedLikeAThing = (value) => /^[A-Z]?[a-z]+$/u.test(value) || /^[A-Z]+(?:_[A-Z0-9]+)+$/u.test(value)
  || /^[a-z]+\d{0,4}(?:[-_.](?:[a-z]+\d{0,4}|\d{1,4}))+$/u.test(value);
// A token has a digit and no run of whole words: `build-cache-v2-linux-x64-22` is a cache's name, a UUID is not.
const tokenShaped = (value) => /^[A-Za-z0-9+/=_-]{20,}$/u.test(value) && /\d/u.test(value) && entropy(value) >= 3.5
  && !namedLikeAThing(value) && !/^[a-z0-9]+(?:[-_.][a-z0-9]+){2,}$/u.test(value.split(/[-_.]/u).some((part) => /^[a-z]{4,}$/u.test(part)) ? value : '');

function realValue(value) {
  // `$DB_PASSWORD` is a reference, and `$ecr3tP4ss` is not.
  if (/\s/u.test(value) || /^\$[A-Z_][A-Z0-9_]*$/u.test(value) || NOT_A_VALUE.test(value) || STORED_ELSEWHERE.test(value) || WRITTEN_AS_A_PLACEHOLDER.test(value) || A_PATH.test(value)) return false;
  // A local fixture, not a credential. A long random value with "test" in it is still judged.
  return !(/test/iu.test(value) && value.length < 20);
}

/**
 * Whether one setting holds a real value. `value` is the setting's text, already unquoted. An env-style
 * file holds little else, so its names are read more widely and a token's shape counts under any name.
 */
export function settingHoldsSecret(name, value, { envStyle = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  // `${NAME:default}` and `${NAME:-default}`: the reference is fine, its default is what ships.
  const reference = /^\$\{[^:}]*:[-=]?([^}]*)\}$/u.exec(text);
  if (reference) return settingHoldsSecret(name, reference[1], { envStyle });
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return linkCredentials(text).length > 0;
  const embedded = EMBEDDED_CREDENTIAL.exec(text);
  if (embedded) return realValue(embedded[1]) && embedded[1].length >= 4;
  const authorization = AUTHORIZATION.exec(text);
  if (authorization) return realValue(authorization[1]);
  if (!realValue(text)) return false;
  const words = wordsOf(name);
  if (words.includes('public')) return false;
  while (words.length > 1 && ENVIRONMENT_WORDS.has(words.at(-1))) words.pop();
  const last = words.at(-1)?.replace(/\d+$/u, '');
  if (envStyle && words.some((word) => ENV_WORDS.has(word))) return ENV_WORDS.has(last) ? text.length >= 6 || last === 'key' || last === 'auth' : !namedLikeAThing(text);
  if (SETTING_WORD.test(last) || (last === 'key' && KEY_QUALIFIERS.has(words.at(-2)))) return text.length >= 6 && !namedLikeAThing(text);
  return (envStyle || words.some((word) => SETTING_WORD.test(word) || WEAK_WORDS.has(word))) && tokenShaped(text);
}

/** The setting's text: inside its quotes, or up to a trailing comment. */
function settingText(raw) {
  const text = String(raw ?? '').trim();
  const quoted = /^(["'])(.*?)\1/u.exec(text);
  if (quoted) return quoted[2];
  if (text.startsWith('#')) return '';
  // A YAML anchor or tag is not the value: `&pw Xq7m…`, `!!str Xq7m…`.
  return text.replace(/\s+(?:#|;|\/\/).*$/u, '').replace(/,$/u, '').replace(/^(?:[&!]\S*\s+)+/u, '').trim();
}

const SETTING_LINE = /^\s*(?:-\s+)?(?:export\s+)?["']?([A-Za-z_][\w.\-[\]]*)["']?\s*[:=]\s*(.*)$/u;
const JSON_PAIR = /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/gu;

/** Each setting on one line, as `[name, text]`. */
function settingsIn(line, json) {
  if (json) return [...line.matchAll(JSON_PAIR)].map(([, name, value]) => [name, value]);
  if (/^\s*(?:#|;|!|\/\/)/u.test(line)) return [];
  const setting = SETTING_LINE.exec(line);
  return setting ? [[setting[1], settingText(setting[2])]] : [];
}

/** Every setting holding a real value in a shared config file, as `{ name, value, line }`. Any other file has none. */
export function configValueFindings(filePath, content) {
  if (!configShapedPath(filePath)) return [];
  const json = /\.json$/iu.test(String(filePath));
  const envStyle = /(?:^|\/)\.env|\.env$/iu.test(String(filePath));
  const found = [];
  // A Kubernetes or Compose `- name: DB_PASSWORD` names the `value:` on the next line.
  let listedName = null;
  String(content ?? '').split(/\r?\n/u).forEach((line, index) => {
    if (!json && line.length > MAXIMUM_LINE) return;
    for (const [written, value] of settingsIn(line, json)) {
      const name = written === 'value' && listedName ? listedName : written;
      listedName = written === 'name' ? value : null;
      if (settingHoldsSecret(name, value, { envStyle })) found.push({ name, value, line: index + 1 });
    }
  });
  return found;
}
