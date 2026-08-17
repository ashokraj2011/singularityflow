/** Host-owned destinations for read results that already have a dedicated governed surface. */
export function gatewayDestination(result: any): string | null {
  if (result?.operation?.id === 'review.packet' && result?.data?.surface === 'approvals') {
    return 'singularityFlow.openApprovals';
  }
  return null;
}
