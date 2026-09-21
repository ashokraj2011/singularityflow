/**
 * Pure, non-authoritative view model for one BRL browser-run comparison.
 *
 * The kernel owns receipt verification and comparison. This projection deliberately accepts no
 * artifact bytes, report HTML, command, confirmation, or action handle. It can therefore be used
 * by a future result panel without creating a second execution or authority path.
 */

export type RevisionBrowserTestCounts = {
  readonly discovered: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
};

export type RevisionBrowserArtifactView = {
  readonly kind: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number | null;
  readonly captureProvenanceSha256: string | null;
  readonly provenance: 'unverified';
  readonly accessClass: string;
  readonly retentionClass: string;
  readonly previewable: boolean;
};

export type RevisionBrowserVisualView = {
  readonly testId: string;
  readonly verdict: string;
  readonly diffRatio: number | null;
  readonly tolerance: number | null;
  readonly baselineSha256: string | null;
  readonly actualSha256: string | null;
  readonly diffSha256: string | null;
};

export type RevisionBrowserResultView = {
  readonly available: boolean;
  readonly tone: 'observed' | 'attention' | 'unavailable';
  readonly headline: string;
  readonly candidate: {
    readonly id: string | null;
    readonly tree: string | null;
    readonly referenceSha256: string | null;
  };
  readonly run: {
    readonly id: string | null;
    readonly keySha256: string | null;
    readonly state: string;
    readonly reasonCode: string | null;
    readonly receiptSha256: string | null;
    readonly resultStatus: string;
    readonly comparisonStatus: string;
  };
  readonly tests: RevisionBrowserTestCounts | null;
  readonly staleBindings: readonly string[];
  readonly artifacts: readonly RevisionBrowserArtifactView[];
  readonly visuals: readonly RevisionBrowserVisualView[];
  readonly boundary: {
    readonly executionAssurance: string;
    readonly assertionWitnessEstablished: false;
    readonly criterionSatisfactionEstablished: false;
    readonly testingVerificationEstablished: false;
    readonly publicationEligibilityEstablished: false;
    readonly statement: string;
  };
};

const HASH = /^sha256:[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const CANDIDATE = /^CAN-[A-Za-z0-9._:-]{6,127}$/u;
const ATTENTION = new Set([
  'failed', 'stale', 'skipped', 'cancelled', 'timed-out', 'infrastructure-failed',
  'recovery-required'
]);

function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : null;
}

