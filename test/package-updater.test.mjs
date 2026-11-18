import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, runUpdate, loadConfig, inspectPair, timeoutSeconds } from '../runtime/update.mjs';
import { folderMetadata, childrenUrl, folderUrl, selectPackages } from '../runtime/updater/sharepoint.mjs';
import { installPackages, runtimePathFromOutput } from '../runtime/updater/installer.mjs';
import { installPair } from '../runtime/install-pair.mjs';
import { pair } from './helpers/package-updater-artifacts.mjs';
import { localCertificate } from './helpers/package-updater-tls.mjs';
import { standaloneUpdater } from './helpers/package-updater-package.mjs';
import { inventedValue } from './helpers/invented-secrets.mjs';

const exec = promisify(execFile), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), silent = () => {};
async function area(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow folder updater '));
  t.after(() => rm(directory, { recursive:true, force:true, maxRetries:10, retryDelay:100 }));
  return directory;
}
async function writePair(work, fixture) {
  const tarball = path.join(work,'singularity-flow.tgz'), vsix = path.join(work,'singularity-flow.vsix');
  await writeFile(tarball,fixture.cli); await writeFile(vsix,fixture.vsix);
  return {tarball,vsix};
}

test('one positional folder argument and remembered invocation require no extra settings', () => {
  assert.deepEqual(parseOptions(['https://files.sharepoint.com/:f:/s/build?e=a&b=c']), {source:'https://files.sharepoint.com/:f:/s/build?e=a&b=c'});
  assert.deepEqual(parseOptions([]), {});
  assert.deepEqual(parseOptions(['--reinstall']), {reinstall:true});
  assert.deepEqual(parseOptions(['--folder','https://files.sharepoint.com/x','--check-only']), {source:'https://files.sharepoint.com/x',checkOnly:true});
  assert.equal(timeoutSeconds(),900); assert.equal(timeoutSeconds(300),300);
  for (const bad of [60,299,3601,'600ms']) assert.throws(()=>timeoutSeconds(bad));
  assert.throws(()=>folderUrl('http://files.sharepoint.com/x'),/HTTPS/);
  assert.throws(()=>folderUrl(inventedValue('https://user:', 'pass@files.sharepoint.com/x')),/credentials/);
  assert.throws(()=>parseOptions(['--folder']),/requires/);
});

test('public page metadata uses its scoped drive details, preserving literal percent characters', () => {
  const url = new URL('https://files.sharepoint.com/folder');
  url.searchParams.set('id','/sites/team/Shared Documents/SFlow/%20 literal');
  const value = {'.driveUrl':'https://files.sharepoint.com/_api/v2.0/drives/d1','.driveAccessToken':inventedValue('tempauth=t', 'oken%2B123'),'listUrl':'/sites/team/Shared%20Documents'};
  const metadata = folderMetadata('<script>window.context='+JSON.stringify(value)+'</script>',url.href);
  assert.equal(metadata.folder,'SFlow/%20 literal');
  const api = new URL(childrenUrl(metadata));
  assert.equal(api.searchParams.get('tempauth'),'token+123');
  assert.match(api.pathname,/%2520%20literal/);
  const wrapped = 'JSON.parse('+JSON.stringify(JSON.stringify(value))+')';
  assert.equal(folderMetadata(wrapped,url.href).drive,metadata.drive);
  assert.throws(()=>folderMetadata('<html>Sign in</html>',url.href),/public folder/);
  assert.throws(()=>folderMetadata(JSON.stringify({...value,'.driveUrl':'https://other.invalid/drive'}),url.href),/outside/);
});

test('latest pair selection uses dates and refuses missing or ambiguous packages', () => {
  const file=(name,date)=>({name,file:{},size:42,lastModifiedDateTime:date,'@content.downloadUrlNoAuth':'https://files.sharepoint.com/download'});
  const rows=[file('singularity-flow-old.tgz','2026-11-17T00:00:00Z'),file('singularity-flow-current.tgz','2026-11-18T00:00:00Z'),
    file('singularity-flow-current.vsix','2026-11-18T00:00:00Z'),file('other-package.tgz','2026-11-19T00:00:00Z')];
  assert.equal(selectPackages(rows).cli.name,'singularity-flow-current.tgz');
  assert.throws(()=>selectPackages(rows.filter(row=>!row.name.endsWith('.vsix'))),/No .vsix/);
  assert.throws(()=>selectPackages([...rows,file('singularity-flow-another.tgz','2026-11-18T00:00:00Z')]),/equally recent/);
  const undated=rows.map(row=>({...row,lastModifiedDateTime:''}));
  assert.throws(()=>selectPackages(undated),/reliable dates/);
});

