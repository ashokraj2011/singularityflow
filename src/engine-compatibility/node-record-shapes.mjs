/** Preserve existing public Zod schema APIs from the kernel's structural declarations. */
import {z} from 'zod';
import {recordPathMatches} from '../foundation/record-shapes.mjs';
export function nativeRecordShape(rule){
  let value;
  if(rule.kind==='string'){
    value=z.string();if(rule.trim)value=value.trim();if(rule.minimum!=null)value=value.min(rule.minimum);if(rule.maximum!=null)value=value.max(rule.maximum);
    if(rule.pattern)value=value.regex(new RegExp(rule.pattern,'u'));if(rule.path)value=value.refine(input=>recordPathMatches(input,rule.path));if(rule.uuid)value=value.uuid();
  }else if(rule.kind==='datetime')value=z.string().datetime();
  else if(rule.kind==='enum')value=z.enum(rule.values);
  else if(rule.kind==='literal')value=z.literal(rule.value);
  else if(rule.kind==='integer'){value=z.number().int();value=rule.positive?value.positive():value.min(rule.minimum);if(rule.maximum!=null)value=value.max(rule.maximum);}
  else if(rule.kind==='array'){value=z.array(nativeRecordShape(rule.item));if(rule.minimum!=null)value=value.min(rule.minimum);if(rule.maximum!=null)value=value.max(rule.maximum);}
  else if(rule.kind==='record')value=z.record(z.string(),z.unknown());
  else if(rule.kind==='union')value=z.discriminatedUnion(rule.discriminator,rule.options.map(nativeRecordShape));
  else value=z.strictObject(Object.fromEntries(Object.entries(rule.fields).map(([key,field])=>[key,nativeRecordShape(field)])));
  if(rule.nullable)value=value.nullable();if(rule.optional)value=value.optional();return value;
}