function text(value: unknown, maximum = 1024): string | null {
  if (typeof value !== 'string' || !value || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function hash(value: unknown): string | null {
  return typeof value === 'string' && HASH.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function testCounts(value: unknown): RevisionBrowserTestCounts | null {
  const input = object(value);
  if (!input) return null;
  const discovered = count(input.discovered);
  const passed = count(input.passed);
  const failed = count(input.failed);
  const skipped = count(input.skipped);
  const flaky = count(input.flaky);
  if ([discovered, passed, failed, skipped, flaky].some((item) => item === null)
      || discovered !== Number(passed) + Number(failed) + Number(skipped) + Number(flaky)) {
    return null;
  }
  return { discovered: Number(discovered), passed: Number(passed), failed: Number(failed),
    skipped: Number(skipped), flaky: Number(flaky) };
}

function artifact(value: unknown): RevisionBrowserArtifactView | null {
  const input = object(value);
  if (!input) return null;
  const kind = text(input.kind, 64);
  const path = text(input.path, 1024);
  const mediaType = text(input.mediaType, 128);
  const sha256 = hash(input.sha256);
  if (!kind || !path || !mediaType || !sha256) return null;
  // The current BRL slice has no secure artifact-admission or authenticated capture-provenance
  // authority. Treat every artifact as opaque, even when a hostile record supplies plausible media
  // metadata or a digest. A later verified envelope must introduce a distinct projection contract.
  const provenance = 'unverified' as const;
  return {
    kind, path, mediaType, sha256,
    bytes: count(input.bytes), captureProvenanceSha256: null, provenance,
    accessClass: text(input.accessClass, 32) ?? 'unknown',
    retentionClass: text(input.retentionClass, 32) ?? 'unknown',
    previewable: false
  };
}

function visual(value: unknown): RevisionBrowserVisualView | null {
  const input = object(value);
  if (!input) return null;
  const testId = text(input.testId, 256);
  const verdict = text(input.verdict, 64);
  if (!testId || !verdict) return null;
  const diffRatio = typeof input.diffRatio === 'number' && Number.isFinite(input.diffRatio)
    && input.diffRatio >= 0 && input.diffRatio <= 1 ? input.diffRatio : null;
  const tolerance = typeof input.tolerance === 'number' && Number.isFinite(input.tolerance)
    && input.tolerance >= 0 && input.tolerance <= 1 ? input.tolerance : null;
  return { testId, verdict, diffRatio, tolerance,
    baselineSha256: hash(input.baselineSha256), actualSha256: hash(input.actualSha256),
    diffSha256: hash(input.diffSha256) };
}

function headline(tone: RevisionBrowserResultView['tone'], comparisonStatus: string): string {
  if (tone === 'unavailable') return 'Browser revision evidence is unavailable';
  if (comparisonStatus === 'stale') return 'Browser revision evidence is stale';
  if (tone === 'attention') return 'Browser revision evidence needs attention';
  return 'Browser revision evidence was observed';
}

/**
 * Build a bounded display projection from already verified kernel records.
 *
 * Boolean authority fields from the source are intentionally ignored. This foundation always
 * renders them false until a future independently gated authority projection is introduced.
 */
export function buildRevisionBrowserResultView(source: unknown): RevisionBrowserResultView {
  const input = object(source) ?? {};
  const receipt = object(input.receipt);
  const comparison = object(input.comparison);
  const state = object(input.runState ?? input.state);
  const runKey = object(receipt?.runKey);
  const resultStatus = text(receipt?.status, 64) ?? 'unavailable';
  const comparisonStatus = text(comparison?.status, 64) ?? 'unavailable';
  const runState = text(state?.state, 64) ?? (receipt ? 'completed' : 'unavailable');
  const available = Boolean(receipt || comparison);
  const tone: RevisionBrowserResultView['tone'] = !available
    ? 'unavailable'
    : [runState, resultStatus, comparisonStatus].some((item) => ATTENTION.has(item))
      ? 'attention' : 'observed';
  const staleBindings = Array.isArray(comparison?.staleBindings)
    ? comparison.staleBindings.slice(0, 32)
      .map((item: unknown) => text(item, 64)).filter((item: string | null): item is string => Boolean(item))
    : [];
  const artifacts = Array.isArray(receipt?.artifacts)
    ? receipt.artifacts.slice(0, 64).map(artifact)
      .filter((item: RevisionBrowserArtifactView | null): item is RevisionBrowserArtifactView => Boolean(item))
    : [];
  const visuals = Array.isArray(comparison?.visuals)
    ? comparison.visuals.slice(0, 64).map(visual)
      .filter((item: RevisionBrowserVisualView | null): item is RevisionBrowserVisualView => Boolean(item))
    : Array.isArray(receipt?.visualComparisons)
      ? receipt.visualComparisons.slice(0, 64).map(visual)
        .filter((item: RevisionBrowserVisualView | null): item is RevisionBrowserVisualView => Boolean(item))
      : [];
  const candidateId = text(runKey?.candidateId, 128);
  const candidateTree = text(runKey?.candidateTree, 64);
  return {
    available, tone, headline: headline(tone, comparisonStatus),
    candidate: {
      id: candidateId && CANDIDATE.test(candidateId) ? candidateId : null,
      tree: candidateTree && OID.test(candidateTree) ? candidateTree : null,
      referenceSha256: hash(runKey?.candidateRefSha256)
    },
    run: {
      id: text(input.runId, 128), keySha256: hash(runKey?.runKeySha256), state: runState,
      reasonCode: text(state?.reasonCode ?? receipt?.reasonCode, 128),
      receiptSha256: hash(receipt?.receiptSha256), resultStatus, comparisonStatus
    },
    tests: testCounts(receipt?.tests), staleBindings, artifacts, visuals,
    boundary: {
      executionAssurance: text(receipt?.executionAssurance, 128) ?? 'not-established',
      assertionWitnessEstablished: false,
      criterionSatisfactionEstablished: false,
      testingVerificationEstablished: false,
      publicationEligibilityEstablished: false,
      statement: 'Observed candidate evidence only — this card does not establish a passing repository test, criterion satisfaction, Testing or Verification, publication, approval, merge, deployment, or release authority.'
    }
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character] ?? character));
}

function digest(value: string | null): string {
  return value ? `<code>${escapeHtml(value)}</code>` : '<span>not recorded</span>';
}

/**
 * Render escaped, inert markup. Artifact bytes and report HTML are never accepted as inputs.
 */
export function revisionBrowserResultCardHtml(view: RevisionBrowserResultView): string {
  const counts = view.tests
    ? `<dl><dt>Discovered</dt><dd>${view.tests.discovered}</dd><dt>Passed</dt><dd>${view.tests.passed}</dd><dt>Failed</dt><dd>${view.tests.failed}</dd><dt>Skipped</dt><dd>${view.tests.skipped}</dd><dt>Flaky</dt><dd>${view.tests.flaky}</dd></dl>`
    : '<p>Structured test totals are not available.</p>';
  const stale = view.staleBindings.length
    ? `<ul>${view.staleBindings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>None reported.</p>';
  const artifacts = view.artifacts.length
    ? `<table><thead><tr><th>Kind</th><th>Path</th><th>Digest</th><th>Provenance</th><th>Access / retention</th></tr></thead><tbody>${view.artifacts.map((item) => `<tr><td>${escapeHtml(item.kind)}</td><td><code>${escapeHtml(item.path)}</code></td><td>${digest(item.sha256)}</td><td>${escapeHtml(item.provenance)}${item.captureProvenanceSha256 ? ` · ${digest(item.captureProvenanceSha256)}` : ''}</td><td>${escapeHtml(item.accessClass)} / ${escapeHtml(item.retentionClass)}</td></tr>`).join('')}</tbody></table>`
    : '<p>No opaque artifact inventory is available.</p>';
  const visuals = view.visuals.length
    ? `<table><thead><tr><th>Test</th><th>Verdict</th><th>Difference</th><th>Tolerance</th></tr></thead><tbody>${view.visuals.map((item) => `<tr><td>${escapeHtml(item.testId)}</td><td>${escapeHtml(item.verdict)}</td><td>${item.diffRatio == null ? 'not recorded' : `${(item.diffRatio * 100).toFixed(2)}%`}</td><td>${item.tolerance == null ? 'not recorded' : `${(item.tolerance * 100).toFixed(2)}%`}</td></tr>`).join('')}</tbody></table>`
    : '<p>No visual comparisons are available.</p>';
  return `<section class="sf-revision-browser-card sf-revision-browser-${view.tone}"><h2>${escapeHtml(view.headline)}</h2><p>${escapeHtml(view.boundary.statement)}</p><h3>Candidate and run</h3><dl><dt>Candidate</dt><dd>${escapeHtml(view.candidate.id ?? 'not recorded')}</dd><dt>Candidate tree</dt><dd>${digest(view.candidate.tree)}</dd><dt>Run</dt><dd>${escapeHtml(view.run.id ?? 'not recorded')}</dd><dt>Run state</dt><dd>${escapeHtml(view.run.state)}</dd><dt>Result</dt><dd>${escapeHtml(view.run.resultStatus)}</dd><dt>Comparison</dt><dd>${escapeHtml(view.run.comparisonStatus)}</dd><dt>Execution assurance</dt><dd>${escapeHtml(view.boundary.executionAssurance)}</dd></dl><h3>Test counts</h3>${counts}<h3>Stale bindings</h3>${stale}<h3>Visual comparisons</h3>${visuals}<h3>Opaque artifacts</h3>${artifacts}</section>`;
}
