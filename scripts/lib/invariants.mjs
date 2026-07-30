import path from 'node:path';
import { canonicalBytes, canonicalHash, canonicalStringify, compareOrdinal, sha256Bytes } from './canonical-json.mjs';
import { extractProtectedContent, foldProtectedEntries } from './protected-content.mjs';
import { createInventoryUnit } from './vscode-localization.mjs';
import { isDeniedSourceInput } from './source-isolation.mjs';

export const BASELINE = Object.freeze({
  repository: 'https://github.com/microsoft/vscode.git',
  tag: '1.129.1',
  commit: '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8',
  sourceLocale: 'en'
});

const SOURCE_CONTRACT = Object.freeze({
  node: '24.18.0',
  retrievalMethod: 'verified sparse Git source plus bounded Stable artifact ZIP ranges',
  officialReleaseApi: 'https://api.github.com/repos/microsoft/vscode/releases/latest',
  officialArtifactUrl: 'https://update.code.visualstudio.com/1.129.1/win32-x64-archive/stable',
  commitArtifactUrl: 'https://update.code.visualstudio.com/commit:8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/win32-x64-archive/stable',
  repositoryCommitUrl: 'https://github.com/microsoft/vscode/commit/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8'
});

const ARTIFACT_CONTRACT = Object.freeze({
  bytes: 310_678_641,
  coreEntry: '8a7abeba6e/resources/app/out/nls.metadata.json',
  coreCompression: 'deflate',
  coreCompressedStart: 176_656_758,
  coreCompressedEnd: 177_094_827,
  coreCompressedBytes: 438_070,
  coreInflatedBytes: 2_142_742,
  coreSha256: '972e95e10c9c22130fc2133da57f972a947640cc38a0e5bff537c338ab724c37'
});

const LICENSE_CONTRACT = Object.freeze({
  path: 'LICENSE.txt',
  sha256: 'cce33203a80863c22499035b1cfb6aba5df5f02e4ea2669cf5bc5730c1864236',
  bytes: 1109,
  reference: 'https://github.com/microsoft/vscode/blob/8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8/LICENSE.txt'
});

const EXTERNAL_ARTIFACTS = Object.freeze([
  { name: 'ms-vscode.js-debug', version: '1.117.0', sha256: '854eeb8a785b1f41ba2bd02d7ccd4fdbe10021b61473293973c7e96d036c7fb8', bytes: 1_318_607 },
  { name: 'ms-vscode.js-debug-companion', version: '1.1.3', sha256: '7380a890787452f14b2db7835dfa94de538caf358ebc263f9d46dd68ac52de93', bytes: 52_784 },
  { name: 'ms-vscode.vscode-js-profile-table', version: '1.0.10', sha256: '7361748ddf9fd09d8a2ed1f2a2d7376a2cf9aae708692820b799708385c38e08', bytes: 350_996 }
]);

const UNIT_FIELDS = ['id', 'component', 'bundle', 'module', 'key', 'source', 'context', 'protected', 'sourceFingerprint'];

