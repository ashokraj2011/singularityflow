import { escape } from './webview.ts';

export type BaselineDisposition = 'fix' | 'accept-known-failures';
export type TestExecutionMode = 'changed-and-affected' | 'all-configured';
export type TestBaselineScope = 'reuse' | 'targeted' | 'all-configured';

/** Engine-owned projection. This is display data, never a decision receipt or authority claim. */
export interface PreflightTestRecovery {
  schemaVersion: 1;
  enabled: boolean;
  supportedBaselineDispositions: string[];
  supportedExecutionModes: string[];
  supportedBaselineScopes: string[];
  acceptKnownFailuresEligible?: boolean;
  planDigest?: string;
  ready?: boolean;
  summary?: string;
  unavailableReasons?: Record<string, string>;
  route?: string;
  mandatoryChecks?: string[];
  legalActions?: Array<{ id: string; label: string; command?: string; args?: string[] }>;
  repositories?: Array<{
    repository: string;
    baseCommit?: string | null;
    baselineStatus?: string;
    baselineScope?: string;
    environment?: string;
    decisionExpiry?: string;
    failures?: Array<{ id: string; suite?: string }>;
    tools?: Array<{
      id: string; framework?: string; runner?: string; interpreter?: string; cwd?: string;
      adapter?: string; reportPath?: string; source?: string; status?: string;
    }>;
    requestedScope?: string;
    effectiveScope?: string;
    commands?: string[];
    selectedTests?: string[];
    exclusions?: string[];
    reasons?: string[];
    unknowns?: string[];
  }>;
}

export interface TestRecoveryDraft {
  testRecovery: PreflightTestRecovery | null;
  testBaselineDisposition: BaselineDisposition;
  testExecutionMode: TestExecutionMode;
  testBaselineScope: TestBaselineScope;
  testRecoveryConfirmedDigest: string | null;
  testBaselineRecords: string;
  testBaselineReason: string;
  testBaselineOwner: string;
  testBaselineRemediation: string;
  testBaselineExpiresAt: string;
}

export const EMPTY_TEST_RECOVERY_DRAFT: TestRecoveryDraft = {
  testRecovery: null,
  testBaselineDisposition: 'fix',
  testExecutionMode: 'changed-and-affected',
  testBaselineScope: 'reuse',
  testRecoveryConfirmedDigest: null,
  testBaselineRecords: '', testBaselineReason: '', testBaselineOwner: '',
  testBaselineRemediation: '', testBaselineExpiresAt: ''
};

export function testRecoveryEnabled(draft: TestRecoveryDraft): boolean {
  return draft.testRecovery?.schemaVersion === 1 && draft.testRecovery.enabled === true;
}

export function testRecoveryChoiceSupported(
  draft: TestRecoveryDraft, field: string, value: string
): boolean {
  if (!testRecoveryEnabled(draft)) return false;
  const capability = draft.testRecovery!;
  if (field === 'testBaselineDisposition') {
    return ['fix', 'accept-known-failures'].includes(value)
      && capability.supportedBaselineDispositions?.includes(value) === true;
  }
  if (field === 'testExecutionMode') return ['changed-and-affected', 'all-configured'].includes(value)
    && capability.supportedExecutionModes?.includes(value) === true;
  if (field === 'testBaselineScope') return ['reuse', 'targeted', 'all-configured'].includes(value)
    && capability.supportedBaselineScopes?.includes(value) === true;
  return false;
}

export function testRecoveryCanConfirm(draft: TestRecoveryDraft): boolean {
  return testRecoveryEnabled(draft) && draft.testRecovery?.ready === true
    && (draft.testBaselineDisposition !== 'accept-known-failures'
      || draft.testRecovery.acceptKnownFailuresEligible === true && testRecoveryTermsProblems(draft).length === 0)
    && /^sha256:[a-f0-9]{64}$/u.test(draft.testRecovery.planDigest ?? '')
    && (['testBaselineDisposition', 'testExecutionMode', 'testBaselineScope'] as const)
      .every((field) => testRecoveryChoiceSupported(draft, field, draft[field]));
}

