/** Pure stamp readers shared by About and alignment; never execute package sources. */
import { buildDescription } from './build-info.mjs';

const BUILD_FIELDS = ['commit', 'sourceSha256', 'branch', 'dirty', 'builtAt'];

export function parseStampedBuildInfo(source) {
  if (typeof source !== 'string') return null;
  const info = {};
  for (const key of BUILD_FIELDS) {
    const match = new RegExp(
      `^\\s*${key}:\\s*(null|true|false|"(?:[^"\\\\\\n]|\\\\.)*")\\s*,?\\s*$`, 'mu'
    ).exec(source);
    if (!match) return null;
    try { info[key] = JSON.parse(match[1]); } catch { return null; }
  }
  const text = value => value === null || typeof value === 'string';
  if (!text(info.commit) || !text(info.sourceSha256) || !text(info.branch) || !text(info.builtAt)
      || !(info.dirty === null || typeof info.dirty === 'boolean')) return null;
  return Object.freeze(info);
}

export function parseVersionSource(source) {
  return /^export const VERSION = '([^'\r\n]{1,64})';\r?$/mu.exec(String(source ?? ''))?.[1] ?? null;
}

export function stampedBuildLine(versionSource, buildInfoSource) {
  const version = parseVersionSource(versionSource);
  const info = parseStampedBuildInfo(buildInfoSource);
  return version && info ? parseBuildLine(`${version} (${buildDescription(info)})`) : null;
}

export function parseBuildLine(value) {
  const line = String(value ?? '').trim();
  const match = /^([^\s()]+) \((.+)\)$/u.exec(line);
  if (!match || /[\r\n]/u.test(line)) return null;
  const description = match[2];
  return Object.freeze({ line, version: match[1],
    stamped: !/development checkout|not a stamped package/iu.test(description),
    builtAt: /(?:^| · )built (\S+)$/u.exec(description)?.[1] ?? null });
}

export function compareBuilds(left, right) {
  if (!left || !right) return null;
  if (left.line === right.line) return 0;
  const leftTime = Date.parse(left.builtAt ?? ''), rightTime = Date.parse(right.builtAt ?? '');
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime === rightTime) return null;
  return leftTime < rightTime ? -1 : 1;
}
