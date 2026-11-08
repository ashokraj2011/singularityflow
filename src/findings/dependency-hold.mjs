/**
 * A critical or high vulnerability in a package the Story added or upgraded holds the code step's
 * approval for a person [CQF:REQ-052, decision 9]. It is not a refusal: publication and submission go
 * ahead with it recorded (src/findings/code-step.mjs), and only the approval waits, until the package
 * is fixed (a later submission's audit no longer reports it) or a person accepts it with `decision
 * finding-risk`, giving a reason and an expiry of at most 90 days. Who may accept it is decision 10's:
 * the workflow's security reviewers when it names them, otherwise the step's approvers; never the
 * model, whose guard refuses the command.
 *
 * The approval gate calls this once (state.mjs, stage `dependency-vulnerabilities`), as it calls the
 * departures' check: the hold names each package, its advisory and fixed version, who may accept it and
 * the command they run, so the decision list, the step sheet and every approval surface read it alike.
 */
import { coveringFindingRisk, findingRiskAuthorities, findingRiskDecisionCommand } from '../finding-risk.mjs';
import { SingularityFlowError } from '../util.mjs';

export const DEPENDENCY_HOLD_CODE = 'DEPENDENCY_VULNERABILITY_HELD';
const SHOWN = 10;

/** The step's latest gate record of its findings: submission's, else publication's. */
function latestFindings(phase) {
  const evidence = phase?.deliveryEvidence ?? {};
  return evidence.submittedFindings ?? evidence.qualityFindings ?? null;
}

/**
 * The held vulnerabilities no person has accepted at `at`: each recorded finding the step's latest
 * gate held, read again against the finding risks, since a person may accept one after submission.
 */
export function heldDependencyVulnerabilities(workflow, phase, { at = new Date().toISOString() } = {}) {
  const record = latestFindings(phase);
  const held = new Set(record?.dependencies?.held ?? []);
  if (!held.size) return [];
  return (record.findings ?? []).filter((finding) => held.has(finding.fingerprint))
    .filter((finding) => !coveringFindingRisk(workflow, { phaseId: phase.id, finding, at }));
}

const packageName = (finding) => `${finding.package}${finding.installedVersion ? `@${finding.installedVersion}` : ''}`;

/** One held vulnerability as every approval surface shows it. */
function vulnerability(workflow, phase, finding) {
  return { id: finding.id, tool: finding.tool, rule: finding.rule, severity: finding.severity, package: finding.package,
    installedVersion: finding.installedVersion ?? null, fixedVersion: finding.fixedVersion ?? null, ...(finding.cve ? { cve: finding.cve } : {}),
    ...(finding.url ? { url: finding.url } : {}), message: finding.message, authorities: findingRiskAuthorities(workflow, phase.id, finding),
    command: findingRiskDecisionCommand(workflow, { phaseId: phase.id, finding }) };
}

/** The held vulnerabilities as the hold names them, the first ten, and how many more: what the approval surfaces show. */
export function heldVulnerabilities(workflow, phase, { at = new Date().toISOString() } = {}) {
  const held = heldDependencyVulnerabilities(workflow, phase, { at });
  return { entries: held.slice(0, SHOWN).map((finding) => vulnerability(workflow, phase, finding)), more: Math.max(0, held.length - SHOWN) };
}

/** The code step's approval waits while a held vulnerability is neither fixed nor accepted by a person. */
export function assertDependencyVulnerabilitiesDecided(workflow, phase, { at = new Date().toISOString() } = {}) {
  const held = heldDependencyVulnerabilities(workflow, phase, { at });
  if (!held.length) return;
  const listed = held.slice(0, SHOWN).map((finding) => vulnerability(workflow, phase, finding));
  const authorities = [...new Set(listed.flatMap((entry) => entry.authorities))];
  const words = listed.slice(0, 3).map((entry) => `${packageName(entry)} ${entry.rule ?? ''} (${entry.severity}${entry.fixedVersion ? `, fixed in ${entry.fixedVersion}` : ''})`
    .replace(/\s+/gu, ' ')).join('; ');
  throw new SingularityFlowError(
    `${phase.label ?? phase.id} waits for a person: ${held.length === 1 ? 'a known vulnerability' : `${held.length} known vulnerabilities`} in packages this Story added or upgraded: `
    + `${words}${held.length > 3 ? `, and ${held.length - 3} more` : ''}. Upgrade ${held.length === 1 ? 'it' : 'each'} to a fixed version and submit again, or a person who may decide `
    + `(${authorities.join(', ') || 'the step approvers'}) accepts ${held.length === 1 ? 'it' : 'each'} with decision finding-risk, giving a reason and an expiry of at most 90 days.`,
    { code: 'DEPENDENCY_VULNERABILITY_HELD', details: { phase: phase.id, workId: workflow.workItem.id, authorities, vulnerabilities: listed, more: Math.max(0, held.length - listed.length),
      recoveryCommands: listed.slice(0, 3).map((entry) => ({ command: entry.command,
        label: `A person who may decide (${entry.authorities.join(', ') || 'the step approvers'}) accepts ${packageName(entry)} ${entry.rule ?? ''} for this step, or it is upgraded.`.replace(/\s+/gu, ' ') })) } }
  );
}