test('pair identity rejects mismatched versions/builds and downloaded HTML', async t => {
  const directory=await area(t);
  const inspect=async fixture=>{
    const paths=await writePair(directory,fixture);
    return inspectPair(paths.tarball,paths.vsix);
  };
  const good=pair(); assert.equal((await inspect(good)).version,'0.9.0');
  for (const option of [{vsixVersion:'1.0.0'},{differentBuild:true}]) {
    await assert.rejects(inspect(pair(option)),/do not match|different build/);
  }
  await assert.rejects(inspect({...good,vsix:Buffer.from('<html>Sign in to SharePoint</html>')}),/ZIP/i);
  await assert.rejects(inspect({...good,cli:Buffer.from('<html>Folder</html>')}),/gzip/);
});

test('link is remembered and a repeated run needs no URL; successful stages are cleaned', async t => {
  const directory=await area(t), state=path.join(directory,'state'), fixture=pair(), seen=[];
  const options={environment:{...process.env,SINGULARITY_FLOW_PACKAGE_UPDATER_HOME:state},log:silent,
    downloader:async(url,work)=>{seen.push(url);return writePair(work,fixture);},
    installer:()=>assert.fail('Check-only must not install')};
  await runUpdate({source:'https://files.sharepoint.com/folder?e=cap',checkOnly:true},options);
  await runUpdate({checkOnly:true},options);
  assert.deepEqual(seen,['https://files.sharepoint.com/folder?e=cap','https://files.sharepoint.com/folder?e=cap']);
  const config=await loadConfig(state);
  assert.equal(config.mode,'folder'); assert.equal(Object.hasOwn(config,'artifactKey'),false);
  assert.deepEqual(await readdir(state),['source.json']);
});

test('native installer error is retained, and the next bare run resumes using the saved link', async t => {
  const directory=await area(t), state=path.join(directory,'state'), fixture=pair();
  let calls=0;
  const dependencies={environment:{...process.env,SINGULARITY_FLOW_PACKAGE_UPDATER_HOME:state},log:silent,
    downloader:(url,work)=>writePair(work,fixture),
    installer:async actual=>{calls++;assert.equal(actual.cliSha256,sha(fixture.cli));throw Error('EXACT_INSTALL_RECOVERY_ERROR');}};
  await assert.rejects(runUpdate({source:'https://files.sharepoint.com/folder'},dependencies),/EXACT_INSTALL_RECOVERY_ERROR[\s\S]*retained/);
  const done=await runUpdate({}, {...dependencies,installer:async()=>{calls++;}});
  assert.equal(done.status,'complete');assert.equal(calls,2);
  assert.equal((await readdir(state)).filter(name=>name.startsWith('stage-')).length,1);
});

test('a failed new pair cannot change the remembered good link or invoke installation', async t => {
  const directory=await area(t),state=path.join(directory,'state');
  const dependencies={environment:{...process.env,SINGULARITY_FLOW_PACKAGE_UPDATER_HOME:state},log:silent,
    downloader:(url,work)=>writePair(work,pair()),installer:()=>assert.fail('No installation')};
  await runUpdate({source:'https://files.sharepoint.com/good',checkOnly:true},dependencies);
  await assert.rejects(runUpdate({source:'https://files.sharepoint.com/bad',checkOnly:true},
    {...dependencies,downloader:(url,work)=>writePair(work,pair({differentBuild:true}))}),/different build/);
  assert.equal((await loadConfig(state)).source,'https://files.sharepoint.com/good');
});

test('helper handoff uses structured argv and the selected content hashes', async t => {
  const directory=await area(t);
  const actual={tarball:path.join(directory,'the package.tgz'),vsix:path.join(directory,'the extension.vsix'),
    cliSha256:'a'.repeat(64),vsixSha256:'b'.repeat(64)};
  let invoked=false;
  await installPackages(actual,{nodeResolver:async()=>'/private/node',execute:async(command,args,options)=>{
    invoked=true;assert.equal(command,'/private/node');assert.equal(args[0],path.join(root,'runtime','install-pair.mjs'));
    assert.deepEqual(args.slice(1),['--tarball',actual.tarball,'--vsix',actual.vsix,'--cli-sha256',actual.cliSha256,'--vsix-sha256',actual.vsixSha256]);
    assert.equal(options.cwd,directory);
  }});
  assert.equal(invoked,true);
  assert.equal(runtimePathFromOutput('Preparing private Node\r\nC:\\Users\\User Name\\node.exe\r\n','win32').executable,'C:\\Users\\User Name\\node.exe');
});

