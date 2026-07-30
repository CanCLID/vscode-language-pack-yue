#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { createGunzip } from 'node:zlib';
import { readRemoteZipIndex, readVerifiedEntry, PINNED_CORE } from './lib/remote-zip.mjs';
import { isDeniedSourceInput } from './lib/source-isolation.mjs';
import { NETWORK_HOSTS, validateHttpsUrl } from './lib/network-policy.mjs';
import { createOwnedTemp, removeOwnedTemp } from './lib/owned-temp.mjs';

const BASELINE = Object.freeze({
  repository: 'https://github.com/microsoft/vscode.git',
  tag: '1.129.1',
  commit: '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8',
  sourceLocale: 'en',
  node: '24.18.0',
  latestReleaseApi: 'https://api.github.com/repos/microsoft/vscode/releases/latest',
  artifactEndpoint: PINNED_CORE.endpoint,
  artifactSize: PINNED_CORE.artifactSize
});

const SOURCE_FIXED = Object.freeze([
  '.nvmrc',
  'LICENSE.txt',
  'product.json',
  'build/gulpfile.vscode.ts',
  'build/lib/i18n.ts',
  'build/lib/extensions.ts',
  'build/npm/update-localization-extension.ts'
]);
const ARCHIVE_ROOT = `${BASELINE.commit.slice(0, 10)}/resources/app/extensions/`;
const EXCLUDED_PACKAGED = new Set(['copilot', 'TypeScriptTeam.jsts-chat-features']);
const EXTERNAL = Object.freeze([
  Object.freeze({ name: 'ms-vscode.js-debug-companion', version: '1.1.3', sha256: '7380a890787452f14b2db7835dfa94de538caf358ebc263f9d46dd68ac52de93' }),
  Object.freeze({ name: 'ms-vscode.js-debug', version: '1.117.0', sha256: '854eeb8a785b1f41ba2bd02d7ccd4fdbe10021b61473293973c7e96d036c7fb8' }),
  Object.freeze({ name: 'ms-vscode.vscode-js-profile-table', version: '1.0.10', sha256: '7361748ddf9fd09d8a2ed1f2a2d7376a2cf9aae708692820b799708385c38e08' })
]);
const EXTERNAL_NAMES = new Set(EXTERNAL.map(item => item.name));
const LOCALIZED_CATALOG = /^package\.nls\..+\.json$/i;
const MAX_HTTP_JSON = 1024 * 1024;
const MAX_PACKAGE = 4 * 1024 * 1024;
const MAX_JS = 24 * 1024 * 1024;
const MAX_EXTERNAL_VSIX = 128 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(`source acquisition failed: ${message}`);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeRelative(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) fail(`invalid ${label}`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.')) fail(`unsafe ${label}`);
  const basename = normalized.split('/').at(-1) ?? '';
  if (isDeniedSourceInput(normalized) || LOCALIZED_CATALOG.test(basename)) fail(`${label} violates English-only policy`);
  return normalized;
}

function parseArgs(argv) {
  let cache;
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cache') cache = argv[++index];
    else if (arg === '--verify-only') verifyOnly = true;
    else fail(`unknown argument ${arg}`);
  }
  if (!cache) fail('usage: node scripts/source-acquire.mjs --cache <directory> [--verify-only]');
  const resolved = path.resolve(cache);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === process.cwd() || path.dirname(resolved) === parsed.root) fail('cache directory is too broad');
  return { cache: resolved, verifyOnly };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = validateHttpsUrl(url, { exactHosts: NETWORK_HOSTS.githubApi, label: 'GitHub API URL' }); } catch (error) { reject(error); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('GitHub API request timed out')), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    const finish = (callback, value) => { if (!settled) { settled = true; clearTimeout(timer); callback(value); } };
    const req = request(parsed, { signal: controller.signal, headers: { 'User-Agent': 'vscode-language-pack-yue-source-acquire', Accept: 'application/vnd.github+json' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(reject, new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_HTTP_JSON) req.destroy(new Error('release response exceeds budget'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { finish(reject, error); }
      });
      response.on('error', error => finish(reject, error));
    });
    req.on('error', error => finish(reject, error));
    req.end();
  });
}

