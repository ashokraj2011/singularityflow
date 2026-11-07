/** Frozen durable families shared with the central migration registry. A successor gets another identity. */
import { admitRecordSchemaVersion, NAMESPACE_STORAGE_SCHEMAS } from '../../foundation/record-schema.mjs';
import { namespaceError } from './values.mjs';

export { NAMESPACE_STORAGE_SCHEMAS };

export function admitNamespaceStorageSchema(kind, value) {
  if (!Object.hasOwn(NAMESPACE_STORAGE_SCHEMAS, kind)) throw namespaceError('Unknown namespace storage family.');
  try { return admitRecordSchemaVersion(NAMESPACE_STORAGE_SCHEMAS[kind], value); }
  catch (cause) {
    if (['SCHEMA_VERSION_FUTURE', 'SCHEMA_VERSION_ARCHIVED'].includes(cause.code)) {
      throw namespaceError(cause.message, 'SDA_NAMESPACE_UNSUPPORTED', cause.details, cause);
    }
    throw cause;
  }
}
