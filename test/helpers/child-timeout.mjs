/**
 * The deadline for a child process a test runs.
 *
 * A limit of 10 s or more is there to catch a hung child, not to time it. Files running side by
 * side stretch a child well past its quiet time, and the test then failed though nothing was wrong:
 * `skill approved` took 83 s in a full run against a 30 s child limit, and 9.6 s alone. Such a limit
 * is scaled by SINGULARITY_FLOW_TEST_TIMEOUT_SCALE (default 4), up to 10 minutes, never below what
 * the test asked for. A shorter limit is deliberate (a test of a deadline itself) and is kept.
 *
 *   spawnSync(process.execPath, [cli, 'status'], { cwd, encoding: 'utf8', timeout: childTimeout(30_000) });
 */
export function childTimeout(ms) {
  if (!Number.isFinite(ms) || ms < 10_000) return ms;
  const scale = Number(process.env.SINGULARITY_FLOW_TEST_TIMEOUT_SCALE ?? 4);
  return Math.max(ms, Math.min(ms * (Number.isFinite(scale) && scale > 0 ? scale : 4), 600_000));
}
