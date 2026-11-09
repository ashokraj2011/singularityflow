/** Input vectors only; the native baseline supplies expected outcomes. */
const question={question:'Which limit applies?',answer:'Use 255.'};
const first={id:'Q-001',...question,status:'answered',blocking:false};
export function clarificationValueCases() {
  const rows=[];
  const add=(id,method,...args)=>rows.push({id,method,args});
  for(const [id,value]of [['basic',question],['trim',{question:'  Which limit? ',answer:' 255 ',why:' Bound the inputs ',owner:' Reviewer ',impact:' Scope '}],
    ['numeric',{question:255,answer:16,id:7}],['deferred',{...question,status:'deferred',blocking:true}],['nonblocking-deferred',{...question,status:'deferred'}],
    ['answered-blocking',{...question,blocking:true}],['missing-question',{answer:'255'}],['missing-answer',{question:'Limit?'}],
    ['unknown-status',{...question,status:'pending'}],['null',null],['array',[]],['marker',{...question,marker:'  Which   limit?  '}],
    ['marker-object',{...question,marker:{question:'Limit?',questionHash:' Limit? '}}],['empty-marker',{...question,marker:{question:''}}],
    ['deferred-marker',{...question,status:'deferred',marker:'Limit?'}],['empty-id',{...question,id:''}],['zero-id',{...question,id:0}],
    ['unknown-field',{...question,extra:'ignored'}]])add('response-'+id,'normalizeResponse',value,2);
  for(const [id,value]of [['none',null],['empty',''],['whitespace','  '],['object',{}],['question',' How   many? '],
    ['hash',{question:'Current wording?',questionHash:' Original   wording? '}],['numeric',12]])add('marker-'+id,'normalizeMarkerBinding',value,0);
  for(const [id,previous,current]of [['new',[],[question]],['exact',[first],[question]],['exact-id',[first],[first]],
    ['different-id',[first],[{...first,id:'different'}]],['changed-answer',[first],[{...question,answer:'Use 127.'}]],
    ['changed-question',[first],[{...first,question:'A changed question?'}]],['append',[first],[{question:'Which output?',answer:'Uppercase.'}]],
    ['repeated-input',[],[question,question]],['duplicate-id',[],[first,{...first,question:'Another question?'}]],
    ['reason-change',[first],[{...first,why:'A new explanation.'}]]])add('merge-'+id,'mergeResponses',previous,current);
  for(const [id,payload]of [['array',[question]],['responses',{responses:[question]}],['questions',{questions:[question]}],
    ['empty-responses',{responses:[],questions:[question]}],['null-responses',{responses:null,questions:[question]}],['missing',{}],['null',null]])add('payload-'+id,'responseArrayFromPayload',payload);
  for(const [id,record]of [['missing',null],['empty',{responses:[]}],['markers',{responses:[{marker:{questionHash:'Limit?'}},{marker:{questionHash:'Limit?'}},{answer:'Other'}]}]])add('answered-'+id,'answeredMarkerHashes',record);
  for(const [id,value]of [['off',{mode:'off',errors:['ignored'],record:null}],['required-missing',{mode:'required',errors:['missing'],record:null}],
    ['when-needed',{mode:'when-needed',errors:[],record:null}],['ready',{mode:'required',errors:[],record:{responses:[question]}}]])add('routes-'+id,'clarificationRoutes',value);
  return rows;
}
export function clarificationFoldCases() {
  return [
    {id:'first',responses:[question]},
    {id:'exact-retry',previous:[question],responses:[question]},
    {id:'append',previous:[question],responses:[{question:'Which output?',answer:'Uppercase.'}]},
    {id:'conflicting',previous:[question],responses:[{...question,answer:'Use 127.'}]},
    {id:'replace',previous:[question],responses:[{...question,answer:'Use 127.'}],replace:true},
    {id:'deferred',responses:[{...question,status:'deferred',blocking:true}]},
    {id:'nonblocking-deferred',responses:[{...question,status:'deferred'}]},
    {id:'maximum',maxQuestions:1,responses:[question,{question:'Which output?',answer:'Uppercase.'}]},
    {id:'duplicate-id',responses:[{...question,id:'same'},{question:'Which output?',answer:'Uppercase.',id:'same'}]},
    {id:'marker',responses:[{...question,marker:'Which limit applies?'}]},
    {id:'empty',responses:[]},
    {id:'not-array',responses:null}
  ];
}
