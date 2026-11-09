/** Native cache and optional persisted facts over the shared declaration value rules. */
import {createSourceAnalysisCache} from '../source-analysis-cache.mjs';
import {getCachedVerificationFact} from './incremental-verification-graph.mjs';
import {scanJavaScriptDeclarations as analyzeJavaScriptDeclarations} from '../engine-compatibility/node-source-analysis.mjs';
import {JAVASCRIPT_DECLARATION_SCHEMA} from '../kernel/javascript-declarations.mjs';
export {JAVASCRIPT_DECLARATION_SCHEMA,tokenizeJavaScript,eachTitlePattern,analyzeTestDeclarationAssertions} from '../kernel/javascript-declarations.mjs';
const analyzedDeclarations=createSourceAnalysisCache();
export function scanJavaScriptDeclarations(source,{sourcePath,framework,root=null,persist=false}={}) {
  const text=String(source??''),analyze=()=>analyzeJavaScriptDeclarations(text,{sourcePath,framework});
  if(root)return getCachedVerificationFact('javascript-declarations',text,
    {sourcePath:sourcePath??null,framework:framework??null},analyze,{root,persist});
  if(typeof sourcePath!=='string'||typeof framework!=='string')return analyze();
  return analyzedDeclarations(text,JSON.stringify([JAVASCRIPT_DECLARATION_SCHEMA,sourcePath,framework]),analyze);
}
