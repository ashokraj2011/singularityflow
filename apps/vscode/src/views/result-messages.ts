/**
 * The message catalog, typed for the editor and owned by core.
 *
 * The table itself is `src/gateway/messages.mjs`. It started here, and within a day the CLI's home
 * was printing `home.stable-choice` where a sentence belonged — a second vocabulary opening up in
 * the exact place a catalog exists to prevent one. Whichever surface renders first should not be
 * the one that owns the words.
 *
 * What stays here is the TypeScript: the types the card model and page are written against, plus
 * re-exports so nothing else had to learn where the table moved.
 */
import { RESULT_MESSAGES, fill, message } from '../../../../src/gateway/messages.mjs';

export type Slots = Readonly<Record<string, string | number>>;

/** A short label for a row or button, and the longer sentence that explains it. */
export type Message = { readonly label: string; readonly detail?: string };

export { RESULT_MESSAGES, fill, message };
