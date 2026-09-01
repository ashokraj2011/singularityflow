/** Credential Human Requests may persist only an opaque Secret Broker reference, never a value. */
import { scanText } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';

const MAXIMUM_BROKER_REFERENCE_BYTES = 256;
const BROKER_REFERENCE = /^broker:\/\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;

function refuse(message, code, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

/**
 * Validate a value-free handle to an external broker.
 *
 * The closed grammar prevents an inline URL, query, fragment, user-info, empty path segment, or
 * encoded payload from masquerading as a broker handle. The repository secret scanner remains the
 * authority for provider-shaped values. Findings expose stable rule IDs only; the candidate value
 * is never copied into an error, diagnostic, or durable record.
 */
export function assertAutoCredentialBrokerReference(value, {
  invalidCode = 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID',
  secretCode = 'AUTO_HUMAN_REQUEST_SECRET_REFUSED'
} = {}) {
  if (typeof value !== 'string' || value !== value.trim()
      || Buffer.byteLength(value, 'utf8') > MAXIMUM_BROKER_REFERENCE_BYTES
      || !BROKER_REFERENCE.test(value)) {
    refuse(
      'Credential responses require one opaque broker:// reference without inline credential material.',
      invalidCode
    );
  }
  const findings = scanText(value, { path: '<auto-credential-broker-reference>' });
  // This is not reviewed source content, so even a waiver-looking value cannot authorize a secret.
  if (findings.length) {
    refuse(
      'Credential brokerReference contains secret-shaped material; store the credential in the broker and provide only its opaque broker:// reference.',
      secretCode,
      { rules: [...new Set(findings.map((finding) => finding.rule))].sort() }
    );
  }
  return value;
}

