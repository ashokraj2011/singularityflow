/**
 * The PATH a distribution installer runs its probes with.
 *
 * The release bootstrap starts the installer through `npm exec --package <candidate>`, which puts the
 * candidate's own executables first on PATH. Every probe of "the installed CLI" then reaches the
 * candidate instead: an upgrade over a retained release is refused because the live CLI seems to be
 * the candidate, and the check after the global install cannot see that it never took effect. The
 * bootstrap passes the PATH the person launched it with; the installer restores it before it runs
 * anything, and so sees the machine exactly as that person does.
 */
export const DISTRIBUTION_ORIGIN_PATH = 'SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_PATH';

export function restoreDistributionOriginPath(environment = process.env) {
  if (environment?.SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED !== '1') return false;
  const origin = environment[DISTRIBUTION_ORIGIN_PATH];
  if (typeof origin !== 'string' || !origin) return false;
  // Windows spells it Path; replace whichever spellings are present.
  const keys = Object.keys(environment).filter((key) => key.toUpperCase() === 'PATH');
  for (const key of keys.length ? keys : ['PATH']) environment[key] = origin;
  return true;
}
