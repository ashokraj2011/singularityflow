/** Honest capability boundary until a transactional REV head/interval writer is installed. */
import { SingularityFlowError } from '../util.mjs';
import { verifyRevisionPacket } from './packet.mjs';

export const revisionRuntimeCapabilities = Object.freeze({
  schemaVersion: 1,
  kind: 'revision-runtime-capabilities',
  activationProfile: 'disabled',
  routeKernelAvailable: true,
  publicRoutePreviewAvailable: false,
  packetKernelAvailable: true,
  publicPacketPlanningAvailable: false,
  codeRevisionExecutionAvailable: false,
  manualCaptureAvailable: false,
  candidateHeadCasAvailable: false,
  codeResultAvailable: false,
  publicationBridgeAvailable: false,
  reasonCode: 'REV_EXECUTION_UNAVAILABLE'
});

/** No provider, Git, worktree, or Story mutation occurs. */
export function planRevisionExecution({ packet, routePlan, attachmentSetSha256 = null }) {
  verifyRevisionPacket(packet, { routePlan, attachmentSetSha256 });
  return {
    schemaVersion: 1, kind: 'revision-execution-unavailable',
    code: 'REV_EXECUTION_UNAVAILABLE',
    packetSha256: packet.packetSha256,
    routePlanSha256: routePlan.planSha256,
    attachmentSetSha256,
    effects: { codeChanged: false, artifactChanged: false, lifecycleChanged: false, externalChanged: false },
    requiredBridge: [
      'phase-bound durable loop head and interval journal',
      'atomic candidate/head/precheck compare-and-swap',
      'isolated execution with process quiescence and effect-resolution proof',
      'exact selected-candidate Story publication gate'
    ]
  };
}

export function assertRevisionExecutionInstalled() {
  throw new SingularityFlowError(
    'Code revision execution is not installed. Route and packet planning do not start a revision interval.',
    { code: 'REV_EXECUTION_UNAVAILABLE' }
  );
}
