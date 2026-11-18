/**
 * Invented credentials for tests, built from parts when a test runs. Push protection on the office
 * mirrors (GitHub secret scanning with company patterns) refuses any file holding a credential-shaped
 * value, so the repository never holds one whole: each test value is joined from pieces here and is
 * byte-identical to the literal it replaced. test/no-secret-literals.test.mjs keeps new ones out.
 */

/** Joins the pieces of one invented value: `invented('gh', 'p_ABC…')` is the token the test means. */
export function invented(...parts) {
  return parts.join('');
}

/** base64url without padding, as a JWT segment is written. */
export function base64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** An invented JWT: the header and payload objects encoded as JSON, then the signature segment as written. */
export function inventedJwt(header, payload, signature) {
  return [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload)), signature].join('.');
}
