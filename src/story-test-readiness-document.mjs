/**
 * The Story carries the test tools and pre-code disposition that were actually observed at
 * creation. This is a snapshot of a completed read-only preflight, not a substitute for a test
 * receipt or an instruction to skip checks later in the workflow.
 */
export function storyTestReadinessDocument(workId, repositories, evidence, { required = false } = {}) {
  const receipts = evidence?.repositories ?? {};
  const records = [...repositories].map((repository) => {
    const receipt = receipts[repository.id] ?? null;
    const current = receipt?.status === 'pass'
      && receipt.sourceCommit === repository.baseCommit;
    const contract = current ? receipt.structuredTestContract ?? null : null;
    const tools = contract?.commands ?? [];
    const observations = current ? receipt.testObservations ?? [] : [];
    const verifiedTests = current && tools.length > 0
      && tools.every((tool) => observations.some((entry) => entry.commandId === tool.id
        && entry.status === 'available' && entry.counts?.discovered > 0
        && entry.counts?.failed === 0));
    return {
      repository: repository.id,
      sourceCommit: repository.baseCommit ?? null,
      receiptSourceCommit: receipt?.sourceCommit ?? null,
      scope: receipt?.scope ?? null,
      status: receipt?.status ?? 'not-checked',
      receiptSha256: receipt?.receiptSha256 ?? null,
      testToolStatus: contract?.status ?? 'not-checked',
      testTools: tools.map((command) => ({
        id: command.id,
        workingDirectory: command.workingDirectory,
        launcher: command.launcher,
        adapter: command.adapter,
        reportPath: command.reportPath
      })),
      commandResults: (current ? receipt.commandResults ?? [] : []).map((command) => ({
        id: command.id,
        purpose: command.purpose,
        status: command.status
      })),
      testResults: observations.map((entry) => ({
        commandId: entry.commandId,
        adapter: entry.adapter,
        status: entry.status,
        counts: entry.counts ?? null
      })),
      existingFailureDisposition: verifiedTests
        ? 'no-observed-pre-story-failures'
        : current && !tools.length
          ? 'no-test-tool-selected'
          : 'repair-or-verify-before-code'
    };
  }).sort((left, right) => left.repository.localeCompare(right.repository));
  return {
    schemaVersion: 1,
    kind: 'story-test-readiness',
    workId,
    required,
    repositories: records,
    guidance: 'Existing failures require repair or an explicit, independently verified baseline-risk decision. This document alone never waives a test, publication, approval, or protected-path check.'
  };
}