export function testRecoveryTermsProblems(draft: TestRecoveryDraft): string[] {
  if (!testRecoveryEnabled(draft) || draft.testBaselineDisposition !== 'accept-known-failures') return [];
  const records = draft.testBaselineRecords.trim().split(/[\s,]+/u).filter(Boolean);
  const problems: string[] = [];
  if (!records.length || records.length > 64 || new Set(records).size !== records.length
      || records.some(value => !/^sha256:[a-f0-9]{64}$/u.test(value))) {
    problems.push('Supply 1–64 distinct exact baseline record digests from the governed baseline command.');
  }
  for (const [value, label, minimum, maximum] of [
    [draft.testBaselineReason, 'Baseline acceptance reason', 15, 2000],
    [draft.testBaselineOwner, 'Follow-up owner', 1, 256],
    [draft.testBaselineRemediation, 'Remediation reference', 1, 1000]
  ] as const) if (value.trim().length < minimum || value.trim().length > maximum || /[\x00-\x1f\x7f]/u.test(value)) {
    problems.push(`${label} needs ${minimum}–${maximum} ordinary characters.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(draft.testBaselineExpiresAt.trim())
      || !Number.isFinite(Date.parse(draft.testBaselineExpiresAt.trim()))) {
    problems.push('Specify the exact baseline decision expiry in UTC (for example 2026-10-03T12:00:00Z).');
  }
  return problems;
}

export function testRecoveryNeedsTerminalReview(draft: TestRecoveryDraft): boolean {
  return testRecoveryEnabled(draft) && draft.testBaselineDisposition === 'accept-known-failures';
}

/** Reject delayed checkbox events from a different preview; never adopt a page-supplied digest. */
export function testRecoveryConfirmation(
  draft: TestRecoveryDraft, displayedPlanDigest: string | null, confirmed: unknown
): string | null {
  return confirmed === true && testRecoveryCanConfirm(draft)
    && displayedPlanDigest === draft.testRecovery!.planDigest
    ? draft.testRecovery!.planDigest! : null;
}

/** These flags request a preview. Only the explicit final confirmation adds a mutation digest. */
export function testRecoveryArguments(draft: TestRecoveryDraft, confirmed = false): string[] {
  if (!testRecoveryEnabled(draft)) return [];
  const args = [
    '--test-baseline-disposition', draft.testBaselineDisposition,
    '--test-execution-mode', draft.testExecutionMode,
    '--test-baseline-scope', draft.testBaselineScope
  ];
  if (testRecoveryNeedsTerminalReview(draft) && testRecoveryTermsProblems(draft).length === 0) {
    args.push(...draft.testBaselineRecords.trim().split(/[\s,]+/u).flatMap(value => ['--test-baseline-record', value]),
      '--test-baseline-reason', draft.testBaselineReason.trim(), '--test-baseline-owner', draft.testBaselineOwner.trim(),
      '--test-baseline-remediation', draft.testBaselineRemediation.trim(), '--test-baseline-expires-at', draft.testBaselineExpiresAt.trim());
  }
  if (confirmed && testRecoveryCanConfirm(draft)
    && draft.testRecoveryConfirmedDigest === draft.testRecovery!.planDigest) {
    args.push('--test-policy-confirm', draft.testRecoveryConfirmedDigest!);
  }
  return args;
}

export function testRecoveryProblems(draft: TestRecoveryDraft): string[] {
  if (!testRecoveryEnabled(draft)) return [];
  const problems: string[] = testRecoveryTermsProblems(draft);
  if (!testRecoveryCanConfirm(draft)) problems.push('Refresh and resolve the Test and recovery plan before starting.');
  if (!draft.testRecoveryConfirmedDigest
    || draft.testRecoveryConfirmedDigest !== draft.testRecovery?.planDigest) {
    problems.push('Explicitly confirm the exact Test and recovery plan. Display defaults are not consent.');
  }
  return problems;
}

function list(values: string[] | undefined, empty: string): string {
  return values?.length ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>`
    : `<p class="meta">${escape(empty)}</p>`;
}

/** Engine-returned routes are displayed only. Report text never becomes a runnable webview action. */
export function testRecoveryHtml(draft: TestRecoveryDraft): string {
  if (!testRecoveryEnabled(draft)) return `<section data-test-policy-availability><h2>Test execution scope</h2>
    <p class="meta">This workflow does not advertise Story test-scope selection. Its configured test commands remain required.
    To choose changed-and-affected or all-configured tests at intake, enable <code>testRecovery.enabled</code>
    in the approved repository workflow and refresh this intake. Capability path exclusions alone do not change test scope or accept failed tests.</p></section>`;
  const capability = draft.testRecovery!;
  const radios = (field: 'testBaselineDisposition' | 'testExecutionMode' | 'testBaselineScope',
    label: string, choices: Array<[string, string]>): string => `<fieldset><legend>${label}</legend>
    ${choices.map(([value, title]) => {
      const supported = testRecoveryChoiceSupported(draft, field, value);
      return `<p><label><input type="radio" name="${field}" data-test-recovery-field="${field}" value="${value}"${draft[field] === value ? ' checked' : ''}${supported ? '' : ' disabled'}> ${title}</label>
        ${supported ? '' : `<span class="meta"> — ${escape(capability.unavailableReasons?.[value]
          ?? 'Unavailable in this engine/policy pilot.')}</span>`}</p>`;
    }).join('')}</fieldset>`;
  return `<section data-test-recovery><h2>Test and recovery · opt-in pilot</h2>
    <p class="question">${escape(capability.summary ?? 'Only the capabilities advertised by the selected repository policy are available.')}</p>
    <p class="meta">Display defaults are not consent. Opening this preview does not execute tests or install packages.</p>
    ${radios('testBaselineDisposition', 'Existing failures', [
      ['fix', 'Fix existing failures before feature coding'],
      ['accept-known-failures', 'Accept listed existing failures and continue']
    ])}
    ${radios('testExecutionMode', 'Ongoing execution scope', [
      ['changed-and-affected', 'Changed and affected tests'], ['all-configured', 'All configured tests']
    ])}
    ${radios('testBaselineScope', 'Baseline acquisition (separate from ongoing scope)', [
      ['reuse', 'Reuse an authenticated, compatible baseline for the exact base'],
      ['targeted', 'Run a targeted baseline for the initial planned cohort'],
      ['all-configured', 'Run the full configured baseline once']
    ])}
    ${draft.testBaselineDisposition === 'accept-known-failures' ? `
      <p class="notice warning">Tests remain failed. Supply exact authenticated baseline records and review terms. Start only prepares a terminal command; live delegated human review of the agreement and failures is still required.</p>
      <p>To obtain baseline records, inspect the exact engine-returned baseline action below in a terminal. Preserve its <code>--isolated-worktree</code> flag when supplied: a source-checkout record cannot authorize a different Story checkout. Baseline execution requires its own reviewed plan and separate confirmation; this preview never runs tests.</p>
      <p><label>Baseline record digests (one per line)<textarea data-field="testBaselineRecords" rows="3" maxlength="4600">${escape(draft.testBaselineRecords)}</textarea></label></p>
      <p><label>Acceptance reason<input data-field="testBaselineReason" value="${escape(draft.testBaselineReason)}" maxlength="2000"></label></p>
      <p><label>Follow-up owner<input data-field="testBaselineOwner" value="${escape(draft.testBaselineOwner)}" maxlength="256"></label></p>
      <p><label>Remediation reference or action<input data-field="testBaselineRemediation" value="${escape(draft.testBaselineRemediation)}" maxlength="1000"></label></p>
      <p><label>Decision expiry (UTC)<input data-field="testBaselineExpiresAt" value="${escape(draft.testBaselineExpiresAt)}" placeholder="2026-10-03T12:00:00Z" maxlength="30"></label></p>
      <p class="meta">${capability.acceptKnownFailuresEligible === true ? 'The engine reports this exact baseline eligible for review.' : 'Acceptance is not yet eligible. Refresh after supplying the exact baseline and terms; incomplete coverage is not consent.'}</p>` : ''}
    ${(capability.repositories ?? []).map((repository) => `<div class="readiness-repository">
      <h3>${escape(repository.repository)}</h3>
      <p>Base <code>${escape(repository.baseCommit ?? 'unknown')}</code> · Baseline: ${escape(repository.baselineStatus ?? 'Existing failures unknown')}
        · Baseline scope: ${escape(repository.baselineScope ?? 'unknown')} · Environment: ${escape(repository.environment ?? 'unverified')}</p>
      <p>Requested scope: ${escape(repository.requestedScope ?? draft.testExecutionMode)} · Effective scope: ${escape(repository.effectiveScope ?? 'unresolved')}</p>
      ${repository.tools?.length ? `<table><caption>Detected test tools</caption><thead><tr><th>Tool / framework</th><th>Runner / interpreter / working directory</th><th>Report adapter / path</th><th>Source / status</th></tr></thead><tbody>${repository.tools.map((tool) => `<tr>
        <td>${escape(tool.id)} / ${escape(tool.framework ?? 'unresolved')}</td>
        <td>${escape(tool.runner ?? 'unresolved')} / ${escape(tool.interpreter ?? 'unresolved')} / ${escape(tool.cwd ?? 'unresolved')}</td>
        <td>${escape(tool.adapter ?? 'unsupported or unresolved')} / ${escape(tool.reportPath ?? 'unresolved')}</td>
        <td>${escape(tool.source ?? 'unresolved')} / ${escape(tool.status ?? 'unverified')}</td></tr>`).join('')}</tbody></table>` : '<p>Test-tool inventory unavailable; no verified tool is implied.</p>'}
      <strong>Observed failure identities (remain failed)</strong>
      ${list(repository.failures?.map((failure) => `${failure.id}${failure.suite ? ` · suite ${failure.suite}` : ''}`), 'No failure identities supplied; unknown coverage is not accepted.')}
      ${repository.decisionExpiry ? `<p>Decision expiry: ${escape(repository.decisionExpiry)}</p>` : ''}
      <strong>Commands</strong>${list(repository.commands, 'No execution command selected.')}
      <strong>Selected tests / suites</strong>${list(repository.selectedTests, 'Selection unresolved.')}
      <strong>Exclusions</strong>${list(repository.exclusions, 'No exclusions declared.')}
      <strong>Selection reasons</strong>${list(repository.reasons, 'No selection reasons supplied.')}
      <strong>Unknowns</strong>${list(repository.unknowns, 'No additional unknowns declared by the engine.')}
    </div>`).join('')}
    <strong>Mandatory checks, including later phases</strong>${list(capability.mandatoryChecks, 'No additional mandatory checks declared by this preview.')}
    <p>Initial route: ${escape(capability.route ?? 'unresolved; follow the engine action below')}</p>
    <strong>Legal next actions</strong>${list(capability.legalActions?.map((action) =>
      `${action.id}: ${action.label}${action.command ? ` · ${action.command} ${JSON.stringify(action.args ?? [])}` : ''}`), 'No legal action returned.')}
    <p>Exact plan: <code>${escape(capability.planDigest ?? 'not available')}</code></p>
    <p><label><input type="checkbox" data-test-recovery-confirm="${escape(capability.planDigest ?? '')}"${testRecoveryCanConfirm(draft) ? '' : ' disabled'}${testRecoveryCanConfirm(draft) && draft.testRecoveryConfirmedDigest === capability.planDigest ? ' checked' : ''}>
      I reviewed and confirm this exact plan, including scope, unknowns, required checks and the initial route.</label></p>
    <button type="button" class="secondary" data-test-recovery-refresh>Refresh test and recovery plan</button>
  </section>`;
}
