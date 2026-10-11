/**
 * What `nextsteps` needs only on some paths, loaded on first use.
 *
 * These modules reach the agent, workspace, initiative and Jira domains, which a fast `nextsteps`
 * must not load at startup. Importing them dynamically one by one keeps every export of each in the
 * VS Code bundle (esbuild cannot tree-shake a dynamic import's namespace); one dynamic import of this
 * module's three static re-exports keeps both the small startup closure and the shaken bundle.
 */
export { groundingRecordRelative } from '../grounding.mjs';
export { readSourceReviewStatus } from '../source-review-lifecycle.mjs';
export { collectInputs } from '../inputs.mjs';
