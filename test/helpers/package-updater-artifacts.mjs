import { gzipSync } from 'node:zlib';
const table = Array.from({ length: 256 }, (_, i) => { let n = i; for (let j=0;j<8;j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc(bytes) { let n = 0xffffffff; for (const b of bytes) n = table[(n ^ b)&255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
export function zip(files) {
  const chunks = [], directory = []; let offset = 0;
  for (const [name, body] of files) {
    const filename = Buffer.from(name), header = Buffer.alloc(30), entry = Buffer.alloc(46), check = crc(body);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6);
    header.writeUInt32LE(check,14); header.writeUInt32LE(body.length,18); header.writeUInt32LE(body.length,22); header.writeUInt16LE(filename.length,26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20,4); entry.writeUInt16LE(20,6); entry.writeUInt16LE(0x800,8);
    entry.writeUInt32LE(check,16); entry.writeUInt32LE(body.length,20); entry.writeUInt32LE(body.length,24); entry.writeUInt16LE(filename.length,28); entry.writeUInt32LE(offset,42);
    chunks.push(header,filename,body); directory.push(entry,filename); offset += header.length+filename.length+body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size,8); end.writeUInt16LE(files.size,10); end.writeUInt32LE(central.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,central,end]);
}
function tar(files) {
  const chunks = [];
  for (const [name, bytes] of files) {
    const h = Buffer.alloc(512); h.write(name); h.write('0000644\0',100); h.write('0000000\0',108); h.write('0000000\0',116);
    h.write(bytes.length.toString(8).padStart(11,'0')+'\0',124); h.write('00000000000\0',136); h.fill(32,148,156); h[156]=48; h.write('ustar\0',257); h.write('00',263);
    h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
export function pair({ version='0.9.0', vsixVersion=version, differentBuild=false, exerciseReinstall=false }={}) {
  const versionSource = Buffer.from("export const VERSION = '"+version+"';\n");
  const build = Buffer.from("export const BUILD_INFO = {commit:'"+'a'.repeat(40)+"',builtAt:'2026-11-18T00:00:00.000Z'};\n");
  const api = Buffer.from("import{writeFile}from'node:fs/promises';export async function installManagedProduct(o){"
    + (exerciseReinstall ? "o.execute('code',['--install-extension',o.vsix],{});await o.executeNode(o.nodeExecutable,['cli.mjs','plugin','install'],{});" : '')
    + "await writeFile(process.env.SFLOW_PAIR_TEST_RESULT,JSON.stringify({tarball:o.tarball,vsix:o.vsix,sha256:o.sha256,nodeExecutable:o.nodeExecutable,calls:globalThis.sflowFixtureCalls}));return{status:'complete',stages:{cli:'verified',vscode:'verified',copilot:'verified',path:'verified'}}}\n");
  const cli = tar(new Map([
    ['package/package.json',Buffer.from(JSON.stringify({name:'singularity-flow',version,type:'module'}))],
    ['package/src/version.mjs',versionSource],['package/src/build-info.mjs',build],
    ['package/runtime/product-install.mjs',api],
    ...(exerciseReinstall ? [
      ['package/src/util.mjs',Buffer.from("let installed=true;globalThis.sflowFixtureCalls=[];export function run(c,a){sflowFixtureCalls.push(a[0]);if(a[0]==='--uninstall-extension')installed=false;if(a[0]==='--install-extension')installed=true;return{status:0,stdout:a[0]==='--list-extensions'&&installed?'singularityflow.singularity-flow-vscode':''};}")],
      ['package/runtime/install.mjs',Buffer.from("export async function installerProcess(c,a){globalThis.sflowFixtureCalls.push(a[2]);return{stdout:'',stderr:''}}")]
    ] : [])
  ]));
  const vsix = zip(new Map([
    ['extension/package.json',Buffer.from(JSON.stringify({publisher:'singularityflow',name:'singularity-flow-vscode',version:vsixVersion}))],
    ['extension/cli/src/version.mjs',versionSource],['extension/cli/src/build-info.mjs',differentBuild?Buffer.from('different build'):build]
  ]));
  return {cli,vsix};
}
