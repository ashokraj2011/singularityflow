/** Bounded private copies of already validated views. A concrete journal supplies freshness tokens. */
export function createValidatedNamespaceViewCache({maximumEntries=8,maximumBytes=8*1024*1024}={}){
  if(!Number.isSafeInteger(maximumEntries)||maximumEntries<1||maximumEntries>64||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>16*1024*1024)
    throw new TypeError('Use bounded validated-view cache limits.');
  const entries=new Map();let bytes=0;
  const remove=key=>{const previous=entries.get(key);if(previous){bytes-=previous.bytes;entries.delete(key);}};
  return Object.freeze({
    get(key,token){const found=entries.get(key);if(!found||found.token!==JSON.stringify(token))return null;
      entries.delete(key);entries.set(key,found);return structuredClone(found.view);},
    put(key,token,view){const size=new TextEncoder().encode(JSON.stringify({scope:view.scope,sequence:view.sequence,sha256:view.sha256,
        state:Object.fromEntries(Object.entries(view.state).map(([name,values])=>[name,[...values]]))})).byteLength;
      remove(key);if(size>maximumBytes)return false;
      while(entries.size>=maximumEntries||bytes+size>maximumBytes)remove(entries.keys().next().value);
      entries.set(key,{token:JSON.stringify(token),view:structuredClone(view),bytes:size});bytes+=size;return true;},
    clear(){entries.clear();bytes=0;}
  });
}
