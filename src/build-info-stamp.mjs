/**
 * Pure build-information stamping shared by every packager.
 *
 * This module deliberately knows nothing about Git or installation. A caller supplies facts that
 * it has already established, and this module writes those facts as safe JavaScript literals. That
 * keeps `sflow reinstall` inside its no-Git boundary while the source installer can still record a
 * commit.
 */
import { readFile, writeFile } from 'node:fs/promises';

/** JavaScript source literal safe for paths, quotes, backslashes, and control characters. */
function literal(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Replace only declared BUILD_INFO fields, preserving the module and its documentation. */
export function stampBuildInfo(source, facts) {
  let stamped = source;
  for (const [key, value] of Object.entries(facts)) {
    const pattern = new RegExp(`(^\\s*${key}:\\s*)[^,\\n]*(,?)$`, 'm');
    if (!pattern.test(stamped)) {
      throw new Error(`src/build-info.mjs has no '${key}' field to stamp. Update the stamper and runtime module together.`);
    }
    stamped = stamped.replace(pattern, (_match, prefix, comma) => `${prefix}${literal(value)}${comma}`);
  }
  return stamped;
}

/** Stamp one isolated package source file. The caller owns backup or disposal of that source. */
export async function stampBuildInfoFile(target, facts) {
  const source = await readFile(target, 'utf8');
  await writeFile(target, stampBuildInfo(source, facts), 'utf8');
}
