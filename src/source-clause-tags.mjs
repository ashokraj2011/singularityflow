/** Native content cache over shared source-comment provenance and clause-tag rules. */
import {createSourceAnalysisCache} from './source-analysis-cache.mjs';
import {scanSourceClauseTags as analyzeSourceClauseTags} from './kernel/source-comments.mjs';
const analyzedSourceTags=createSourceAnalysisCache();
export function scanSourceClauseTags(source,{legacy=false,sourcePath=null}={}) {
  const text=String(source??''),analyze=()=>analyzeSourceClauseTags(text,{legacy,sourcePath});
  if(sourcePath!==null&&typeof sourcePath!=='string')return analyze();
  return analyzedSourceTags(text,JSON.stringify(['source-clause-tags-v1',Boolean(legacy),sourcePath]),analyze);
}