function marketplaceUrl(item) {
  const extensionName = item.name.slice(item.name.indexOf('.') + 1);
  return `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode/vsextensions/${extensionName}/${item.version}/vspackage`;
}

function streamHash(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = validateHttpsUrl(url, {
        exactHosts: redirects === 0 ? NETWORK_HOSTS.marketplace : NETWORK_HOSTS.marketplace,
        suffixHosts: redirects === 0 ? [] : NETWORK_HOSTS.marketplaceCdnSuffixes,
        label: 'external VSIX URL'
      });
    } catch (error) { reject(error); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('external VSIX request timed out')), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    const finish = (callback, value) => { if (!settled) { settled = true; clearTimeout(timer); callback(value); } };
    const req = request(parsed, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 vscode-language-pack-yue-source-acquire', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        if (!response.headers.location || redirects >= 4) finish(reject, new Error('external VSIX redirect policy rejected'));
        else {
          const next = new URL(response.headers.location, parsed);
          try { validateHttpsUrl(next, { exactHosts: NETWORK_HOSTS.marketplace, suffixHosts: NETWORK_HOSTS.marketplaceCdnSuffixes, label: 'external VSIX redirect URL' }); }
          catch (error) { finish(reject, error); return; }
          clearTimeout(timer);
          settled = true;
          streamHash(next, redirects + 1).then(resolve, reject);
        }
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        finish(reject, new Error(`external VSIX returned HTTP ${response.statusCode}`));
        return;
      }
      const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (!['identity', 'gzip'].includes(encoding)) {
        response.resume();
        finish(reject, new Error('external VSIX used unsupported content encoding'));
        return;
      }
      const digest = createHash('sha256');
      let transferred = 0;
      let bytes = 0;
      response.on('data', chunk => {
        transferred += chunk.length;
        if (transferred > MAX_EXTERNAL_VSIX) req.destroy(new Error('external VSIX transfer exceeds byte budget'));
      });
      const source = encoding === 'gzip' ? createGunzip() : response;
      if (encoding === 'gzip') {
        source.on('error', error => finish(reject, error));
        response.pipe(source);
      }
      source.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_EXTERNAL_VSIX) req.destroy(new Error('external VSIX exceeds byte budget'));
        else digest.update(chunk);
      });
      source.on('end', () => finish(resolve, { sha256: digest.digest('hex'), bytes }));
    });
    req.on('error', error => finish(reject, error));
    req.end();
  });
}

async function verifyExternalVsixBytes() {
  const evidence = [];
  for (const item of EXTERNAL) {
    const result = await streamHash(marketplaceUrl(item));
    if (result.sha256 !== item.sha256 || result.bytes <= 0) fail(`external VSIX byte hash mismatch for ${item.name}: ${result.sha256}/${result.bytes}`);
    evidence.push({ name: item.name, version: item.version, sha256: result.sha256, bytes: result.bytes });
  }
  return evidence.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error?.code === 'ENOENT') fail('Git is unavailable; install nothing and provide Git before retrying');
  if (result.status !== 0) fail(`Git command failed: ${String(result.stderr || result.stdout).trim()}`);
  return String(result.stdout).trim();
}

