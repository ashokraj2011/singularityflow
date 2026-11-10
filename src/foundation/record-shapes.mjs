/** Structural value declarations shared by pure rule readers and native schema facades. */
export function freezeRecordShape(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freezeRecordShape(item);Object.freeze(value);}return value;}
export function recordPathMatches(value,{windowsSegments=false}={}){
  return !/[\\:*?"<>|\x00-\x1f\x7f]/u.test(value)&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'
    &&(!windowsSegments||!/[. ]$/u.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)));
}
const UUID=/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
export function parseRecordShape(shape,input){
  const issues=[];
  function visit(rule,value,path){
    const issue=message=>{issues.push({path,message});return value;};
    if(value===undefined&&rule.optional)return value;
    if(value===null&&rule.nullable)return null;
    if(rule.kind==='literal'){if(value!==rule.value)return issue('Invalid input: expected '+JSON.stringify(rule.value));return value;}
    if(rule.kind==='union'){
      const selected=rule.options.find(option=>option.fields?.[rule.discriminator]?.value===value?.[rule.discriminator]);
      return selected?visit(selected,value,path):issue('Invalid input');
    }
    if(rule.kind==='string'||rule.kind==='datetime'){
      if(typeof value!=='string')return issue('Invalid input: expected string, received '+(value===null?'null':typeof value));
      const text=rule.trim?value.trim():value;
      if(rule.minimum!=null&&text.length<rule.minimum)return issue('Too small: expected string to have >='+rule.minimum+' characters');
      if(rule.maximum!=null&&text.length>rule.maximum)return issue('Too big: expected string to have <='+rule.maximum+' characters');
      if(rule.pattern&&!new RegExp(rule.pattern,'u').test(text))return issue('Invalid string: must match pattern /'+rule.pattern+'/u');
      if(rule.path&&!recordPathMatches(text,rule.path))return issue('Invalid input');
      if(rule.uuid&&!UUID.test(text))return issue('Invalid UUID');
      const datePattern=rule.allowMinutePrecision?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/u:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
      if(rule.kind==='datetime'&&(!datePattern.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString().slice(0,10)!==text.slice(0,10)
        ||rule.allowMinutePrecision&&Number(text.slice(11,13))>23))return issue('Invalid ISO datetime');
      return text;
    }
    if(rule.kind==='integer'){
      if(!Number.isSafeInteger(value)||value<rule.minimum){
        if(rule.positive){if(typeof value!=='number'||Number.isNaN(value))return issue('Invalid input: expected number, received '+(Number.isNaN(value)?'NaN':value===null?'null':typeof value));
          if(!Number.isInteger(value))return issue('Invalid input: expected int, received number');
          return issue('Too small: expected number to be >0');}
        return issue(rule.minimum===0?'Invalid input: expected nonnegative integer':'Too small: expected number to be >='+rule.minimum);}
      if(rule.maximum!=null&&value>rule.maximum)return issue('Too big: expected number to be <='+rule.maximum);return value;
    }
    if(rule.kind==='enum'){if(!rule.values.includes(value))return issue('Invalid option: expected one of '+rule.values.map(item=>'"'+item+'"').join('|'));return value;}
    if(rule.kind==='array'){
      if(!Array.isArray(value))return issue('Invalid input: expected array');
      if(rule.minimum!=null&&value.length<rule.minimum)return issue('Too small: expected array to have >='+rule.minimum+' items');
      if(rule.maximum!=null&&value.length>rule.maximum)return issue('Too big: expected array to have <='+rule.maximum+' items');
      return value.map((item,index)=>visit(rule.item,item,[...path,index]));
    }
    if(!value||typeof value!=='object'||Array.isArray(value))return issue('Invalid input: expected object');
    if(rule.kind==='record')return {...value};
    const result={};for(const [key,field]of Object.entries(rule.fields)){const parsed=visit(field,value[key],[...path,key]);if(parsed!==undefined||Object.hasOwn(value,key))result[key]=parsed;}
    const unknown=Object.keys(value).filter(key=>!Object.hasOwn(rule.fields,key));if(unknown.length)issue('Unrecognized keys: '+unknown.join(', '));
    return result;
  }
  const data=visit(shape,input,[]);return issues.length?{success:false,error:{issues}}:{success:true,data};
}