function summary(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value).length})`;
  if (typeof value === 'string') return `string(${value.length})`;
  return String(value);
}

export class InvariantError extends Error {
  constructor(invariant, location, expected, actual) {
    const safeLocation = location || '<global>';
    super(`[${invariant}] ${safeLocation}: expected ${summary(expected)}, actual ${summary(actual)}`);
    this.name = 'InvariantError';
    this.invariant = invariant;
    this.location = safeLocation;
    this.expected = summary(expected);
    this.actual = summary(actual);
  }
}

function reject(invariant, location, expected, actual) {
  throw new InvariantError(invariant, location, expected, actual);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, invariant, location) {
  if (!plainObject(value)) reject(invariant, location, keys, value);
  const actual = Object.keys(value).sort(compareOrdinal);
  const expected = [...keys].sort(compareOrdinal);
  if (canonicalStringify(actual) !== canonicalStringify(expected)) reject(invariant, location, expected, actual);
}

function assertBaseline(value, invariant, location) {
  if (!plainObject(value)) reject(invariant, location, BASELINE, value);
  for (const [field, expected] of Object.entries(BASELINE)) {
    if (value[field] !== expected) reject(invariant, `${location}.${field}`, expected, value[field]);
  }
}

export function validateInventory(inventory, rawBytes) {
  exactKeys(inventory, ['schemaVersion', 'sourceLocale', 'baseline', 'units'], 'inventory-schema', 'inventory');
  if (inventory.schemaVersion !== 1) reject('inventory-schema', 'inventory.schemaVersion', 1, inventory.schemaVersion);
  if (inventory.sourceLocale !== 'en') reject('source-isolation', 'inventory.sourceLocale', 'en', inventory.sourceLocale);
  assertBaseline({ ...inventory.baseline, sourceLocale: inventory.sourceLocale }, 'inventory-baseline', 'inventory.baseline');
  if (!Array.isArray(inventory.units) || inventory.units.length === 0) reject('inventory-schema', 'inventory.units', 'nonempty array', inventory.units);
  if (rawBytes && !Buffer.from(rawBytes).equals(canonicalBytes(inventory))) reject('inventory-canonical-bytes', 'sources/inventory.en.json', canonicalBytes(inventory).length, rawBytes.length);

  const ids = new Set();
  const tuples = new Set();
  let previous = '';
  for (const unit of inventory.units) {
    const location = typeof unit?.id === 'string' ? unit.id : '<unit>';
    exactKeys(unit, UNIT_FIELDS, 'inventory-schema', location);
    const tuple = canonicalStringify([unit.bundle, unit.module, unit.key]);
    if (unit.id !== tuple) reject('unit-identity', location, tuple, unit.id);
    if (ids.has(unit.id) || tuples.has(tuple)) reject('duplicate-identity', location, 'unique ID and tuple', unit.id);
    if (previous && compareOrdinal(previous, unit.id) >= 0) reject('inventory-order', location, 'strict ordinal order', unit.id);
    ids.add(unit.id);
    tuples.add(tuple);
    previous = unit.id;
    const rebuilt = createInventoryUnit({ component: unit.component, bundle: unit.bundle, module: unit.module, key: unit.key, source: unit.source, context: unit.context });
    if (canonicalStringify(rebuilt.protected) !== canonicalStringify(unit.protected)) reject('source-protected-content', location, rebuilt.protected, unit.protected);
    if (rebuilt.sourceFingerprint !== unit.sourceFingerprint) reject('source-fingerprint', location, rebuilt.sourceFingerprint, unit.sourceFingerprint);
  }
  return { ids, unitsById: new Map(inventory.units.map(unit => [unit.id, unit])) };
}

export function validateProvenance(provenance, inventory, inventoryBytes, scope) {
  if (!plainObject(provenance) || provenance.schemaVersion !== 1 || provenance.generatorVersion !== 2) reject('provenance-schema', 'provenance', 'schema 1 / generator 2', provenance);
  assertBaseline({ repository: provenance.source?.repository, tag: provenance.source?.tag, commit: provenance.source?.commit, sourceLocale: provenance.source?.sourceLocale }, 'provenance-baseline', 'provenance.source');
  for (const [field, expected] of Object.entries(SOURCE_CONTRACT)) if (provenance.source?.[field] !== expected) reject('provenance-source', `provenance.source.${field}`, expected, provenance.source?.[field]);
  for (const [field, expected] of Object.entries(ARTIFACT_CONTRACT)) if (provenance.artifact?.[field] !== expected) reject('provenance-artifact', `provenance.artifact.${field}`, expected, provenance.artifact?.[field]);
  for (const [field, expected] of Object.entries(LICENSE_CONTRACT)) if (provenance.license?.[field] !== expected) reject('provenance-license', `provenance.license.${field}`, expected, provenance.license?.[field]);
  if (canonicalStringify(provenance.externalArtifacts) !== canonicalStringify(EXTERNAL_ARTIFACTS)) reject('provenance-external-artifacts', 'provenance.externalArtifacts', EXTERNAL_ARTIFACTS, provenance.externalArtifacts);
  const allowedUrls = [provenance.source?.repository, provenance.source?.officialReleaseApi, provenance.source?.officialArtifactUrl, provenance.source?.commitArtifactUrl, provenance.source?.repositoryCommitUrl, provenance.license?.reference];
  for (const value of [...allowedUrls, ...(provenance.source?.approvedUpstreamPaths ?? []), ...(provenance.consumedBlobs ?? []).flatMap(item => [item.path, item.origin, item.upstreamPath])]) {
    if (isDeniedSourceInput(value)) reject('source-isolation', 'provenance.input', 'approved English-only path', value);
  }
  if (!Array.isArray(provenance.consumedBlobs) || provenance.consumedBlobs.length !== 408) reject('provenance-counts', 'provenance.consumedBlobs', 408, provenance.consumedBlobs);
  const blobPaths = new Set();
  for (const blob of provenance.consumedBlobs) {
    if (!plainObject(blob) || typeof blob.path !== 'string' || blobPaths.has(blob.path) || !/^[a-f0-9]{64}$/.test(blob.sha256) || !Number.isInteger(blob.bytes) || blob.bytes < 0) reject('provenance-blob', blob?.path, 'unique hashed bounded record', blob);
    blobPaths.add(blob.path);
  }
  const approvedPaths = provenance.source?.approvedUpstreamPaths;
  if (!Array.isArray(approvedPaths) || approvedPaths.length === 0 || approvedPaths.some((item, index) => index > 0 && compareOrdinal(approvedPaths[index - 1], item) >= 0)) reject('provenance-allowlist', 'provenance.source.approvedUpstreamPaths', 'nonempty unique ordinal allowlist', approvedPaths);
  const consumedUpstream = new Set(provenance.consumedBlobs.map(blob => blob.upstreamPath));
  if (approvedPaths.some(item => !consumedUpstream.has(item))) reject('provenance-allowlist', 'provenance.source.approvedUpstreamPaths', 'paths backed by consumed records', approvedPaths);
  const expectedHash = sha256Bytes(inventoryBytes);
  if (provenance.inventorySha256 !== expectedHash) reject('provenance-inventory-hash', 'provenance.inventorySha256', expectedHash, provenance.inventorySha256);
  const core = inventory.units.filter(unit => unit.component === 'core');
  const extension = inventory.units.length - core.length;
  const expectedCounts = {
    consumedRecords: 408,
    localBuiltIns: 90,
    externalBuiltIns: 3,
    totalBuiltIns: 93,
    accountedZeroUnit: 1,
    coreModules: new Set(core.map(unit => unit.module)).size,
    modules: new Set(inventory.units.map(unit => `${unit.bundle}\0${unit.module}`)).size,
    coreUnits: core.length,
    extensionUnits: extension,
    totalUnits: inventory.units.length,
    bundleOwners: new Set(inventory.units.map(unit => unit.bundle)).size
  };
  for (const [field, expected] of Object.entries(expectedCounts)) if (provenance.counts?.[field] !== expected) reject('provenance-counts', `provenance.counts.${field}`, expected, provenance.counts?.[field]);
  if (scope?.counts?.extensionUnits !== extension) reject('provenance-scope', 'scope.counts.extensionUnits', extension, scope?.counts?.extensionUnits);
}

export function deriveTranslations(inventory) {
  const owners = new Set(inventory.units.map(unit => unit.bundle));
  if (!owners.delete('vscode')) reject('manifest-topology', 'inventory.bundle', 'vscode owner', owners);
  return [
    { id: 'vscode', path: './translations/main.i18n.json' },
    ...[...owners].sort(compareOrdinal).map(id => ({ id, path: `./translations/extensions/${id}.i18n.json` }))
  ];
}

export function validateScope(inventory, scope) {
  if (!plainObject(scope) || scope.schemaVersion !== 1 || !Array.isArray(scope.extensions) || !Array.isArray(scope.generatedBundlePaths)) reject('scope-schema', 'scope', 'schema 1 with extension and path arrays', scope);
  assertBaseline(scope.baseline, 'scope-baseline', 'scope.baseline');
  if (scope.extensions.length !== 93) reject('scope-counts', 'scope.extensions', 93, scope.extensions);
  const names = new Set();
  const bundles = new Map();
  for (const item of scope.extensions) {
    if (!plainObject(item) || typeof item.name !== 'string' || names.has(item.name)) reject('scope-identity', item?.name, 'unique built-in name', item);
    names.add(item.name);
    if (item.disposition === 'included') {
      if (typeof item.bundleId !== 'string' || bundles.has(item.bundleId) || !Number.isInteger(item.localizationUnitCount) || item.localizationUnitCount <= 0) reject('scope-identity', item.name, 'unique included bundle', item);
      bundles.set(item.bundleId, item.localizationUnitCount);
    } else if (item.disposition !== 'accounted-zero-unit' || item.bundleId !== null || item.localizationUnitCount !== 0) reject('scope-disposition', item.name, 'included or explicit zero-unit', item);
  }
  const actualCounts = new Map();
  for (const unit of inventory.units.filter(unit => unit.component === 'extension')) actualCounts.set(unit.bundle, (actualCounts.get(unit.bundle) ?? 0) + 1);
  const declaredBundles = [...bundles].sort(([left], [right]) => compareOrdinal(left, right));
  const inventoryBundles = [...actualCounts].sort(([left], [right]) => compareOrdinal(left, right));
  if (canonicalStringify(declaredBundles) !== canonicalStringify(inventoryBundles)) reject('scope-topology', 'scope.extensions', inventoryBundles, declaredBundles);
  const expectedPaths = [...actualCounts.keys()].sort(compareOrdinal).map(id => `extension/translations/extensions/${id}.i18n.json`);
  if (canonicalStringify(scope.generatedBundlePaths) !== canonicalStringify(expectedPaths)) reject('scope-generated-paths', 'scope.generatedBundlePaths', expectedPaths, scope.generatedBundlePaths);
  const expectedCounts = { localBuiltIns: 90, externalBuiltIns: 3, totalBuiltIns: 93, included: 92, accountedZeroUnit: 1, extensionUnits: inventory.units.length - inventory.units.filter(unit => unit.component === 'core').length };
  for (const [field, expected] of Object.entries(expectedCounts)) if (scope.counts?.[field] !== expected) reject('scope-counts', `scope.counts.${field}`, expected, scope.counts?.[field]);
}

export function resolveTranslationPath(extensionRoot, translationPath) {
  if (typeof translationPath !== 'string' || !translationPath.startsWith('./') || path.posix.normalize(translationPath.slice(2)) !== translationPath.slice(2) || translationPath.includes('\\')) reject('manifest-path', translationPath, 'normalized relative path', translationPath);
  const root = path.resolve(extensionRoot);
  const resolved = path.resolve(root, ...translationPath.slice(2).split('/'));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) reject('manifest-path', translationPath, 'path beneath extension root', resolved);
  return resolved;
}

export function validateManifestPaths(manifest, { extensionRoot = 'extension' } = {}) {
  const localizations = manifest?.contributes?.localizations;
  if (!Array.isArray(localizations) || localizations.length !== 1) reject('manifest-localization', 'manifest.contributes.localizations', 1, localizations);
  const declaration = localizations[0];
  if (declaration.languageId !== 'yue' || declaration.languageName !== 'Cantonese' || declaration.localizedLanguageName !== '粵語') reject('manifest-locale', 'manifest.localization', 'exact yue declaration', declaration);
  if (!Array.isArray(declaration.translations)) reject('manifest-topology', 'manifest.translations', 'array', declaration.translations);
  const ids = new Set();
  const paths = new Set();
  for (const translation of declaration.translations) {
    if (typeof translation?.id !== 'string' || ids.has(translation.id)) reject('manifest-duplicate-id', translation?.id, 'unique translation ID', translation?.id);
    resolveTranslationPath(extensionRoot, translation.path);
    if (paths.has(translation.path)) reject('manifest-duplicate-path', translation.path, 'unique translation path', translation.path);
    ids.add(translation.id);
    paths.add(translation.path);
  }
  return declaration;
}

export function validateManifestTopology(inventory, manifest, bundles, { extensionRoot = 'extension' } = {}) {
  const declaration = validateManifestPaths(manifest, { extensionRoot });
  const paths = new Set(declaration.translations.map(translation => translation.path));
  for (const translation of declaration.translations) {
    const envelope = bundles.get(translation.path);
    if (!plainObject(envelope) || envelope.version !== '1.0.0' || !plainObject(envelope.contents)) reject('runtime-envelope', translation.path, 'version 1.0.0 object contents', envelope);
  }
  const expected = deriveTranslations(inventory);
  if (canonicalStringify(declaration.translations) !== canonicalStringify(expected)) reject('manifest-topology', 'manifest.translations', expected, declaration.translations);
  if (bundles.size !== expected.length || [...bundles.keys()].some(key => !paths.has(key))) reject('unmapped-bundle', 'runtime bundles', expected.length, bundles.size);
}

function countOccurrences(text, fragment) {
  let count = 0;
  for (let cursor = 0; fragment && (cursor = text.indexOf(fragment, cursor)) !== -1; cursor += fragment.length) count += 1;
  return count;
}

export function targetProtectedContent(target, sourceUnit) {
  const entries = extractProtectedContent(target, []).filter(entry => {
    const locked = sourceUnit.protected.filter(item => item.type === 'locked');
    if (entry.type === 'url' && sourceUnit.protected.some(item => item.type === 'url' && item.value === entry.value)) return true;
    if (entry.type === 'url' && locked.some(item => item.value === `](${entry.value})`)) return false;
    if (entry.type !== 'markdown-link') return true;
    if (sourceUnit.protected.some(item => item.type === 'markdown-link' && item.value === entry.value)) return true;
    const [destination] = JSON.parse(entry.value);
    return !locked.some(item => item.value === `](${destination})`);
  });
  for (const locked of sourceUnit.protected.filter(item => item.type === 'locked')) {
    const count = countOccurrences(target, locked.value);
    // A Locked declaration is a minimum-presence instruction, not an
    // occurrence inventory. A short fragment such as "[" may legitimately
    // occur multiple times in translated Markdown even when declared once.
    if (count >= locked.count) entries.push({ type: 'locked', value: locked.value, count: locked.count });
  }
  return foldProtectedEntries(entries);
}

export function applicableSourceProtection(sourceUnit) {
  if (typeof sourceUnit.source !== 'string') return sourceUnit.protected;
  const linkDestinations = new Set(
    sourceUnit.protected
      .filter(item => item.type === 'markdown-link')
      .map(item => JSON.parse(item.value)[0])
  );
  const hasStaleMarkdownLock = sourceUnit.protected.some(item => {
    if (item.type !== 'locked' || sourceUnit.source.includes(item.value)) return false;
    const match = /^\]\(([^)]+)\)$/.exec(item.value);
    if (!match) return false;
    const destinationIsPlaceholder = /^\{(?:\d+|[A-Za-z_][A-Za-z0-9_.-]*)\}$/.test(match[1]);
    return (destinationIsPlaceholder || linkDestinations.size > 0) && !linkDestinations.has(match[1]);
  });
  return sourceUnit.protected.filter(item => {
    // A percent sign followed by prose (for example "% of" or "% current")
    // is not a printf conversion. The extractor's optional space flag makes
    // those English fragments look like `% o` / `% c` placeholders.
    if (item.type === 'placeholder' && /^% [A-Za-z]$/.test(item.value)) return false;
    if (hasStaleMarkdownLock && item.type === 'locked' && item.value === '[' && !sourceUnit.source.includes('[')) return false;
    if (item.type !== 'locked' || sourceUnit.source.includes(item.value)) return true;
    const match = /^\]\(([^)]+)\)$/.exec(item.value);
    if (!match) return true;
    const destinationIsPlaceholder = /^\{(?:\d+|[A-Za-z_][A-Za-z0-9_.-]*)\}$/.test(match[1]);
    return (!destinationIsPlaceholder && linkDestinations.size === 0) || linkDestinations.has(match[1]);
  });
}

export function validateTargetState(inventory, targets = []) {
  if (!Array.isArray(targets)) reject('target-schema', 'targets', 'array', targets);
  if (targets.length === 0) return { mode: 'phase-2-empty' };
  const sources = new Map(inventory.units.map(unit => [unit.id, unit]));
  const seen = new Set();
  for (const record of targets) {
    const location = typeof record?.id === 'string' ? record.id : '<target>';
    if (!plainObject(record) || !sources.has(record.id)) reject('unknown-target', location, 'known source ID', record?.id);
    if (seen.has(record.id)) reject('duplicate-target', location, 'one target per source ID', record.id);
    seen.add(record.id);
    if (typeof record.target !== 'string' || record.target.trim().length === 0) reject('blank-target', location, 'nonblank target', record?.target);
    const source = sources.get(record.id);
    if (typeof record.sourceFingerprint !== 'string' || record.sourceFingerprint !== source.sourceFingerprint) reject('stale-approval', location, source.sourceFingerprint, record.sourceFingerprint);
    const expectedProtection = applicableSourceProtection(source);
    const actual = targetProtectedContent(record.target, { ...source, protected: expectedProtection }).filter(item =>
      item.type !== 'placeholder' ||
      !/^% [A-Za-z]$/.test(item.value) ||
      expectedProtection.some(expected => expected.type === item.type && expected.value === item.value)
    );
    if (canonicalStringify(actual) !== canonicalStringify(expectedProtection)) reject('target-protected-content', location, expectedProtection, actual);
  }
  if (seen.size !== sources.size) {
    const missing = inventory.units.find(unit => !seen.has(unit.id));
    reject('missing-target', missing?.id, sources.size, seen.size);
  }
  return { mode: 'complete', count: seen.size };
}

export function recordsFromRuntimeBundles(inventory, manifest, bundles) {
  const records = [];
  const fingerprints = new Map(inventory.units.map(unit => [unit.id, unit.sourceFingerprint]));
  for (const translation of manifest.contributes.localizations[0].translations) {
    const contents = bundles.get(translation.path).contents;
    for (const [module, messages] of Object.entries(contents)) {
      if (!plainObject(messages)) reject('target-schema', `${translation.id}/${module}`, 'message object', messages);
      for (const [key, target] of Object.entries(messages)) {
        const id = canonicalStringify([translation.id, module, key]);
        records.push({ id, target, sourceFingerprint: fingerprints.get(id) ?? '<unknown>' });
      }
    }
  }
  return records;
}

export function comparableGeneratedFile(relative, value) {
  if (relative === 'sources/provenance.json') {
    const normalized = structuredClone(value);
    if (normalized.audit) normalized.audit.retrievedAt = '<audit-only>';
    return canonicalBytes(normalized);
  }
  return canonicalBytes(value);
}

export function currentFingerprint(unit) {
  return `sha256:${canonicalHash([unit.source, unit.context, unit.protected])}`;
}
