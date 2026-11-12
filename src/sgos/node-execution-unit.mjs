/** Explicit Node execution-unit host. No repository configuration, Git, provider or installed registry. */
import {lstat,readFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {canonicalJson,EXECUTION_UNIT_LIMITS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {tryWindowsTaskkill} from '../platform-process-values.mjs';
const nowIso=()=>new Date().toISOString();
import {HASH,fail,exactKeys,stringArray,freezeDeep,seal,sha256,createExecutionUnitManifest,
  validateExecutionUnitManifest,createAgentTaskContract,validateAgentTaskContract} from './node-execution-values.mjs';
export {createExecutionUnitManifest,validateExecutionUnitManifest,createAgentTaskContract,validateAgentTaskContract} from './node-execution-values.mjs';
const MAX_OUTPUT_BYTES = EXECUTION_UNIT_LIMITS.maximumOutputBytes;
const MAX_EVENTS = EXECUTION_UNIT_LIMITS.maximumEvents;
const MAX_SESSIONS = EXECUTION_UNIT_LIMITS.maximumSessions;
const TERMINATION_GRACE_MS = 2_000;

function bytesSha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** A stopped execution cannot wait indefinitely on a read-only host preflight. */
function untilStopped(value,signal) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(callback,result)=>{if(settled)return;settled=true;signal.removeEventListener('abort',stop);callback(result);};
    const stop=()=>finish(reject,signal.reason);
    signal.addEventListener('abort',stop,{once:true});
    Promise.resolve(value).then(result=>finish(resolve,result),error=>finish(reject,error));
    if(signal.aborted)stop();
  });
}

function event(handle, sequence, type, data = {}, priorEventSha256 = null) {
  return seal('execution-event', 'eventSha256', {
    handleSha256: handle.handleSha256,
    sequence,
    priorEventSha256,
    type,
    data,
    recordedAt: nowIso()
  });
}

function executionHandle(manifest, contract, adapterHandle) {
  return seal('execution-handle', 'handleSha256', {
    executionUnitManifestSha256: manifest.manifestSha256,
    contractSha256: contract.contractSha256,
    adapterHandle
  });
}

class BufferedExecution {
  constructor(manifest, contract, run, parentSignal=null) {
    this.manifest = manifest;
    this.contract = contract;
    this.controller = new AbortController();
    const stopFromParent=()=>this.controller.abort(new SingularityFlowError('Execution was cancelled before its next effect.',{code:'SGOS_GEU_STOP_REQUESTED'}));
    parentSignal?.addEventListener('abort',stopFromParent,{once:true});if(parentSignal?.aborted)stopFromParent();
    this.events = [];
    this.result = null;
    this.error = null;
    this.settled = false;
    this.stopReceipt = null;
    this.quiescenceReceipt = null;
    this.handle = executionHandle(manifest, contract, {
      kind: manifest.id, nonceSha256: sha256({ manifest: manifest.manifestSha256, contract: contract.contractSha256 })
    });
    this.push('started', { contractSha256: contract.contractSha256 });
    this.promise = Promise.resolve().then(() => {this.controller.signal.throwIfAborted();return run({
      signal: this.controller.signal,
      emit: (type, data = {}) => this.push(type, data)
    });}).then((result) => {
      this.result = result;
      this.push('completed', { resultSha256: sha256(result) });
    }, (error) => {
      this.error = error;
      this.push('failed', { code: error?.code ?? 'SGOS_GEU_FAILED' });
    }).finally(() => { parentSignal?.removeEventListener('abort',stopFromParent);this.settled = true; });
  }

  push(type, data) {
    const terminal = type === 'completed' || type === 'failed';
    // Reserve the final slot for a terminal event. Otherwise an overflowing producer throws and
    // the promise rejection handler cannot append the failure that makes the stream terminal.
    if (this.events.length >= MAX_EVENTS || (!terminal && this.events.length >= MAX_EVENTS - 1)) {
      fail('Execution Unit event ceiling exceeded.', 'SGOS_GEU_EVENT_LIMIT');
    }
    this.events.push(event(this.handle, this.events.length + 1, type, data,
      this.events.at(-1)?.eventSha256 ?? null));
  }
}

