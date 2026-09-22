/** Fixed, credential-free ABI descriptor for a future independently approved REV runner. */
export const APPROVED_RUNNER_PROVIDER = Object.freeze({
  id: 'sflow-isolated-runner',
  protocol: 'revision-isolated-runner-v1',
  apiVersion: 1,
  operation: 'executeSealedRevisionRun',
  requestKind: 'revision-isolated-runner-request',
  attestationKind: 'revision-candidate-under-test-attestation',
  receiptKind: 'revision-authenticated-runner-receipt'
});
