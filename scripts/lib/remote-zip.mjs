import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { inflateRawSync } from 'node:zlib';
import { isDeniedSourceInput } from './source-isolation.mjs';
import { NETWORK_HOSTS, validateHttpsUrl } from './network-policy.mjs';

const PINNED = Object.freeze({
  endpoint: 'https://update.code.visualstudio.com/1.129.1/win32-x64-archive/stable',
  finalHost: 'vscode.download.prss.microsoft.com',
  commit: '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8',
  artifactSize: 310_678_641,
  coreEntry: '8a7abeba6e/resources/app/out/nls.metadata.json',
  coreCompressedStart: 176_656_758,
  coreCompressedEnd: 177_094_827,
  coreInflatedSize: 2_142_742,
  coreSha256: '972e95e10c9c22130fc2133da57f972a947640cc38a0e5bff537c338ab724c37'
});

const DEFAULT_BUDGETS = Object.freeze({
  maxRedirects: 4,
  maxTailBytes: 65_557,
  maxCentralDirectoryBytes: 16 * 1024 * 1024,
  maxEntries: 20_000,
  maxNameBytes: 1_024,
  maxExtraBytes: 64 * 1024,
  maxCommentBytes: 64 * 1024,
  maxCompressedEntryBytes: 310_678_641,
  maxInflatedEntryBytes: 1024 * 1024 * 1024,
  requestTimeoutMs: 30_000
});

const LOCALIZED_CATALOG = /^package\.nls\..+\.json$/i;

function fail(message) {
  throw new Error(`remote ZIP rejected: ${message}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function mergeBudgets(overrides = {}) {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid budget ${name}`);
  }
  return Object.freeze(budgets);
}

