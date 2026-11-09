/** Optional Node digest binding for shared source analysis. No file/cache/process or provider I/O. */
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {javascriptDeclarationPolicies} from '../kernel/javascript-declarations.mjs';
const declarations=/* @__PURE__ */ javascriptDeclarationPolicies(NODE_TEXT_DIGESTS);
export const scanJavaScriptDeclarations=/* @__PURE__ */ (()=>declarations.scanJavaScriptDeclarations)();
export {JAVASCRIPT_DECLARATION_SCHEMA,tokenizeJavaScript,eachTitlePattern,analyzeTestDeclarationAssertions} from '../kernel/javascript-declarations.mjs';
export {javascriptSourceComments,scanSourceClauseTags} from '../kernel/source-comments.mjs';
