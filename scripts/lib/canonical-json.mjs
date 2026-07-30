import { createHash } from 'node:crypto';

const FIELD_ORDER = new Map([
  'schemaVersion', 'sourceLocale', 'baseline', 'units',
  'repository', 'tag', 'commit',
  'id', 'component', 'bundle', 'module', 'key', 'source', 'context', 'protected', 'sourceFingerprint',
  'type', 'value', 'count'
].map((name, index) => [name, index]));

export function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFields(left, right) {
  const leftRank = FIELD_ORDER.get(left);
  const rightRank = FIELD_ORDER.get(right);
  if (leftRank !== undefined || rightRank !== undefined) {
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  return compareOrdinal(left, right);
}

function normalize(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, ancestors));
  if (typeof value !== 'object') throw new TypeError(`canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError('canonical JSON does not support cyclic objects');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON requires plain objects');

  ancestors.add(value);
  const result = {};
  for (const key of Object.keys(value).sort(compareFields)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      ancestors.delete(value);
      throw new TypeError(`canonical JSON field ${key} is not serializable`);
    }
    result[key] = normalize(item, ancestors);
  }
  ancestors.delete(value);
  return result;
}

export function canonicalStringify(value, { trailingNewline = false } = {}) {
  const text = JSON.stringify(normalize(value, new Set()), null, 2).replaceAll('\r\n', '\n');
  return trailingNewline ? `${text}\n` : text;
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalStringify(value, { trailingNewline: true }), 'utf8');
}

export function canonicalHash(value) {
  return createHash('sha256').update(Buffer.from(canonicalStringify(value), 'utf8')).digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
