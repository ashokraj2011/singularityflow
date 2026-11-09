/** Compatibility exports; lexical rules are pure, and native path syntax is explicitly bound. */
export {POLYGLOT_STRUCTURAL_LANGUAGES,maskPolyglotNonCode,extractPolyglotSymbols,extractPolyglotImports} from './kernel/polyglot-lexical.mjs';
export {resolvePolyglotLocal} from './engine-compatibility/node-source-analysis.mjs';
