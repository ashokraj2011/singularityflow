/** Exact forward-amendment origin, shared by its publication, submission and human vote. */
import {namespaceForwardOriginProfile,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
export function namespaceForwardOriginValue(value){
  const profile=namespaceForwardOriginProfile(value);exactObject(value,['schemaVersion','format','amendmentId','proposal','previous']);
  if(value.format!==profile.format||!/^FAM-\d{3,}$/u.test(value.amendmentId??'')||contentReference(value.proposal).namespace!=='evidence')throw Error('Another amendment origin.');
  phasePublicationBindingValue(value.previous);return value;
}
