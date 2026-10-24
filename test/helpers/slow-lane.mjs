/**
 * The opt-in slow lane. A test that takes 30 s or more on a quiet machine, or declares a timeout of
 * 120 s or more (a whole-Story journey), runs only when
 * SINGULARITY_FLOW_TEST_SLOW=1: `npm run test:slow` runs every file that holds one, and release
 * verification, which forbids skipped tests, always includes them. Everywhere else (`npm test`,
 * a single file under `node --test`) it is skipped with this reason, so the default run stays fast.
 *
 *   test('a whole Story survives three reworks', slowLane({ timeout: 900_000 }), async (t) => { … });
 */
export const SLOW_LANE_ENV = 'SINGULARITY_FLOW_TEST_SLOW';
export const SLOW_LANE_SKIP = 'slow lane (30 s or more): npm run test:slow, or SINGULARITY_FLOW_TEST_SLOW=1';

export function slowLane(options = {}) {
  return process.env[SLOW_LANE_ENV] === '1' ? options : { ...options, skip: SLOW_LANE_SKIP };
}
