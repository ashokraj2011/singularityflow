/**
 * The Node.js the engine runs on (2026-10-31): the LTS lines 22 and 26 are supported and released
 * against, and 24 between them runs too. Run from a shell or an installed copy the engine needs Node 22
 * or newer, with one exception on Windows: Node 22.12 to 22.16 and 23 report device 0 for a path stat
 * on Windows 11 24H2 and Windows Server 2025, so every same-file check refuses there. On Windows a
 * Node 22 must therefore be 22.17 or newer (22.17, 22.18 and 22.23 agree, probe run 41165022121), and
 * Node 23 is refused. The managed runtime installs Node 26. VS Code runs its bundled engine on its own
 * Node (24 in VS Code 1.144), which keeps the floor of the VS Code releases the extension supports.
 */
export const MINIMUM_NODE_MAJOR = 22;
/** The first Node 22 whose path stat reports the volume on Windows 11 24H2 and Windows Server 2025. */
export const MINIMUM_WINDOWS_NODE_22_MINOR = 17;
/** The LTS lines every release is verified on (src/verification-receipt.mjs). */
export const SUPPORTED_NODE_LTS_MAJORS = Object.freeze([22, 26]);
export const EDITOR_MINIMUM_NODE_MAJOR = 20;

function parts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(String(version ?? '').trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/** What a shell or installed engine needs on `platform`, in words. */
export function requiredNode(platform = process.platform) {
  return platform === 'win32' ? `${MINIMUM_NODE_MAJOR}.${MINIMUM_WINDOWS_NODE_22_MINOR} or newer (not 23)` : `${MINIMUM_NODE_MAJOR} or newer`;
}

/** Why `version` cannot run a shell or installed engine on `platform`, or null when it can. */
export function nodeVersionProblem(version, platform = process.platform) {
  const found = parts(version);
  if (!found) return `Could not determine the Node.js version from '${String(version ?? '').trim() || 'unknown'}'.`;
  const windows = platform === 'win32';
  if (found.major < MINIMUM_NODE_MAJOR
      || (windows && found.major === MINIMUM_NODE_MAJOR && found.minor < MINIMUM_WINDOWS_NODE_22_MINOR)
      || (windows && found.major === 23)) {
    return `Node.js ${requiredNode(platform)} is required; found ${String(version).trim()}.`;
  }
  return null;
}

/** Whether this process's Node meets the requirement, and which one applies to it. */
export function nodeRequirement(versions = process.versions, platform = process.platform) {
  const editor = Boolean(versions.electron);
  const version = String(versions.node ?? '');
  const major = Number(version.split('.')[0]);
  const minimum = editor ? EDITOR_MINIMUM_NODE_MAJOR : MINIMUM_NODE_MAJOR;
  const met = editor ? Number.isInteger(major) && major >= minimum : Number.isInteger(major) && nodeVersionProblem(version, platform) === null;
  return { version, major, minimum, editor, met, required: editor ? `${EDITOR_MINIMUM_NODE_MAJOR} or newer` : requiredNode(platform) };
}