async function assertPrerequisites() {
  try { await access(process.execPath, fsConstants.X_OK); } catch { fail('Node.js runtime is unavailable'); }
  const release = await getJson(BASELINE.latestReleaseApi);
  if (release?.tag_name !== BASELINE.tag) fail(`official latest Stable is ${release?.tag_name ?? 'unknown'}, expected ${BASELINE.tag}; research and re-plan before advancing`);
  const remote = runGit(['ls-remote', '--refs', '--tags', BASELINE.repository, `refs/tags/${BASELINE.tag}`]);
  const match = remote.match(/^([0-9a-f]{40})\s+refs\/tags\//);
  if (!match || match[1] !== BASELINE.commit) fail('exact Stable tag does not resolve to the pinned full commit');
}

function archiveExtensionNames(index) {
  const names = [...index.entries.keys()]
    .filter(name => name.startsWith(ARCHIVE_ROOT) && name.endsWith('/package.json'))
    .map(name => name.slice(ARCHIVE_ROOT.length).split('/'))
    .filter(parts => parts.length === 2 && parts[1] === 'package.json')
    .map(parts => parts[0]);
  const unique = [...new Set(names)].sort();
  const scoped = unique.filter(name => !EXCLUDED_PACKAGED.has(name));
  const local = scoped.filter(name => !EXTERNAL_NAMES.has(name));
  const external = scoped.filter(name => EXTERNAL_NAMES.has(name));
  if (unique.length !== 95 || scoped.length !== 93 || local.length !== 90 || external.length !== 3) fail('packaged built-in scope count mismatch');
  if (external.join('\0') !== [...EXTERNAL_NAMES].sort().join('\0')) fail('external built-in scope mismatch');
  return { local: local.sort(), external: external.sort(), all: scoped.sort() };
}

async function cloneSparseSource(staging, localNames) {
  const repo = path.join(staging, '.source-repo');
  runGit(['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', BASELINE.tag, BASELINE.repository, repo]);
  const head = runGit(['-C', repo, 'rev-parse', 'HEAD']);
  if (head !== BASELINE.commit) fail('sparse source checkout commit mismatch');
  runGit(['-C', repo, 'sparse-checkout', 'init', '--no-cone']);
  const patterns = [
    ...SOURCE_FIXED.map(item => `/${item}`),
    ...localNames.flatMap(name => [`/extensions/${name}/package.json`, `/extensions/${name}/package.nls.json`])
  ];
  await writeFile(path.join(repo, '.git', 'info', 'sparse-checkout'), `${patterns.join('\n')}\n`, 'utf8');
  runGit(['-C', repo, 'checkout', '--detach', BASELINE.commit]);
  return repo;
}

async function storeRecord(staging, records, { path: recordPath, origin, upstreamPath, kind, bytes }) {
  const safePath = normalizeRelative(recordPath, 'cache record path');
  const safeUpstream = normalizeRelative(upstreamPath, 'upstream path');
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const destination = path.join(staging, ...safePath.split('/'));
  const relativeCheck = path.relative(staging, destination);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) fail('cache record escapes staging root');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
  records.push({ path: safePath, origin, upstreamPath: safeUpstream, sha256: hash(bytes), bytes: bytes.length, kind, verified: true });
}

async function acquireSourceFiles(staging, records, repo, localNames) {
  const expected = [...SOURCE_FIXED, ...localNames.flatMap(name => [`extensions/${name}/package.json`, `extensions/${name}/package.nls.json`])];
  for (const upstreamPath of expected.sort()) {
    const bytes = await readFile(path.join(repo, ...upstreamPath.split('/')));
    await storeRecord(staging, records, {
      path: `blobs/source/${upstreamPath}`,
      origin: 'microsoft/vscode', upstreamPath,
      kind: upstreamPath.endsWith('package.nls.json') ? 'source-package-catalog' : 'source-rule', bytes
    });
  }
  const nodeRecord = (await readFile(path.join(repo, '.nvmrc'), 'utf8')).trim();
  if (nodeRecord !== BASELINE.node) fail('upstream Node record mismatch');
  return JSON.parse(await readFile(path.join(repo, 'product.json'), 'utf8'));
}

