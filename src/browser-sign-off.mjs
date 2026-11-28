/**
 * A person's sign-off on SFlow's saved screenshot of a page no browser check saw [owner, 2026-11-28: "allow sign-off,
 * recorded"]. The browser gate (mcp-evidence.mjs verifyPhaseMcpRequirements) loads it only for such a page. The
 * screenshot is the newest record of the server for this version with a saved output that the host did not observe (the
 * agent's own capture, kept "for audit"); a sign-off counts only for those exact bytes, and only for this version. It is
 * recorded as a finding override of kind browser-sign-off (finding-overrides.mjs), so it shows as "signed off by a person,
 * not captured by SFlow" at the approval and in the pull request.
 */
import { activeFindingOverrides, findingOverrideKey, overriddenWords, overrideSummary } from './finding-overrides.mjs';

/** The finding a page no browser check saw is, for its sign-off's key: one per browser server on the step. */
export const BROWSER_UNOBSERVED_CODE = 'MCP_EVIDENCE_BROWSER_UNOBSERVED';
const browserUnobserved = (server) => ({ code: BROWSER_UNOBSERVED_CODE, category: 'external-evidence', path: null, value: server,
  message: `SFlow could not capture the ${server} page itself for this version.` });

/** The sign-off in force for `server`'s page on this version (`signed`, with its words), else what a person may sign off (`offer`, null with no screenshot). */
export function browserSignOff(workflow, phase, generation, server, records) {
  const shots = records.filter((record) => record.server === server && /^browser_/u.test(String(record.tool ?? '')) && record.output?.sha256
    && record.captureSource !== 'observed-by-mcp-host').sort((left, right) => String(left.recordedAt ?? '').localeCompare(String(right.recordedAt ?? '')));
  const finding = browserUnobserved(server);
  const key = findingOverrideKey(phase.id, finding);
  const signed = activeFindingOverrides(workflow, phase, generation).find((entry) => entry.finding === key && entry.kind === 'browser-sign-off'
    && shots.some((shot) => shot.output.sha256 === entry.screenshot?.sha256));
  if (signed) return { signed: { ...finding, overriddenBy: overrideSummary(signed) }, words: overriddenWords(finding, overrideSummary(signed)) };
  const shot = shots.at(-1);
  return { offer: shot ? Object.freeze({ ...finding, override: Object.freeze({ key, kind: 'browser-sign-off',
    screenshot: Object.freeze({ record: shot.id, path: shot.output.path, sha256: shot.output.sha256 }) }) }) : null };
}
