/** Typed, defensive adapters shared by the new CLI-backed surfaces. */

export interface CommandEnvelope<T> {
  readonly schemaVersion?: number;
  readonly data?: T;
}

export function commandData<T>(value: unknown): T {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'data')) {
    return (value as CommandEnvelope<T>).data as T;
  }
  return value as T;
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function bounded(value: unknown, maximum = 240): string {
  const source = text(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return source.length <= maximum ? source : `${source.slice(0, maximum - 1)}…`;
}

/** Paths stay in the extension host; webviews receive only their final display-safe name. */
export function basenameOnly(value: unknown): string {
  const source = text(value);
  return source.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

/** A second rendering boundary for sanitized fault text: never disclose a host path to the DOM. */
export function publicFaultText(value: unknown, maximum = 240): string {
  return bounded(value, maximum)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s<>:"|?*]+[\\/])+[^\s<>:"|?*]*/g, '[local path]');
}

export function publicVerificationArgv(argv: unknown): string {
  if (!Array.isArray(argv)) return '[]';
  return JSON.stringify(argv.map((argument, index) => {
    if (typeof argument !== 'string') return '[invalid]';
    if (/^(?:[A-Za-z]:\\|\/)/.test(argument)) return index === 0 ? basenameOnly(argument) : '[local path]';
    return argument;
  }));
}

export function dateValue(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}