function verifyExternalPins(product) {
  const actual = Array.isArray(product?.builtInExtensions) ? product.builtInExtensions : [];
  for (const expected of EXTERNAL) {
    const item = actual.find(candidate => candidate?.name === expected.name);
    if (!item || item.version !== expected.version || item.sha256 !== expected.sha256) fail(`external built-in pin mismatch for ${expected.name}`);
    if (typeof item.repo !== 'string' || !/^https:\/\/github\.com\/microsoft\//i.test(item.repo) || isDeniedSourceInput(item.repo)) fail(`external built-in repository is not approved for ${expected.name}`);
  }
  if (actual.length !== EXTERNAL.length) fail('unexpected external built-in count in product.json');
}

async function readArchiveEntry(index, name, maxBytes) {
  const entry = index.entries.get(name);
  if (!entry) fail(`required approved archive entry is missing: ${name}`);
  return readVerifiedEntry(index, name, {
    allowedNames: [name],
    compressedSize: entry.compressedSize,
    inflatedSize: entry.uncompressedSize,
    maxCompressedBytes: Math.min(maxBytes, Math.max(entry.compressedSize, 1)),
    maxInflatedBytes: maxBytes
  });
}

function jsCandidates(fromFile, specifier) {
  if (!specifier.startsWith('.')) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (base.startsWith('../') || base.includes('/../')) fail('relative JavaScript import escapes extension root');
  const ext = path.posix.extname(base);
  if (ext) return /\.(?:js|cjs|mjs)$/i.test(ext) ? [base] : [];
  return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`];
}

function extractRelativeImports(source) {
  const found = new Set();
  const patterns = [
    /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
    /\b(?:import|export)\s+(?:[^'"\r\n]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[2].startsWith('.')) found.add(match[2]);
  }
  return [...found].sort();
}

async function acquireArchiveFiles(staging, records, index, scope) {
  const catalogs = [];
  const javascript = {};
  const core = await readArchiveEntry(index, PINNED_CORE.coreEntry, 3 * 1024 * 1024);
  if (core.length !== PINNED_CORE.coreInflatedSize || hash(core) !== PINNED_CORE.coreSha256) fail('pinned core metadata verification failed');
  await storeRecord(staging, records, { path: 'blobs/artifact/core/nls.metadata.json', origin: 'stable-artifact', upstreamPath: PINNED_CORE.coreEntry, kind: 'core-metadata', bytes: core });

  for (const extension of scope.all) {
    const root = `${ARCHIVE_ROOT}${extension}/`;
    const packagePath = `${root}package.json`;
    const packageBytes = await readArchiveEntry(index, packagePath, MAX_PACKAGE);
    let manifest;
    try { manifest = JSON.parse(packageBytes.toString('utf8')); } catch { fail(`invalid package manifest for ${extension}`); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.name !== 'string' || manifest.name.length === 0) fail(`package identity is missing for ${extension}`);
    await storeRecord(staging, records, { path: `blobs/artifact/extensions/${extension}/package.json`, origin: 'stable-artifact', upstreamPath: packagePath, kind: 'packaged-manifest', bytes: packageBytes });
    const catalogPath = `${root}package.nls.json`;
    if (index.entries.has(catalogPath)) {
      const catalog = await readArchiveEntry(index, catalogPath, MAX_PACKAGE);
      JSON.parse(catalog.toString('utf8'));
      await storeRecord(staging, records, { path: `blobs/artifact/extensions/${extension}/package.nls.json`, origin: 'stable-artifact', upstreamPath: catalogPath, kind: 'packaged-catalog', bytes: catalog });
      catalogs.push(extension);
    } else if (!EXTERNAL_NAMES.has(extension)) fail(`local built-in lacks exact English package catalog: ${extension}`);

    const queue = [];
    for (const field of ['main', 'browser']) {
      if (typeof manifest[field] !== 'string') continue;
      const raw = manifest[field].replace(/^\.\//, '');
      const options = jsCandidates('entry.js', `./${raw}`);
      const resolved = options.find(option => index.entries.has(`${root}${option}`));
      if (!resolved && field === 'main') fail(`declared main JavaScript entry is missing for ${extension}`);
      if (resolved) queue.push(resolved);
    }
    const seen = new Set();
    while (queue.length) {
      const candidates = queue.shift();
      let relative = candidates;
      if (!index.entries.has(`${root}${relative}`)) continue;
      if (seen.has(relative)) continue;
      seen.add(relative);
      const jsPath = `${root}${relative}`;
      const js = await readArchiveEntry(index, jsPath, MAX_JS);
      await storeRecord(staging, records, { path: `blobs/artifact/extensions/${extension}/${relative}`, origin: 'stable-artifact', upstreamPath: jsPath, kind: 'packaged-javascript', bytes: js });
      const source = js.toString('utf8');
      for (const specifier of extractRelativeImports(source)) {
        const options = jsCandidates(relative, specifier);
        const resolved = options.find(option => index.entries.has(`${root}${option}`));
        const dependencyBase = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
        const nonJavaScriptDependency = ['.node', '.json'].some(suffix => index.entries.has(`${root}${dependencyBase}${suffix}`));
        if (!resolved && options.length && !nonJavaScriptDependency) fail(`unresolved relative JavaScript import ${specifier} in ${extension}`);
        if (resolved && !seen.has(resolved)) queue.push(resolved);
      }
    }
    javascript[extension] = [...seen].sort();
  }
  if (catalogs.length !== 91) fail('packaged English catalog count mismatch');
  return { catalogs: catalogs.sort(), javascript };
}

function coreCounts(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !metadata.keys || !metadata.messages) fail('core metadata shape mismatch');
  const modules = Object.keys(metadata.keys);
  let units = 0;
  for (const name of modules) {
    if (!Array.isArray(metadata.keys[name]) || !Array.isArray(metadata.messages[name]) || metadata.keys[name].length !== metadata.messages[name].length) fail('core metadata parity mismatch');
    units += metadata.keys[name].length;
  }
  return { modules: modules.length, units };
}

async function verifyCache(cache) {
  let index;
  try { index = JSON.parse(await readFile(path.join(cache, 'index.json'), 'utf8')); } catch { fail('cache index is missing or invalid JSON'); }
  if (index.schemaVersion !== 1 || JSON.stringify(index.baseline) !== JSON.stringify(BASELINE)) fail('cache baseline mismatch');
  if (!Array.isArray(index.records) || !index.scope || !index.summary) fail('cache index shape mismatch');
  if (!Array.isArray(index.externalArtifacts) || index.externalArtifacts.length !== EXTERNAL.length) fail('external artifact evidence mismatch');
  for (const expected of EXTERNAL) {
    const actual = index.externalArtifacts.find(item => item?.name === expected.name);
    if (!actual || actual.version !== expected.version || actual.sha256 !== expected.sha256 || !Number.isSafeInteger(actual.bytes) || actual.bytes <= 0 || actual.bytes > MAX_EXTERNAL_VSIX) fail(`external artifact evidence mismatch for ${expected.name}`);
  }
  if (!Array.isArray(index.scope.local) || index.scope.local.length !== 90 || !Array.isArray(index.scope.external) || index.scope.external.length !== 3 || !Array.isArray(index.scope.catalogs) || typeof index.scope.javascript !== 'object') fail('cache scope mismatch');
  if (index.scope.external.join('\0') !== EXTERNAL.map(item => item.name).sort().join('\0')) fail('cache external scope mismatch');
  const expectedOrder = [...index.records].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(index.records) !== JSON.stringify(expectedOrder)) fail('cache records are not sorted');
  const byPath = new Map();
  for (const record of index.records) {
    const safe = normalizeRelative(record.path, 'cache record path');
    normalizeRelative(record.upstreamPath, 'upstream path');
    if (byPath.has(safe) || record.verified !== true || !/^[0-9a-f]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0) fail('invalid or duplicate cache record');
    const file = path.join(cache, ...safe.split('/'));
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) fail(`cache file metadata mismatch: ${safe}`);
    const bytes = await readFile(file);
    if (hash(bytes) !== record.sha256) fail(`cache file hash mismatch: ${safe}`);
    byPath.set(safe, { record, bytes });
  }
  const expectedPaths = new Set(SOURCE_FIXED.map(item => `blobs/source/${item}`));
  for (const name of index.scope.local) {
    expectedPaths.add(`blobs/source/extensions/${name}/package.json`);
    expectedPaths.add(`blobs/source/extensions/${name}/package.nls.json`);
  }
  expectedPaths.add('blobs/artifact/core/nls.metadata.json');
  for (const name of [...index.scope.local, ...index.scope.external]) expectedPaths.add(`blobs/artifact/extensions/${name}/package.json`);
  for (const name of index.scope.catalogs) expectedPaths.add(`blobs/artifact/extensions/${name}/package.nls.json`);
  for (const [name, files] of Object.entries(index.scope.javascript)) {
    if (![...index.scope.local, ...index.scope.external].includes(name) || !Array.isArray(files)) fail('invalid JavaScript scope owner');
    for (const file of files) {
      const safeFile = normalizeRelative(file, 'JavaScript graph path');
      if (!/\.(?:js|cjs|mjs)$/i.test(safeFile)) fail('non-JavaScript graph record');
      expectedPaths.add(`blobs/artifact/extensions/${name}/${safeFile}`);
    }
  }
  if (expectedPaths.size !== byPath.size || [...expectedPaths].some(item => !byPath.has(item)) || [...byPath.keys()].some(item => !expectedPaths.has(item))) fail('cache has missing or extra records');
  const sourceFixed = SOURCE_FIXED.map(item => `blobs/source/${item}`);
  for (const item of sourceFixed) if (!byPath.has(item)) fail(`missing fixed source record: ${item}`);
  const sourceExtensions = [...byPath.keys()].filter(item => /^blobs\/source\/extensions\/[^/]+\/package(?:\.nls)?\.json$/.test(item));
  if (sourceExtensions.length !== 180) fail('source extension record count mismatch');
  for (const name of index.scope.local) {
    if (!byPath.has(`blobs/source/extensions/${name}/package.json`) || !byPath.has(`blobs/source/extensions/${name}/package.nls.json`)) fail(`incomplete source extension records: ${name}`);
  }
  const artifactPackages = [...byPath.keys()].filter(item => /^blobs\/artifact\/extensions\/[^/]+\/package\.json$/.test(item));
  const artifactCatalogs = [...byPath.keys()].filter(item => /^blobs\/artifact\/extensions\/[^/]+\/package\.nls\.json$/.test(item));
  if (artifactPackages.length !== 93 || artifactCatalogs.length !== 91) fail('packaged extension record count mismatch');
  if (index.scope.catalogs.length !== 91 || index.scope.catalogs.join('\0') !== [...index.scope.catalogs].sort().join('\0')) fail('cache catalog scope mismatch');
  const nvmrc = byPath.get('blobs/source/.nvmrc')?.bytes.toString('utf8').trim();
  if (nvmrc !== BASELINE.node) fail('cached Node record mismatch');
  const product = JSON.parse(byPath.get('blobs/source/product.json').bytes.toString('utf8'));
  verifyExternalPins(product);
  const core = JSON.parse(byPath.get('blobs/artifact/core/nls.metadata.json')?.bytes.toString('utf8'));
  const counts = coreCounts(core);
  if (counts.modules !== 1_800 || counts.units !== 21_818) fail('cached core counts mismatch');
  if (index.summary.coreModules !== counts.modules || index.summary.coreUnits !== counts.units || index.summary.localBuiltIns !== 90 || index.summary.externalBuiltIns !== 3 || index.summary.records !== index.records.length) fail('cache summary mismatch');
  return index;
}

async function promote(staging, cache) {
  const backup = `${cache}.old-${process.pid}`;
  let hadExisting = false;
  try { await lstat(cache); hadExisting = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hadExisting) await rename(cache, backup);
  try {
    await rename(staging, cache);
    if (hadExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadExisting) await rename(backup, cache).catch(() => {});
    throw error;
  }
}

async function acquire(cache) {
  await assertPrerequisites();
  const ownedStaging = await createOwnedTemp(path.dirname(cache), `${path.basename(cache)}.tmp-`);
  const staging = ownedStaging.path;
  try {
    const zip = await readRemoteZipIndex();
    const scope = archiveExtensionNames(zip);
    const records = [];
    const repo = await cloneSparseSource(staging, scope.local);
    const product = await acquireSourceFiles(staging, records, repo, scope.local);
    verifyExternalPins(product);
    const externalArtifacts = await verifyExternalVsixBytes();
    const archiveScope = await acquireArchiveFiles(staging, records, zip, scope);
    await rm(repo, { recursive: true, force: true });
    records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const index = {
      schemaVersion: 1,
      baseline: BASELINE,
      scope: { local: scope.local, external: scope.external, catalogs: archiveScope.catalogs, javascript: archiveScope.javascript },
      externalArtifacts,
      records,
      summary: { coreModules: 1800, coreUnits: 21818, localBuiltIns: 90, externalBuiltIns: 3, records: records.length }
    };
    await writeFile(path.join(staging, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await verifyCache(staging);
    await mkdir(path.dirname(cache), { recursive: true });
    await promote(staging, cache);
    return index;
  } catch (error) {
    await removeOwnedTemp(ownedStaging);
    throw error;
  }
}

const { cache, verifyOnly } = parseArgs(process.argv.slice(2));
try {
  const index = verifyOnly ? await verifyCache(cache) : await acquire(cache);
  process.stdout.write(`${verifyOnly ? 'Verified' : 'Acquired'} ${index.records.length} immutable English input records for VS Code ${BASELINE.tag}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