function adapter(manifest, execute, doctor = async () => ({ status: 'ready' })) {
  const sessions = new Map();
  const sessionFor = (handle) => {
    const session = sessions.get(handle?.handleSha256);
    if (!session || canonicalJson(session.handle) !== canonicalJson(handle)) {
      fail('Execution Unit handle is stale or belongs to another adapter.', 'SGOS_GEU_HANDLE_STALE');
    }
    return session;
  };
  return Object.freeze({
    descriptor: () => manifest,
    async doctor(context = {}) {
      const observed = await doctor(context);
      return seal('execution-unit-attestation', 'attestationSha256', {
        executionUnitManifestSha256: manifest.manifestSha256,
        status: observed.status === 'ready' ? 'ready' : 'unavailable',
        capabilities: structuredClone(observed.capabilities ?? manifest.capabilities),
        observedAt: nowIso(),
        diagnosticCode: observed.diagnosticCode ?? null
      });
    },
    async planCapability(request) {
      const required = request?.requiredCapabilities ?? [];
      stringArray(required, 'Capability probe requirements');
      const unavailable = required.filter((name) => manifest.capabilities[name] !== true);
      return freezeDeep({ capable: unavailable.length === 0, unavailable });
    },
    async start(contract,{signal=null}={}) {
      const validated = validateAgentTaskContract(contract, manifest);
      if (sessions.size >= MAX_SESSIONS) {
        for (const [handleSha256, existing] of sessions) {
          if (existing.settled) sessions.delete(handleSha256);
          if (sessions.size < MAX_SESSIONS) break;
        }
      }
      if (sessions.size >= MAX_SESSIONS) {
        fail('Execution Unit concurrent session ceiling exceeded.', 'SGOS_GEU_SESSION_LIMIT');
      }
      const session = new BufferedExecution(manifest, validated, (runtime) => execute(validated, runtime),signal);
      sessions.set(session.handle.handleSha256, session);
      return session.handle;
    },
    async *observe(handle, cursor = 0) {
      const session = sessionFor(handle);
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail('Execution event cursor is invalid.', 'SGOS_GEU_CURSOR_INVALID');
      while (!session.settled || cursor < session.events.length) {
        while (cursor < session.events.length) yield session.events[cursor++];
        if (!session.settled) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async requestStop(handle, request = {}) {
      exactKeys(request, ['reason'], 'Execution stop request');
      if (request.reason != null && (typeof request.reason !== 'string' || !request.reason.trim())) {
        fail('Execution stop reason must be a non-empty string.', 'SGOS_GEU_CONTRACT_INVALID');
      }
      const session = sessionFor(handle);
      const reason = request.reason?.trim() ?? 'Execution stop requested.';
      const reasonSha256 = sha256(reason);
      if (session.stopReceipt) {
        if (session.stopReceipt.reasonSha256 !== reasonSha256) {
          fail('Execution already has a stop decision bound to another reason.',
            'SGOS_GEU_STOP_CONFLICT');
        }
        return session.stopReceipt;
      }
      let acknowledged = false;
      if (!session.settled && !session.controller.signal.aborted) {
        session.controller.abort(new SingularityFlowError(reason, {
          code: 'SGOS_GEU_STOP_REQUESTED'
        }));
        session.push('stop-requested', { reasonSha256 });
        acknowledged = true;
      }
      session.stopReceipt = seal('stop-receipt', 'stopReceiptSha256', {
        handleSha256: session.handle.handleSha256,
        reasonSha256,
        acknowledged,
        requestedAt: nowIso()
      });
      return session.stopReceipt;
    },
    async quiesce(handle) {
      const session = sessionFor(handle);
      await session.promise;
      session.quiescenceReceipt ??= seal('quiescence-receipt', 'quiescenceReceiptSha256', {
        handleSha256: session.handle.handleSha256,
        quiescent: session.error?.quiescenceUnknown !== true,
        eventHeadSha256: session.events.at(-1)?.eventSha256 ?? null,
        observedAt: nowIso()
      });
      return session.quiescenceReceipt;
    },
    async collect(handle) {
      const session = sessionFor(handle);
      await session.promise;
      if (session.error) throw session.error;
      const result = structuredClone(session.result ?? {});
      return freezeDeep({
        kind: 'candidate-result',
        executionUnitManifestSha256: manifest.manifestSha256,
        contractSha256: session.contract.contractSha256,
        output: result.output ?? null,
        outputSha256: sha256(result.output ?? null),
        candidate: result.candidate ?? null,
        usage: result.usage ?? null,
        eventHeadSha256: session.events.at(-1)?.eventSha256 ?? null
      });
    }
  });
}
/** Trusted SGOS host construction. The callback must implement its manifest's actual scope enforcement. */
export {adapter as createOwnedExecutionUnit};

const TRANSLATOR_MANIFEST = createExecutionUnitManifest({
  id: 'deterministic-translator', version: '1.0.0', publisher: 'singularity-flow',
  provider: 'local-kernel', models: [],
  capabilities: { readFiles: false, writeFiles: false, shell: false, subagents: false, worktrees: false },
  sandbox: { kind: 'in-process-pure' }, network: { mode: 'deny' },
  toolPolicy: { mode: 'none' }, risk: { class: 'low' },
  tests: { conformanceReceiptSha256: sha256('sgos-deterministic-translator-v1') }
});

export function createDeterministicTranslatorExecutionUnit() {
  return adapter(TRANSLATOR_MANIFEST, async (contract) => ({
    output: {
      objective: contract.objective,
      acceptanceClauses: [...contract.acceptanceClauses],
      inputs: [...contract.inputs]
    },
    usage: { modelInvocations: 0, assurance: 'deterministic' }
  }));
}

export async function assertPinnedExecutionExecutable(command,signal) {
    signal?.throwIfAborted();
    let info;
    try { info = await lstat(command.executable); } catch (error) {
      signal?.throwIfAborted();
      fail('Generic process Execution Unit executable is unavailable.',
        'SGOS_GEU_EXECUTABLE_MISSING', { causeCode: error?.code ?? null });
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('Generic process Execution Unit executable must remain a regular non-symlink file.',
        'SGOS_GEU_EXECUTABLE_CHANGED');
    }
    signal?.throwIfAborted();
    const observedSha256 = bytesSha256(await readFile(command.executable,{signal}));
    if (observedSha256 !== command.executableSha256) {
      fail('Generic process Execution Unit executable bytes changed after manifest review.',
        'SGOS_GEU_EXECUTABLE_CHANGED', {
          expectedSha256: command.executableSha256,
          observedSha256
        });
    }
  }

/** One SGOS process owner. Stream/spawn errors are reported only after the actual child closes. */
export function executePinnedProcess({command,root,environment,input=null,signal,timeoutMs,maximumOutputBytes=MAX_OUTPUT_BYTES}) {
  signal?.throwIfAborted();
  return new Promise(resolve=>{
    const child=spawn(command.executable,command.arguments,{cwd:root,env:environment,shell:false,
      detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],windowsHide:true});
    const stdout=[],stderr=[];let bytes=0,overflow=false,timedOut=false,forceTimer=null,processError=null,terminating=false;
    const signalTree=force=>{
      if(!child.pid)return;
      if(process.platform==='win32') {
        if(child.exitCode!==null||child.signalCode!==null)return;
        if(!tryWindowsTaskkill(child.pid,{force,environment:process.env,spawnSyncCommand:spawnSync,timeoutMs:5_000}))child.kill(force?'SIGKILL':'SIGTERM');
      }else{
        // A leader can exit while a descendant still holds its pipes. Signal the owned group.
        try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch{try{child.kill(force?'SIGKILL':'SIGTERM');}catch{}}
      }
    };
    const terminate=()=>{if(terminating)return;terminating=true;signalTree(false);
      forceTimer=setTimeout(()=>signalTree(true),TERMINATION_GRACE_MS);forceTimer.unref?.();};
    const closeOwnedGroup=async()=>{
      if(process.platform==='win32'||!child.pid)return;
      const gone=()=>{try{process.kill(-child.pid,0);return false;}catch(cause){if(cause.code==='ESRCH')return true;throw cause;}};
      if(gone())return;
      // Descendants may close their stdio and survive the leader. They are still owned work.
      for(const force of [false,true]){
        signalTree(force);const deadline=Date.now()+TERMINATION_GRACE_MS;
        do{if(gone())return;await new Promise(done=>setTimeout(done,10));}while(Date.now()<deadline);
      }
      if(!gone())throw new SingularityFlowError('The owned execution group did not confirm termination.',{code:'SGOS_GEU_QUIESCENCE_UNCONFIRMED'});
    };
    const append=(target,chunk)=>{const value=Buffer.from(chunk);bytes+=value.length;
      if(bytes>maximumOutputBytes){overflow=true;terminate();}else target.push(value);};
    child.stdout.on('data',chunk=>append(stdout,chunk));child.stderr.on('data',chunk=>append(stderr,chunk));
    const failed=error=>{processError??=error;terminate();};
    child.on('error',failed);child.stdin.on('error',failed);
    const stop=()=>terminate();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    child.on('close',async(status,exitSignal)=>{
      signal?.removeEventListener('abort',stop);clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);
      try{await closeOwnedGroup();}catch(cause){
        cause.quiescenceUnknown=true;
        if(processError){cause.cause??=processError;cause.details={...(cause.details??{}),processError:{name:processError.name??'Error',
          code:processError.code??null,message:processError.message??String(processError)}};}
        processError=cause;
      }
      const error=processError,err=Buffer.concat(stderr);
      resolve({status:status??1,signal:exitSignal,overflow,timedOut,stdout:Buffer.concat(stdout),stderr:err,
        stderrSha256:bytesSha256(err),error});
    });
    try{child.stdin.end(input);}catch(error){failed(error);}
  });
}

