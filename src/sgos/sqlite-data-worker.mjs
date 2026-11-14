/** Fixed child driver. SQL is stdin data, never JavaScript or a shell argument. */
export async function sqliteDataWorker(){
  const {DatabaseSync,constants}=await import('node:sqlite');
  const {createHash}=await import('node:crypto');
  const hash=s=>createHash('sha256').update(s).digest('hex');
  const sorted=v=>v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(sorted):Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])]));
  const canonical=v=>JSON.stringify(sorted(v),null,2)+'\n';
  let text='',database,sink;
  const quote=s=>'"'+s.replaceAll('"','""')+'"';
  try{
    for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>16777216)throw Error('Data request exceeds its byte limit.');}
    const request=JSON.parse(text),{task,sinkBinding,contractSha256}=request;
    if(!/^sha256:[a-f0-9]{64}$/u.test(contractSha256))throw Error('Bind the actual task contract to the sink receipt.');
    const identity=hash(canonical({query:task.query,datasets:task.datasets,kind:task.kind,batchId:task.batchId}));
    if(identity!==task.requestSha256)throw Error('The data task differs from its exact input digest.');
    if(task.kind==='batch'){
      if(!sinkBinding)throw Error('A batch needs its explicit sink binding.');
      sink=new DatabaseSync(sinkBinding.filename,{readOnly:request.inspectOnly===true});
      sink.exec(request.inspectOnly?'BEGIN':'PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const tables=sink.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
      if(!tables.length&&request.inspectOnly){sink.close();sink=null;process.stdout.write(JSON.stringify({status:'absent',batchId:task.batchId,requestSha256:identity,sinkId:sinkBinding.id}));return;}
      if(!tables.length){
        sink.exec('CREATE TABLE sflow_data_owner(project_id TEXT NOT NULL,sink_id TEXT NOT NULL,schema_version INTEGER NOT NULL); CREATE TABLE sflow_data_batches(batch_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,output_sha256 TEXT NOT NULL,output_json TEXT NOT NULL,contract_sha256 TEXT NOT NULL); CREATE TABLE sflow_data_rows(batch_id TEXT NOT NULL,position INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(batch_id,position));');
        sink.prepare('INSERT INTO sflow_data_owner VALUES(?,?,1)').run(sinkBinding.projectId,sinkBinding.id);
      }else if(tables.length!==3||!['sflow_data_owner','sflow_data_batches','sflow_data_rows'].every(x=>tables.includes(x)))throw Error('The selected sink contains unrelated tables; nothing was overwritten.');
      const owners=sink.prepare('SELECT * FROM sflow_data_owner').all();
      if(owners.length!==1||owners[0].project_id!==sinkBinding.projectId||owners[0].sink_id!==sinkBinding.id||owners[0].schema_version!==1)throw Error('The sink belongs to another project, identity or schema.');
      const retained=sink.prepare('SELECT * FROM sflow_data_batches WHERE batch_id=?').get(task.batchId);
      if(retained){
        if(retained.request_sha256!==identity)throw Object.assign(Error('The batch ID already has another input or transformation.'),{code:'DATA_BATCH_ID_REUSED'});
        const data=JSON.parse(retained.output_json),rows=sink.prepare('SELECT position,row_json FROM sflow_data_rows WHERE batch_id=? ORDER BY position').all(task.batchId);
        if(hash(retained.output_json)!==retained.output_sha256||rows.length!==data.rows.length
          ||rows.some((r,i)=>r.position!==i||r.row_json!==canonical(data.rows[i])))throw Object.assign(Error('The retained sink output differs from its committed receipt.'),{code:'DATA_SINK_CORRUPT'});
        sink.exec('COMMIT');sink.close();sink=null;
        if(request.inspectOnly){process.stdout.write(JSON.stringify({status:'committed',batchId:task.batchId,requestSha256:identity,sinkId:sinkBinding.id,outputSha256:retained.output_sha256,originalContractSha256:retained.contract_sha256}));return;}
        process.stdout.write(JSON.stringify({data,sink:{id:sinkBinding.id,batchId:task.batchId,requestSha256:identity,outputSha256:retained.output_sha256,originalContractSha256:retained.contract_sha256,replayed:true},queryExecuted:false}));
        return;
      }
      if(request.inspectOnly){sink.close();sink=null;process.stdout.write(JSON.stringify({status:'absent',batchId:task.batchId,requestSha256:identity,sinkId:sinkBinding.id}));return;}
    }
    if(typeof DatabaseSync.prototype.setAuthorizer!=='function')throw Object.assign(Error('The selected Node runtime does not support the required SQLite read authorizer.'),{code:'DATA_RUNTIME_UNSUPPORTED'});
    database=new DatabaseSync(':memory:');
    for(const input of task.datasets){
      const data=input.data,columns=data.columns.map(c=>quote(c.name)+' '+({integer:'INTEGER',number:'REAL',text:'TEXT',boolean:'BOOLEAN'}[c.type])+(c.nullable?'':' NOT NULL'));
      database.exec('CREATE TABLE '+quote(input.table)+'('+columns.join(',')+')');
      const insert=database.prepare('INSERT INTO '+quote(input.table)+' VALUES('+data.columns.map(()=>'?').join(',')+')');
      for(const row of data.rows)insert.run(...data.columns.map(c=>typeof row[c.name]==='boolean'?Number(row[c.name]):row[c.name]));
    }
    const functions=new Set(['sum','count','min','max','avg','total','coalesce','ifnull','nullif','round','abs','lower','upper','length','trim','ltrim','rtrim','substr','substring','iif','typeof']);
    database.setAuthorizer((action,a,b)=>[constants.SQLITE_SELECT,constants.SQLITE_READ,constants.SQLITE_RECURSIVE].includes(action)
      ||action===constants.SQLITE_FUNCTION&&functions.has(String(b??a).toLowerCase())?constants.SQLITE_OK:constants.SQLITE_DENY);
    const statement=database.prepare(task.query);
    if(statement.sourceSQL.trim()!==task.query.trim())throw Object.assign(Error('Execute one complete read-only SQL statement.'),{code:'DATA_QUERY_MULTIPLE_STATEMENTS'});
    const names=statement.columns().map(c=>c.name);
    if(!names.length||names.length>64||new Set(names).size!==names.length||names.some(n=>['__proto__','prototype','constructor'].includes(n)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(n)))throw Error('Give each output column a distinct bounded JSON-safe alias.');
    const rows=[];let rowBytes=2;
    for(const row of statement.iterate()){
      if(Object.values(row).some(x=>typeof x==='number'&&!Number.isFinite(x)))throw Object.assign(Error('Query output contains a non-finite number.'),{code:'DATA_OUTPUT_INVALID'});
      rowBytes+=Buffer.byteLength(JSON.stringify(row))+(rows.length?1:0);
      if(rows.length>=10000||rowBytes>4194304)throw Object.assign(Error('Query output exceeds its row or byte limit.'),{code:'DATA_OUTPUT_LIMIT'});
      rows.push({...row});
    }
    const columns=names.map(name=>{
      const present=rows.map(r=>r[name]).filter(x=>x!==null),types=new Set(present.map(x=>typeof x));
      if(types.size>1||types.size&&![...types].every(x=>['number','string'].includes(x)))throw Error('Output columns need a consistent JSON data type.');
      const type=types.has('number')?(present.every(Number.isSafeInteger)?'integer':'number'):'text';
      return {name,type,nullable:rows.some(r=>r[name]===null)};
    });
    const data={schemaVersion:1,profile:'sflow-tabular-snapshot/v1',columns,rows},output=canonical(data);
    if(Buffer.byteLength(output)>4194304)throw Object.assign(Error('Query output exceeds its byte limit.'),{code:'DATA_OUTPUT_LIMIT'});
    database.close();database=null;
    let receipt=null;
    if(sink){
      const digest=hash(output);
      sink.prepare('INSERT INTO sflow_data_batches VALUES(?,?,?,?,?)').run(task.batchId,identity,digest,output,contractSha256);
      const insert=sink.prepare('INSERT INTO sflow_data_rows VALUES(?,?,?)');
      rows.forEach((row,i)=>insert.run(task.batchId,i,canonical(row)));
      sink.exec('COMMIT');sink.close();sink=null;
      receipt={id:sinkBinding.id,batchId:task.batchId,requestSha256:identity,outputSha256:digest,originalContractSha256:contractSha256,replayed:false};
    }
    process.stdout.write(JSON.stringify({data,sink:receipt,queryExecuted:true}));
  }catch(cause){
    try{sink?.exec('ROLLBACK');}catch{}try{sink?.close();}catch{}try{database?.close();}catch{}
    process.stderr.write(JSON.stringify({name:cause.name,message:cause.message,code:cause.code??null}));process.exitCode=1;
  }
}
