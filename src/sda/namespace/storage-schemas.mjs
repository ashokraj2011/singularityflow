/** Frozen durable families shared with the central migration registry. A successor gets another identity. */
import { admitRecordSchemaVersion, NAMESPACE_STORAGE_SCHEMAS, SQLITE_NAMESPACE_SCHEMAS } from '../../foundation/record-schema.mjs';
import { namespaceError } from './values.mjs';

export { NAMESPACE_STORAGE_SCHEMAS, SQLITE_NAMESPACE_SCHEMAS };

export function admitNamespaceStorageSchema(kind, value) {
  return admitStorageSchema(NAMESPACE_STORAGE_SCHEMAS, kind, value);
}

export function admitSqliteNamespaceSchema(kind, value) {
  return admitStorageSchema(SQLITE_NAMESPACE_SCHEMAS, kind, value);
}

function admitStorageSchema(definitions, kind, value) {
  if (!Object.hasOwn(definitions, kind)) throw namespaceError('Unknown namespace storage family.');
  try { return admitRecordSchemaVersion(definitions[kind], value); }
  catch (cause) {
    if (['SCHEMA_VERSION_FUTURE', 'SCHEMA_VERSION_ARCHIVED'].includes(cause.code)) {
      throw namespaceError(cause.message, 'SDA_NAMESPACE_UNSUPPORTED', cause.details, cause);
    }
    throw cause;
  }
}