export function createGenericProcessExecutionUnit(manifest, {
  root = null,
  authorizeManifest = null
} = {}) {
  const validated = validateExecutionUnitManifest(manifest);
  if (!validated.command) fail('Generic process Execution Unit requires a pinned command manifest.', 'SGOS_GEU_MANIFEST_INVALID');
  if (!root || !path.isAbsolute(root)) {
    fail('Generic process Execution Unit requires a verified absolute working root.',
      'SGOS_GEU_ROOT_REQUIRED');
  }
  if (typeof authorizeManifest !== 'function') {
    fail('Generic process Execution Unit requires registry authorization for its exact manifest.',
      'SGOS_GEU_AUTHORITY_REQUIRED', { manifestSha256: validated.manifestSha256 });
  }
  if (validated.sandbox?.enforcement !== 'external-attested'
      || !HASH.test(String(validated.sandbox?.attestationSha256 ?? ''))
      || validated.network?.mode !== 'deny') {
    fail('Generic process Execution Unit requires an externally attested sandbox and denied network.',
      'SGOS_GEU_SANDBOX_REQUIRED', { manifestSha256: validated.manifestSha256 });
  }

  return adapter(validated, async (contract, runtime) => {
    runtime.signal.throwIfAborted();
    const authorization = await untilStopped(authorizeManifest(validated),runtime.signal);
    runtime.signal.throwIfAborted();
    if (authorization !== true && authorization !== validated.manifestSha256) {
      fail('Generic process Execution Unit manifest is not authorized by the active registry.',
        'SGOS_GEU_AUTHORITY_REQUIRED', { manifestSha256: validated.manifestSha256 });
    }
    if (contract.readScope.length || contract.writeScope.length || contract.allowedDevices.length) {
      fail('The installed generic process profile accepts only pure contracts with no repository or Device scope.',
        'SGOS_GEU_SANDBOX_SCOPE_UNSUPPORTED', {
          readScope: contract.readScope.length,
          writeScope: contract.writeScope.length,
          allowedDevices: contract.allowedDevices.length
        });
    }
    await untilStopped(assertPinnedExecutionExecutable(validated.command,runtime.signal),runtime.signal);
    runtime.signal.throwIfAborted();
    const allowedEnvironment = Object.fromEntries(validated.command.environmentAllowlist
      .filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]]));
    const result = await executePinnedProcess({command:validated.command,root,environment:allowedEnvironment,
      input:canonicalJson(contract),signal:runtime.signal,timeoutMs:contract.budgets.activeMinutes*60_000});
    if(result.error)throw result.error;
    if (result.status !== 0 || result.overflow || result.timedOut) {
      const error = new SingularityFlowError('Generic Execution Unit process failed.', {
        code: result.overflow ? 'SGOS_GEU_OUTPUT_LIMIT'
          : result.timedOut ? 'SGOS_GEU_TIMEOUT' : 'SGOS_GEU_PROCESS_FAILED',
        details: { status: result.status, signal: result.signal, timedOut: result.timedOut }
      });
      error.uncertainEffect = contract.writeScope.length > 0;
      throw error;
    }
    let output;
    try { output = JSON.parse(result.stdout.toString('utf8')); } catch {
      fail('Generic Execution Unit returned invalid JSON.', 'SGOS_GEU_RESULT_INVALID');
    }
    return { output };
  }, async () => {
    try { await assertPinnedExecutionExecutable(validated.command); return { status: 'ready' }; }
    catch (error) {
      return {
        status: 'unavailable',
        diagnosticCode: error?.code ?? 'SGOS_GEU_EXECUTABLE_MISSING'
      };
    }
  });
}


/** Trusted provider composition, never task inputs. */
export {untilStopped as untilExecutionStopped,adapter as createExecutionUnitAdapter,sha256 as executionUnitSha256,TRANSLATOR_MANIFEST as DETERMINISTIC_EXECUTION_UNIT_MANIFEST};
