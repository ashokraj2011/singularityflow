/** Native connection construction stays outside the engine and namespace contracts. */
import { namespaceError } from './namespace/values.mjs';

export async function openNativeSqliteDatabase(filename) {
  let module;
  try { module = await import('node:sqlite'); }
  catch (cause) {
    throw namespaceError('SQLite namespace storage requires the managed Node 26 runtime or a compatible host.',
      'SDA_NAMESPACE_UNSUPPORTED', { stage: 'database-runtime' }, cause);
  }
  const database = new module.DatabaseSync(filename);
  try {
    if (typeof database.enableDefensive !== 'function' || typeof database.enableLoadExtension !== 'function') {
      throw namespaceError('SQLite namespace storage requires the managed Node 26 runtime or a compatible host.', 'SDA_NAMESPACE_UNSUPPORTED');
    }
    database.enableDefensive(true); database.enableLoadExtension(false);
    return database;
  } catch (cause) { try { database.close(); } catch {} throw cause; }
}