function normalizeEntryName(rawName, budgets) {
  if (typeof rawName !== 'string' || rawName.length === 0) fail('empty entry name');
  if (Buffer.byteLength(rawName, 'utf8') > budgets.maxNameBytes) fail('entry name exceeds budget');
  if (rawName.includes('\0')) fail('entry name contains NUL');
  if (rawName.includes('\\')) fail('entry name contains a backslash');
  if (rawName.startsWith('/') || /^[A-Za-z]:\//.test(rawName)) fail('entry name is absolute');
  const parts = rawName.split('/');
  if (parts.some(part => part === '..' || part === '.')) fail('entry name contains traversal');
  const normalized = parts.join('/');
  return normalized;
}

function httpsRequest(url, { method = 'GET', headers = {}, maxBytes = 0, timeoutMs = DEFAULT_BUDGETS.requestTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`request timed out: ${method}`)), timeoutMs);
    timer.unref?.();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const req = request(url, { method, headers, signal: controller.signal }, response => {
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (maxBytes && received > maxBytes) {
          req.destroy(new Error(`response exceeded ${maxBytes} byte budget`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', error => finish(reject, error));
      response.on('end', () => finish(resolve, {
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', error => finish(reject, error));
    req.end();
  });
}

async function resolvePinnedArtifact(endpoint, expected, budgets) {
  let current = new URL(endpoint);
  for (let redirects = 0; redirects <= budgets.maxRedirects; redirects += 1) {
    try { current = validateHttpsUrl(current, { exactHosts: NETWORK_HOSTS.vscodeArtifact, label: 'artifact URL' }); } catch (error) { fail(error.message); }
    const response = await httpsRequest(current, { method: 'HEAD', timeoutMs: budgets.requestTimeoutMs });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (!response.headers.location) fail('redirect lacks Location');
      const target = new URL(response.headers.location, current);
      try { current = validateHttpsUrl(target, { exactHosts: NETWORK_HOSTS.vscodeArtifact, label: 'artifact redirect URL' }); } catch (error) { fail(error.message); }
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) fail(`HEAD returned HTTP ${response.statusCode}`);
    if (current.hostname.toLowerCase() !== expected.finalHost.toLowerCase()) fail('unexpected final artifact host');
    if (!current.pathname.toLowerCase().includes(`/${expected.commit.toLowerCase()}/`)) fail('final artifact URL is not commit-bound');
    const contentLength = Number(response.headers['content-length']);
    if (!Number.isSafeInteger(contentLength) || contentLength !== expected.artifactSize) fail('artifact content length mismatch');
    return { url: current.href, contentLength };
  }
  fail('too many redirects');
}

async function getRange(url, start, end, maxBytes) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) fail('invalid byte range');
  const expectedLength = end - start + 1;
  if (expectedLength > maxBytes) fail('range exceeds byte budget');
  const response = await httpsRequest(url, {
    headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
    maxBytes
  });
  if (response.statusCode !== 206) fail(`range request returned HTTP ${response.statusCode}`);
  if (response.headers['content-range'] !== `bytes ${start}-${end}/${PINNED.artifactSize}`) fail('range Content-Range mismatch');
  if (response.body.length !== expectedLength) fail('range response length mismatch');
  return response.body;
}

function findEocd(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('end-of-central-directory record not found');
}

function parseCentralDirectory(buffer, expectedCount, budgets) {
  const entries = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) fail('malformed central-directory record');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const disk = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (recordLength > buffer.length - offset) fail('truncated central-directory record');
    if (flags & 0x1) fail('encrypted entry');
    if (![0, 8].includes(method)) fail('unsupported compression method');
    if (disk !== 0) fail('multi-disk entry');
    if ([compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)) fail('Zip64 entry');
    if (nameLength > budgets.maxNameBytes || extraLength > budgets.maxExtraBytes || commentLength > budgets.maxCommentBytes) fail('central-directory field exceeds budget');
    if (compressedSize > budgets.maxCompressedEntryBytes || uncompressedSize > budgets.maxInflatedEntryBytes) fail('entry size exceeds budget');
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const name = normalizeEntryName(rawName, budgets);
    if (entries.has(name)) fail('duplicate normalized entry name');
    entries.set(name, Object.freeze({ name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset }));
    if (entries.size > budgets.maxEntries) fail('entry count exceeds budget');
    offset += recordLength;
  }
  if (offset !== buffer.length || entries.size !== expectedCount) fail('central-directory entry count mismatch');
  return entries;
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function readRemoteZipIndex(options = {}) {
  const budgets = mergeBudgets(options.budgets);
  const expected = {
    finalHost: options.finalHost ?? PINNED.finalHost,
    commit: options.commit ?? PINNED.commit,
    artifactSize: options.artifactSize ?? PINNED.artifactSize
  };
  const artifact = await resolvePinnedArtifact(options.url ?? PINNED.endpoint, expected, budgets);
  const tailLength = Math.min(budgets.maxTailBytes, artifact.contentLength);
  const tailStart = artifact.contentLength - tailLength;
  const tail = await getRange(artifact.url, tailStart, artifact.contentLength - 1, budgets.maxTailBytes);
  const eocdOffset = findEocd(tail);
  const disk = tail.readUInt16LE(eocdOffset + 4);
  const centralDisk = tail.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralOffset = tail.readUInt32LE(eocdOffset + 16);
  const commentLength = tail.readUInt16LE(eocdOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail('multi-disk ZIP');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('Zip64 archive');
  if (entryCount > budgets.maxEntries || centralSize > budgets.maxCentralDirectoryBytes) fail('central directory exceeds budget');
  if (eocdOffset + 22 + commentLength !== tail.length) fail('invalid ZIP comment length');
  if (centralOffset + centralSize > artifact.contentLength - 22) fail('central directory is out of bounds');
  const central = await getRange(artifact.url, centralOffset, centralOffset + centralSize - 1, budgets.maxCentralDirectoryBytes);
  const entries = parseCentralDirectory(central, entryCount, budgets);
  return Object.freeze({ url: artifact.url, contentLength: artifact.contentLength, entries, budgets });
}

function assertAllowedEntry(entryName, constraints) {
  const basename = entryName.split('/').at(-1) ?? '';
  if (isDeniedSourceInput(entryName) || LOCALIZED_CATALOG.test(basename)) fail('entry violates the source-isolation policy');
  const allowed = constraints.allowedNames ?? constraints.allowlist;
  const names = allowed instanceof Set ? allowed : new Set(Array.isArray(allowed) ? allowed : []);
  if (!names.has(entryName)) fail('entry is not explicitly allowlisted');
}

export async function readVerifiedEntry(index, entryName, constraints = {}) {
  const normalized = normalizeEntryName(entryName, index.budgets);
  assertAllowedEntry(normalized, constraints);
  const entry = index.entries.get(normalized);
  if (!entry) fail('allowlisted entry is absent');
  if (constraints.compressedSize !== undefined && entry.compressedSize !== constraints.compressedSize) fail('compressed size mismatch');
  if (constraints.inflatedSize !== undefined && entry.uncompressedSize !== constraints.inflatedSize) fail('inflated size mismatch');
  const fixedHeader = await getRange(index.url, entry.localHeaderOffset, entry.localHeaderOffset + 29, 30);
  if (fixedHeader.readUInt32LE(0) !== 0x04034b50) fail('invalid local-file header');
  const localFlags = fixedHeader.readUInt16LE(6);
  const localMethod = fixedHeader.readUInt16LE(8);
  const nameLength = fixedHeader.readUInt16LE(26);
  const extraLength = fixedHeader.readUInt16LE(28);
  if (localFlags !== entry.flags || localMethod !== entry.method) fail('local/central header mismatch');
  if (nameLength > index.budgets.maxNameBytes || extraLength > index.budgets.maxExtraBytes) fail('local header exceeds budget');
  const variableHeader = await getRange(index.url, entry.localHeaderOffset + 30, entry.localHeaderOffset + 29 + nameLength + extraLength, nameLength + extraLength);
  const localName = normalizeEntryName(variableHeader.subarray(0, nameLength).toString('utf8'), index.budgets);
  if (localName !== normalized) fail('local/central entry name mismatch');
  const compressedStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressedEnd = compressedStart + entry.compressedSize - 1;
  if (constraints.compressedStart !== undefined && compressedStart !== constraints.compressedStart) fail('compressed range start mismatch');
  if (constraints.compressedEnd !== undefined && compressedEnd !== constraints.compressedEnd) fail('compressed range end mismatch');
  const compressed = await getRange(index.url, compressedStart, compressedEnd, Math.min(index.budgets.maxCompressedEntryBytes, constraints.maxCompressedBytes ?? index.budgets.maxCompressedEntryBytes));
  if (constraints.compressedSha256 && sha256(compressed) !== constraints.compressedSha256) fail('compressed SHA-256 mismatch');
  let inflated;
  if (entry.method === 0) inflated = compressed;
  else inflated = inflateRawSync(compressed, { maxOutputLength: constraints.maxInflatedBytes ?? index.budgets.maxInflatedEntryBytes });
  if (inflated.length !== entry.uncompressedSize) fail('inflated size differs from central directory');
  if (crc32(inflated) !== entry.crc32) fail('inflated CRC32 mismatch');
  if (constraints.inflatedSize !== undefined && inflated.length !== constraints.inflatedSize) fail('inflated size constraint mismatch');
  if (constraints.sha256 && sha256(inflated) !== constraints.sha256) fail('inflated SHA-256 mismatch');
  return inflated;
}

export async function probePinnedCore() {
  const index = await readRemoteZipIndex();
  const bytes = await readVerifiedEntry(index, PINNED.coreEntry, {
    allowedNames: [PINNED.coreEntry],
    compressedStart: PINNED.coreCompressedStart,
    compressedEnd: PINNED.coreCompressedEnd,
    compressedSize: PINNED.coreCompressedEnd - PINNED.coreCompressedStart + 1,
    inflatedSize: PINNED.coreInflatedSize,
    sha256: PINNED.coreSha256,
    maxCompressedBytes: 512 * 1024,
    maxInflatedBytes: 3 * 1024 * 1024
  });
  let metadata;
  try { metadata = JSON.parse(bytes.toString('utf8')); } catch { fail('core metadata is not valid JSON'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !metadata.keys || !metadata.messages) fail('core metadata shape mismatch');
  const modules = Object.keys(metadata.keys);
  let units = 0;
  for (const moduleName of modules) {
    const keys = metadata.keys[moduleName];
    const messages = metadata.messages[moduleName];
    if (!Array.isArray(keys) || !Array.isArray(messages) || keys.length !== messages.length) fail('core key/message parity mismatch');
    units += keys.length;
  }
  if (modules.length !== 1_800 || units !== 21_818) fail('core module/unit count mismatch');
  return Object.freeze({
    artifactUrl: index.url,
    artifactSize: index.contentLength,
    entry: PINNED.coreEntry,
    compressedRange: `${PINNED.coreCompressedStart}-${PINNED.coreCompressedEnd}`,
    inflatedSize: bytes.length,
    sha256: sha256(bytes),
    modules: modules.length,
    units
  });
}

export const PINNED_CORE = PINNED;