test('changed download is rejected before any package execution', async t => {
  const directory=await area(t),fixture=pair(),paths=await writePair(directory,fixture);
  await assert.rejects(installPair({...paths,cliSha256:'0'.repeat(64),vsixSha256:sha(fixture.vsix)},
    {execute:()=>assert.fail('No package may execute')}),/changed before installation/);
});

// install-pair.mjs runs only under the private Node 26 runtime, so this copies a Node 26 host into one: on any other Node
// the test is skipped, and the weekly Node 26 run covers it (landings run on Node 22).
test('real offline npm staging and direct installer handoff run in an isolated private runtime',
  {skip:!/^v26\./u.test(process.version)&&'the private runtime is Node 26; run it on Node 26'},async t => {
  const directory=await area(t),fixture=pair({exerciseReinstall:true}),paths=await writePair(directory,fixture);
  const runtime=path.join(directory,'engine','runtimes','node-'+process.version+'-'+process.platform+'-'+process.arch);
  const executable=path.join(runtime,...(process.platform==='win32'?['node.exe']:['bin','node']));
  await mkdir(path.dirname(executable),{recursive:true});
  await copyFile(process.execPath,executable,constants.COPYFILE_FICLONE);
  // Homebrew's Node uses a separate libnode dylib; official private Node is standalone.
  // Keep the fixture relocation complete while leaving the host installation read-only.
  if (process.platform === 'darwin') {
    const hostLib=path.resolve(path.dirname(process.execPath),'../lib');
    await mkdir(path.join(runtime,'lib'),{recursive:true});
    for (const name of await readdir(hostLib)) {
      if (/^libnode\.\d+\.dylib$/u.test(name)) await copyFile(path.join(hostLib,name),path.join(runtime,'lib',name),constants.COPYFILE_FICLONE);
    }
  }
  const npmCli=process.platform==='win32'
    ? path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')
    : await realpath(path.join(path.dirname(process.execPath),'npm'));
  const npmSource=path.resolve(path.dirname(npmCli),'..');
  const npmTarget=path.join(runtime,...(process.platform==='win32'?['node_modules','npm']:['lib','node_modules','npm']));
  await mkdir(path.dirname(npmTarget),{recursive:true});
  await symlink(npmSource,npmTarget,process.platform==='win32'?'junction':'dir');
  const result=path.join(directory,'result.json'),emptyConfig=path.join(directory,'npmrc');
  await writeFile(emptyConfig,'');
  const standalone=await standaloneUpdater(directory);
  await exec(executable,[path.join(standalone,'runtime','install-pair.mjs'),'--tarball',paths.tarball,'--vsix',paths.vsix,
    '--cli-sha256',sha(fixture.cli),'--vsix-sha256',sha(fixture.vsix),'--reinstall'],{
    env:{...process.env,SFLOW_PAIR_TEST_RESULT:result,NPM_CONFIG_USERCONFIG:emptyConfig,NPM_CONFIG_CACHE:path.join(directory,'cache')},
    timeout:30000
  });
  const installed=JSON.parse(await readFile(result,'utf8'));
  assert.equal(installed.sha256,sha(fixture.cli));assert.equal(await realpath(installed.nodeExecutable),await realpath(executable));
  assert.ok(installed.tarball.startsWith(path.join(directory,'install-inputs')));
  assert.equal((await readFile(installed.tarball)).equals(fixture.cli),true);
  assert.deepEqual(installed.calls,['--list-extensions','--uninstall-extension','--list-extensions','--install-extension','uninstall','install']);
});

