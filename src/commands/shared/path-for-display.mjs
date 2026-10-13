/** Extracted command implementation; governance remains in the existing kernel APIs. */
import path from 'node:path';

export function pathForDisplay(root, relative) { return path.join(root, relative); }
