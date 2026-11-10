/** Exact bounded line positions over explicit text. No Git, filesystem, clock or whole-file fallback. */
import {SingularityFlowError} from '../foundation/failures.mjs';
export const SOURCE_TEXT_DIFF_PROFILE='sflow-source-text-hunks/v1';
export const SOURCE_TEXT_DIFF_LIMITS=Object.freeze({maximumTextUnits:2097152,maximumWork:2000000,maximumTraceCells:1000000});
const invalid=message=>{throw new SingularityFlowError(message,{code:'ENGINE_SOURCE_DIFF_INPUT_INVALID'});};
const lines=text=>text.match(/[^\n]*\n|[^\n]+$/gu)??[];
export function sourceTextHunks(before,after,options={}){
  if(typeof before!=='string'||typeof after!=='string'||before.includes('\0')||after.includes('\0'))invalid('Line positions require explicit text without binary NUL bytes.');
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!Object.hasOwn(SOURCE_TEXT_DIFF_LIMITS,key)))invalid('Use only the declared line-diff limits.');
  const limits={...SOURCE_TEXT_DIFF_LIMITS,...options};for(const [key,maximum]of Object.entries(SOURCE_TEXT_DIFF_LIMITS))
    if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>maximum)invalid('Line-diff limits cannot exceed the supported profile.');
  let work=0,traceCells=0;
  const limited=(limit,observed)=>{throw new SingularityFlowError('Exact source-line comparison exceeded its declared bound.',{
    code:'ENGINE_SOURCE_DIFF_LIMIT',details:{profile:SOURCE_TEXT_DIFF_PROFILE,limit,maximum:limits[limit],observed}});};
  for(const text of [before,after])if(text.length>limits.maximumTextUnits)limited('maximumTextUnits',text.length);
  const step=()=>{if(++work>limits.maximumWork)limited('maximumWork',work);};
  const left=lines(before);if(before===after)return {profile:SOURCE_TEXT_DIFF_PROFILE,beforeLines:left.length,afterLines:left.length,hunks:[],work,traceCells};
  const right=lines(after);let prefix=0,suffix=0;
  while(prefix<left.length&&prefix<right.length){step();if(left[prefix]!==right[prefix])break;prefix++;}
  while(prefix+suffix<left.length&&prefix+suffix<right.length){step();if(left[left.length-1-suffix]!==right[right.length-1-suffix])break;suffix++;}
  const a=left.slice(prefix,left.length-suffix),b=right.slice(prefix,right.length-suffix),n=a.length,m=b.length,trace=[],frontier=new Map([[1,0]]);
  let edits;
  if(!n)edits=Array.from({length:m},()=>'+');else if(!m)edits=Array.from({length:n},()=>'-');
  else search:for(let distance=0;distance<=n+m;distance++){
    traceCells+=frontier.size;if(traceCells>limits.maximumTraceCells)limited('maximumTraceCells',traceCells);trace.push(new Map(frontier));
    for(let diagonal=-distance;diagonal<=distance;diagonal+=2){
      step();const down=diagonal===-distance||(diagonal!==distance&&(frontier.get(diagonal-1)??-Infinity)<(frontier.get(diagonal+1)??-Infinity));
      let x=down?(frontier.get(diagonal+1)??0):(frontier.get(diagonal-1)??0)+1,y=x-diagonal;
      while(x<n&&y<m){step();if(a[x]!==b[y])break;x++;y++;}frontier.set(diagonal,x);
      if(x<n||y<m)continue;
      edits=[];x=n;y=m;
      for(let depth=trace.length-1;depth>=0;depth--){
        const previous=trace[depth],key=x-y,down=key===-depth||(key!==depth&&(previous.get(key-1)??-Infinity)<(previous.get(key+1)??-Infinity)),
          previousKey=down?key+1:key-1,previousX=previous.get(previousKey)??0,previousY=previousX-previousKey;
        while(x>previousX&&y>previousY){step();edits.push('=');x--;y--;}
        if(depth===0)break;step();if(x===previousX){edits.push('+');y--;}else{edits.push('-');x--;}
      }
      edits.reverse();break search;
    }
  }
  if(!edits)throw new SingularityFlowError('Exact source comparison did not produce a complete edit path.',{code:'ENGINE_SOURCE_DIFF_INVALID'});
  const hunks=[];let oldLine=prefix,newLine=prefix,current=null;
  const finish=()=>{if(!current)return;hunks.push({beforeStart:current.beforeLines?current.oldLine+1:current.oldLine,beforeLines:current.beforeLines,
    afterStart:current.afterLines?current.newLine+1:current.newLine,afterLines:current.afterLines});current=null;};
  for(const edit of edits){step();if(edit==='='){finish();oldLine++;newLine++;continue;}
    current??={oldLine,newLine,beforeLines:0,afterLines:0};if(edit==='-'){current.beforeLines++;oldLine++;}else{current.afterLines++;newLine++;}}
  finish();if(oldLine!==left.length-suffix||newLine!==right.length-suffix)throw new SingularityFlowError('Source comparison lost a line boundary.',{code:'ENGINE_SOURCE_DIFF_INVALID'});
  return {profile:SOURCE_TEXT_DIFF_PROFILE,beforeLines:left.length,afterLines:right.length,hunks,work,traceCells};
}
