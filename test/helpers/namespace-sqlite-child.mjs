/** Native SQLite crash/response-loss probes, excluded from distribution. */
import * as sqlite from 'node:sqlite';
const request = JSON.parse(process.argv[2]);

if (request.hold) {
  const database = new sqlite.DatabaseSync(request.filename);
  database.exec('BEGIN IMMEDIATE');
  process.stdout.write('ready\n');
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 5000);
    const finish = () => { clearTimeout(timeout); resolve(); };
    process.stdin.once('data', finish); process.stdin.once('end', finish);
  });
  database.exec('ROLLBACK'); database.close();
} else {
  if (request.fault) {
    const { mock } = await import('node:test');
    class ProbeDatabase extends sqlite.DatabaseSync {
      exec(sql) {
        const command = sql.trim().toUpperCase(), publication = command === 'COMMIT' && this.writing === true;
        if (publication && request.fault === 'before-commit') process.kill(process.pid, 'SIGKILL');
        const result = super.exec(sql);
        if (command === 'BEGIN IMMEDIATE') this.writing = true;
        if (command === 'COMMIT' || command === 'ROLLBACK') this.writing = false;
        if (publication && request.fault === 'after-commit') process.kill(process.pid, 'SIGKILL');
        if (publication && request.fault === 'lost-response') {
          throw Object.assign(new Error('fixture commit acknowledgement timed out'), { code: 'ETIMEDOUT' });
        }
        return result;
      }
      prepare(sql) {
        const statement = super.prepare(sql);
        if (request.fault !== 'refused-write' || !sql.startsWith('INSERT INTO sflow_ns_entries')) return statement;
        return new Proxy(statement, { get(target, key) {
          if (key === 'run') return () => { throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' }); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
    }
    mock.module(new URL('../../src/sda/sqlite-native.mjs', import.meta.url).href, { namedExports: {
      async openNativeSqliteDatabase(filename) {
        const database = new ProbeDatabase(filename);
        database.enableDefensive(true); database.enableLoadExtension(false);
        return database;
      }
    } });
  }
  const { createSqliteNamespaceStore } = await import('../../src/sda/sqlite-namespace-adapter.mjs');
  let adapter;
  try {
    adapter = await createSqliteNamespaceStore({ filename: request.filename, binding: { kind: 'shared' }, create: request.create ?? false });
    const result = request.read ? await adapter.read(request.scope, 'state', request.read)
      : await adapter.transact(request.scope, request.transaction);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code, causeCode: error.cause?.code ?? null,
      sqliteCode: error.cause?.errcode ?? null, details: error.details }));
  } finally { adapter?.close(); }
}