test('real HTTPS public-folder listing, paging, cookies and binary downloads through both launchers', async t => {
  const directory=await area(t),fixture=pair();
  const ca=path.join(directory,'server.pem'),certificate=localCertificate();
  await writeFile(ca,certificate.cert);
  let origin;const requests=[];
  const server=https.createServer(certificate,(req,res)=>{
    const url=new URL(req.url,origin);requests.push(url.pathname);
    if(url.pathname==='/share'){
      res.writeHead(302,{Location:'/folder?id='+encodeURIComponent('/sites/team/Shared Documents/SFlow'),'Set-Cookie':'public_link=ready; Path=/; Secure; HttpOnly'});res.end();return;
    }
    if(url.pathname==='/login'){res.end('<html>Sign in</html>');return;}
    assert.match(req.headers.cookie??'',/public_link=ready/);
    assert.equal(req.headers['cache-control'],'no-cache');
    const drive=origin+'/_api/v2.0/drives/d1';
    if(url.pathname==='/folder'){
      res.end('<html><script>window.ctx='+JSON.stringify({'.driveUrl':drive,'.driveAccessToken':inventedValue('tempauth=scope', 'd-public-token'),'listUrl':'/sites/team/Shared Documents'})+'</script></html>');return;
    }
    if(url.pathname.startsWith('/_api/')){
      assert.equal(url.searchParams.get('tempauth'),'scoped-public-token');
      const file=(name,bytes,suffix)=>({name,file:{},size:bytes.length,lastModifiedDateTime:'2026-11-18T00:00:00Z','@content.downloadUrlNoAuth':origin+'/binary/'+suffix});
      const data=url.searchParams.has('cursor')?{value:[file('singularity-flow.vsix',fixture.vsix,'vsix')]}:
        {value:[file('singularity-flow.tgz',fixture.cli,'cli')],'@odata.nextLink':drive+'/root:/SFlow:/children?cursor=p2'};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
    }
    if(url.pathname.startsWith('/binary/')){
      const data=url.pathname.endsWith('cli')?fixture.cli:fixture.vsix;
      res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',data.length);res.end(data);return;
    }
    res.writeHead(404);res.end('Not found');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='https://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const standalone=await standaloneUpdater(directory);
  const state=path.join(directory,'state'),env={...process.env,CURL_CA_BUNDLE:ca,SINGULARITY_FLOW_PACKAGE_UPDATER_HOME:state};
  const args={cwd:root,env,timeout:60000};
  const launch=async values=>process.platform==='win32'
    ? exec('powershell.exe',['-NoLogo','-NoProfile','-File',path.join(standalone,'update-sflow.ps1'),...values],args)
    : exec('/bin/bash',[path.join(standalone,'update-sflow.sh'),...values],args);
  const first=await launch([origin+'/share?e=cap&another=value','--check-only']);
  assert.match(first.stdout,/packages match. Folder link saved/);
  assert.doesNotMatch(first.stdout,/Updating SFlow CLI/);
  assert.doesNotMatch(first.stdout,/scoped-public-token/);
  const repeated=await launch(['--check-only']);
  assert.match(repeated.stdout,/Folder link saved/);
  const ps=await exec('pwsh',['-NoLogo','-NoProfile','-File',path.join(standalone,'update-sflow.ps1'),origin+'/share?e=cap&another=value','--check-only'],args);
  assert.match(ps.stdout,/packages match/);
  // Windows can resolve several executable extensions for one name. Select the first command,
  // rather than joining their paths into an executable that cannot exist.
  const multiple = `function global:Get-Command {
    [CmdletBinding()]param([string]$Name, [string]$CommandType)
    @([pscustomobject]@{Path=$env:SFLOW_TEST_NODE;Source=$env:SFLOW_TEST_NODE},
      [pscustomobject]@{Path='missing-node.exe';Source='missing-node.exe'})
  }
  & $env:SFLOW_TEST_UPDATER $env:SFLOW_TEST_FOLDER --check-only`;
  const multipleResult=await exec(process.platform==='win32'?'powershell.exe':'pwsh',
    ['-NoLogo','-NoProfile','-Command',multiple],{...args,env:{...env,SFLOW_TEST_NODE:process.execPath,
      SFLOW_TEST_UPDATER:path.join(standalone,'update-sflow.ps1'),SFLOW_TEST_FOLDER:origin+'/share?e=cap&another=value'}});
  assert.match(multipleResult.stdout,/packages match/);
  assert.equal(requests.filter(p=>p==='/binary/cli').length,4);
  assert.equal(requests.filter(p=>p==='/binary/vsix').length,4);
  assert.deepEqual(await readdir(state),['source.json']);
  await assert.rejects(launch([origin+'/login','--check-only']),
    error=>/public folder download details/.test(error.stderr));
});
