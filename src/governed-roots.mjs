/**
 * The governed configuration roots: every directory repository initialization writes.
 *
 * A leaf module so path classification (application paths, the Copilot edit guard that runs on every
 * tool call) does not load the configuration loader. Importing this one constant from config.mjs
 * pulled about 200 modules into each hook process. config.mjs re-exports it unchanged.
 */
import { governedInitializationRoot, INITIALIZATION_MAPPINGS } from './initialization-assets.mjs';

export const GOVERNED_ROOTS = Object.freeze([
  ...new Set(INITIALIZATION_MAPPINGS.map(([, destination]) => governedInitializationRoot(destination)))
]);
