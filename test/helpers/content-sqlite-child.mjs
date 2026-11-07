/** Native content acceptance probes. No test hook is added to the production adapter. */
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { createSqliteContentStore } from '../../src/sda/sqlite-content-adapter.mjs';

const request = JSON.parse(process.argv[2]);
const database = new DatabaseSync(request.filename);
database.exec('PRAGMA busy_timeout=5000');
let armed = false;
const port = {
  prepare: database.prepare.bind(database),
  exec(sql) {
    const publication = armed && sql === 'COMMIT';
    if (publication && request.fault === 'before-commit') {
      writeSync(1, 'before-commit\n'); process.kill(process.pid, 'SIGKILL');
    }
    const result = database.exec(sql);
    if (publication && request.fault === 'after-commit') {
      writeSync(1, 'after-commit\n'); process.kill(process.pid, 'SIGKILL');
    }
    return result;
  }
};
try {
  const store = createSqliteContentStore({ database: port, binding: { kind: 'shared' }, create: request.create ?? false });
  armed = true;
  const result = await store.put(request.scope, 'evidence', Buffer.alloc(request.bytes, 43));
  process.stdout.write(JSON.stringify(result));
} finally { database.close(); }
