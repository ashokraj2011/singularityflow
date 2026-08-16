import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The root of the installed Singularity Flow package.
 *
 * This is the ESM implementation used by the CLI. The VS Code build replaces this module with a
 * CommonJS-safe implementation whose root is the staged `cli/` directory beside the extension
 * bundle. Keeping the host-specific resolution at this boundary prevents core modules from
 * embedding `import.meta` in the CommonJS bundle.
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
