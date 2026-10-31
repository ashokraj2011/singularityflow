/**
 * The Node.js the engine requires (2026-10-31). Run from a shell or an installed copy it needs
 * Node 26 or newer, the line the managed runtime installs: Node 22.12 to 22.16 and 23 report device
 * 0 for a path stat on Windows 11 24H2 and Windows Server 2025, so every same-file check refuses
 * there. VS Code runs its bundled engine on its own Node (24 in VS Code 1.144), which keeps the floor
 * of the VS Code releases the extension supports.
 */
export const MINIMUM_NODE_MAJOR = 26;
export const EDITOR_MINIMUM_NODE_MAJOR = 20;

/** Whether this process's Node meets the requirement, and which one applies to it. */
export function nodeRequirement(versions = process.versions) {
  const editor = Boolean(versions.electron);
  const minimum = editor ? EDITOR_MINIMUM_NODE_MAJOR : MINIMUM_NODE_MAJOR;
  const major = Number(String(versions.node ?? '').split('.')[0]);
  return { version: String(versions.node ?? ''), major, minimum, editor, met: Number.isInteger(major) && major >= minimum };
}
