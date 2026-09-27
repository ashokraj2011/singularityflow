/**
 * Join the two explicitly requested independent reads after the approved application remote is
 * selected. Both owners settle before refusal/cleanup. The destination retains its historical
 * first-refusal precedence; the caller consumes the retained tracker promise at its old checkpoint.
 */
export async function settleStoryStartReadWave(readDestination, readExternalSource) {
  const [destination] = await Promise.allSettled([
    Promise.resolve().then(readDestination),
    Promise.resolve().then(readExternalSource)
  ]);
  if (destination.status === 'rejected') throw destination.reason;
  return destination.value;
}
