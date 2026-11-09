/** Test-only Git discovery. Production capability construction always receives a pinned program. */
import {realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export async function pinnedLocalGit(){
  for(const directory of (process.env.PATH??'').split(path.delimiter))try{
    const executable=await realpath(path.join(directory,process.platform==='win32'?'git.exe':'git'));
    return {executable,executableSha256:'sha256:'+createHash('sha256').update(await readFile(executable)).digest('hex')};
  }catch{}
  throw Error('A real local Git installation is required for this qualification.');
}
