/**
 * Whether a variable, value or argument looks like it carries a secret [RUN amendment §3, and
 * the typed run configurations' `env` rule]. One classifier, so `app suggest` (which never copies
 * a secret) and a start entry's literal `env` (which refuses one) judge a value the same way.
 * Pure: nothing is read or written.
 */
import { looksSecretName } from './environment-declaration.mjs';

export { looksSecretName };

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Whether a value reads like a credential: a JWT, a cloud key, a URL with userinfo, or a long random token. */
export function looksSecretValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.length < 8) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u.test(value)) return true;
  if (/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/u.test(value)) return true;
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\bAIza[0-9A-Za-z_-]{30,}/u.test(value)) return true;
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/iu.test(value)) return true;
  if (/[?&;](?:[^=&\s]*(?:pass|secret|token|key|credential|auth|signature|sig))[^=&\s]*=/iu.test(value)) return true;
  for (const piece of value.split(/[\s,;]+/u)) {
    if (piece.length < 20 || !/^[A-Za-z0-9+/=_\-.~]+$/u.test(piece)) continue;
    // A dotted name such as a Java class (com.example.shop.Api2Main) is an identifier, not a token,
    // and so is an option with a value (-Dfile.encoding=UTF-8); base64 padding only ends a token.
    if (/^(?:[a-z][a-z0-9]*\.)+[A-Za-z_$][\w$]*$/u.test(piece) || /=[^=]/u.test(piece)) continue;
    if (/^[0-9a-f]{32,}$/iu.test(piece)) return true;
    const upper = /[A-Z]/u.test(piece);
    const lower = /[a-z]/u.test(piece);
    const digit = /\d/u.test(piece);
    const score = entropy(piece);
    if ((upper && lower && digit && score >= 3.5) || ((upper || lower) && digit && score >= 4.2)) return true;
  }
  return false;
}

/** A variable as environments.yml would declare it: a secret has a name only. */
export function classifyVariable(name, rawValue, { reference = false } = {}, secrets = new Set()) {
  const value = String(rawValue ?? '');
  if (looksSecretName(name) || looksSecretValue(value)) {
    if (value.length >= 4) secrets.add(value);
    return { name, kind: 'secret' };
  }
  if (reference || !value) return { name, kind: 'flag' };
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && value.length <= 2_048) {
      return { name, kind: 'endpoint', value };
    }
  } catch { /* not a URL */ }
  if (value.length > 256 || value.includes('\u0000')) return { name, kind: 'flag' };
  return { name, kind: 'flag', default: value };
}
