#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstat, readFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalBytes, canonicalStringify, compareOrdinal, sha256Bytes } from './lib/canonical-json.mjs';
import { extractVscodeLocalizationCalls, normalizeCoreMetadata, normalizePackageCatalog } from './lib/vscode-localization.mjs';
import { PINNED_CORE } from './lib/remote-zip.mjs';
import { isDeniedSourceInput } from './lib/source-isolation.mjs';
import { createOwnedTemp, removeOwnedTemp } from './lib/owned-temp.mjs';

const EXPECTED_BASELINE = Object.freeze({
  repository: 'https://github.com/microsoft/vscode.git',
  tag: '1.129.1',
  commit: '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8',
  sourceLocale: 'en'
});
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_CORE_BYTES = 3 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_JAVASCRIPT_BYTES = 24 * 1024 * 1024;

function fail(message) {
  throw new Error(`source generation failed: ${message}`);
}

function parseArgs(argv) {
  let cache;
  let output = process.cwd();
  let outputSpecified = false;
  let inventoryOnly = false;
  let checkReproducible = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cache') cache = argv[++index];
    else if (argument === '--output') { output = argv[++index]; outputSpecified = true; }
    else if (argument === '--inventory-only') inventoryOnly = true;
    else if (argument === '--check-reproducible') checkReproducible = true;
    else fail(`unknown argument ${argument}`);
  }
  if (!cache) fail('usage: node scripts/source-generate.mjs --cache <directory> [--output <directory>] [--check-reproducible] [--inventory-only]');
  const cacheRoot = path.resolve(cache);
  const outputRoot = path.resolve(output);
  if (cacheRoot === path.parse(cacheRoot).root || outputRoot === path.parse(outputRoot).root) fail('cache and output roots must not be filesystem roots');
  return { cacheRoot, outputRoot, outputSpecified, checkReproducible, inventoryOnly };
}

async function readBounded(file, limit, label) {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size < 0 || metadata.size > limit) fail(`${label} exceeds its input budget or is not a file`);
  return readFile(file);
}

function verifyCacheContract(cacheRoot) {
  const verifier = path.resolve('scripts/source-acquire.mjs');
  const result = spawnSync(process.execPath, [verifier, '--cache', cacheRoot, '--verify-only'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) fail(`verified-cache check could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`verified-cache check rejected the input: ${String(result.stderr || result.stdout).trim()}`);
}

async function loadIndex(cacheRoot) {
  const bytes = await readBounded(path.join(cacheRoot, 'index.json'), MAX_INDEX_BYTES, 'cache index');
  let index;
  try { index = JSON.parse(bytes.toString('utf8')); } catch { fail('cache index is invalid JSON'); }
  if (index.schemaVersion !== 1 || !index.baseline || !index.scope || !Array.isArray(index.records)) fail('cache index shape is invalid');
  for (const [field, expected] of Object.entries(EXPECTED_BASELINE)) if (index.baseline[field] !== expected) fail(`cache baseline ${field} mismatch`);
  const paths = [index.baseline.repository, ...index.records.flatMap(record => [record.path, record.upstreamPath, record.origin])];
  if (paths.some(isDeniedSourceInput)) fail('cache index violates the English-only input policy');
  const byPath = new Map(index.records.map(record => [record.path, record]));
  if (byPath.size !== index.records.length || index.records.some(record => record.verified !== true)) fail('cache index contains duplicate or unverified records');
  return { index, byPath };
}

async function readRecord(cacheRoot, byPath, recordPath, limit) {
  const record = byPath.get(recordPath);
  if (!record) fail(`required verified cache record is absent: ${recordPath}`);
  const bytes = await readBounded(path.join(cacheRoot, ...recordPath.split('/')), limit, recordPath);
  if (bytes.length !== record.bytes || sha256Bytes(bytes) !== record.sha256) fail(`verified cache record changed during generation: ${recordPath}`);
  return bytes;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`${label} is invalid JSON`); }
}

function catalogValue(raw, label) {
  if (typeof raw === 'string') return { message: raw, context: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).every(key => key === 'message' || key === 'comment') || typeof raw.message !== 'string') fail(`${label} has an unsupported value`);
  const context = raw.comment === undefined ? [] : typeof raw.comment === 'string' ? [raw.comment] : raw.comment;
  if (!Array.isArray(context) || context.some(item => typeof item !== 'string')) fail(`${label} has invalid comments`);
  return { message: raw.message, context };
}

function assertCatalogParity(artifact, source, extension) {
  const artifactKeys = Object.keys(artifact).sort(compareOrdinal);
  const sourceKeys = Object.keys(source).sort(compareOrdinal);
  if (canonicalStringify(artifactKeys) !== canonicalStringify(sourceKeys)) fail(`package catalog key mismatch for ${extension}`);
  for (const key of artifactKeys) {
    const artifactValue = catalogValue(artifact[key], `${extension}/${key}`);
    const sourceValue = catalogValue(source[key], `${extension}/${key}`);
    if (artifactValue.message !== sourceValue.message) fail(`package catalog default mismatch for ${extension}/${key}`);
  }
}

function addUnits(target, identities, units) {
  for (const unit of units) {
    const tuple = canonicalStringify([unit.bundle, unit.module, unit.key]);
    if (tuple !== unit.id) fail(`unit ID is not reversible: ${unit.id}`);
    if (identities.has(tuple)) fail(`duplicate unit identity: ${tuple}`);
    identities.add(tuple);
    target.push(unit);
  }
}

async function generateInventory(cacheRoot) {
  const { index, byPath } = await loadIndex(cacheRoot);
  const units = [];
  const identities = new Set();
  const coreBytes = await readRecord(cacheRoot, byPath, 'blobs/artifact/core/nls.metadata.json', MAX_CORE_BYTES);
  const coreUnits = normalizeCoreMetadata(parseJson(coreBytes, 'core metadata'));
  addUnits(units, identities, coreUnits);

  const manifests = new Map();
  const allExtensions = [...index.scope.local, ...index.scope.external].sort(compareOrdinal);
  for (const extension of allExtensions) {
    const manifestPath = `blobs/artifact/extensions/${extension}/package.json`;
    const manifest = parseJson(await readRecord(cacheRoot, byPath, manifestPath, MAX_CATALOG_BYTES), manifestPath);
    if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.publisher) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.name)) fail(`invalid extension bundle identity for ${extension}`);
    const bundle = `${manifest.publisher}.${manifest.name}`;
    if ([...manifests.values()].some(item => item.bundle === bundle)) fail(`duplicate extension bundle owner: ${bundle}`);
    manifests.set(extension, { manifest, bundle });
  }

  for (const extension of index.scope.catalogs) {
    const artifactPath = `blobs/artifact/extensions/${extension}/package.nls.json`;
    const artifact = parseJson(await readRecord(cacheRoot, byPath, artifactPath, MAX_CATALOG_BYTES), artifactPath);
    let catalog = artifact;
    if (index.scope.local.includes(extension)) {
      const sourcePath = `blobs/source/extensions/${extension}/package.nls.json`;
      const source = parseJson(await readRecord(cacheRoot, byPath, sourcePath, MAX_CATALOG_BYTES), sourcePath);
      assertCatalogParity(artifact, source, extension);
      catalog = source;
    }
    addUnits(units, identities, normalizePackageCatalog(catalog, { bundle: manifests.get(extension).bundle }));
  }

  let candidateCalls = 0;
  let consumedCalls = 0;
  let foldedExactCalls = 0;
  for (const extension of Object.keys(index.scope.javascript).sort(compareOrdinal)) {
    const owner = manifests.get(extension);
    if (!owner) fail(`JavaScript graph has unknown owner ${extension}`);
    for (const relative of [...index.scope.javascript[extension]].sort(compareOrdinal)) {
      const recordPath = `blobs/artifact/extensions/${extension}/${relative}`;
      const source = (await readRecord(cacheRoot, byPath, recordPath, MAX_JAVASCRIPT_BYTES)).toString('utf8');
      let extracted;
      try { extracted = extractVscodeLocalizationCalls(source, { bundle: owner.bundle, module: relative }); }
      catch (error) { fail(`${recordPath}: ${error instanceof Error ? error.message : String(error)}`); }
      candidateCalls += extracted.candidateCalls;
      consumedCalls += extracted.consumedCalls;
      foldedExactCalls += extracted.foldedExactCalls;
      addUnits(units, identities, extracted.units);
    }
  }
  if (candidateCalls !== consumedCalls) fail(`localization-call count mismatch: ${candidateCalls} candidates, ${consumedCalls} consumed`);
  units.sort((left, right) => compareOrdinal(left.id, right.id));
  const inventory = {
    schemaVersion: 1,
    sourceLocale: 'en',
    baseline: {
      repository: EXPECTED_BASELINE.repository,
      tag: EXPECTED_BASELINE.tag,
      commit: EXPECTED_BASELINE.commit
    },
    units
  };
  const bytes = canonicalBytes(inventory);
  return {
    bytes,
    inventory,
    index,
    manifests,
    summary: {
      coreModules: index.summary.coreModules,
      coreSourceOccurrences: 21_818,
      coreUnits: coreUnits.length,
      extensionUnits: units.length - coreUnits.length,
      totalUnits: units.length,
      bundleOwners: new Set(units.map(unit => unit.bundle)).size,
      candidateCalls,
      consumedCalls,
      foldedExactCalls
    }
  };
}

function countInventory(inventory) {
  const modules = new Set();
  const bundles = new Set();
  let coreUnits = 0;
  for (const unit of inventory.units) {
    modules.add(`${unit.bundle}\0${unit.module}`);
    bundles.add(unit.bundle);
    if (unit.component === 'core') coreUnits += 1;
  }
  return {
    coreUnits,
    extensionUnits: inventory.units.length - coreUnits,
    totalUnits: inventory.units.length,
    modules: modules.size,
    bundleOwners: bundles.size
  };
}

function createScope(index, manifests, inventory) {
  const unitCounts = new Map();
  for (const unit of inventory.units) unitCounts.set(unit.bundle, (unitCounts.get(unit.bundle) ?? 0) + 1);
  const local = new Set(index.scope.local);
  const external = new Set(index.scope.external);
  const acquired = [...local, ...external].sort(compareOrdinal);
  if (local.size !== 90 || external.size !== 3 || acquired.length !== 93 || new Set(acquired).size !== 93) fail('acquired scope is not exactly 90 local plus three external built-ins');

  const extensions = acquired.map(name => {
    const owner = manifests.get(name);
    if (!owner) fail(`scope owner is missing for ${name}`);
    const localizationUnitCount = unitCounts.get(owner.bundle) ?? 0;
    return {
      name,
      source: local.has(name) ? 'local' : 'external',
      version: owner.manifest.version,
      sourceIdentity: local.has(name) ? EXPECTED_BASELINE.commit : `${owner.bundle}@${owner.manifest.version}`,
      disposition: localizationUnitCount === 0 ? 'accounted-zero-unit' : 'included',
      localizationUnitCount,
      bundleId: localizationUnitCount === 0 ? null : owner.bundle
    };
  });
  if (extensions.some(item => typeof item.version !== 'string' || item.version.length === 0)) fail('scope extension version is missing');
  const countedUnits = extensions.reduce((total, item) => total + item.localizationUnitCount, 0);
  const inventoryExtensionUnits = inventory.units.filter(unit => unit.component === 'extension').length;
  if (countedUnits !== inventoryExtensionUnits) fail('scope extension-unit count does not match inventory ownership');
  const inventoryBundles = new Set(inventory.units.filter(unit => unit.component === 'extension').map(unit => unit.bundle));
  const scopeBundles = new Set(extensions.filter(item => item.bundleId !== null).map(item => item.bundleId));
  if (inventoryBundles.size !== scopeBundles.size || [...inventoryBundles].some(bundle => !scopeBundles.has(bundle))) fail('scope bundle ownership does not match canonical inventory');

  const generatedBundlePaths = [...inventoryBundles].sort(compareOrdinal).map(bundle => `extension/translations/extensions/${bundle}.i18n.json`);
  return {
    schemaVersion: 1,
    baseline: { ...EXPECTED_BASELINE },
    counts: {
      localBuiltIns: local.size,
      externalBuiltIns: external.size,
      totalBuiltIns: extensions.length,
      included: extensions.filter(item => item.disposition === 'included').length,
      accountedZeroUnit: extensions.filter(item => item.disposition === 'accounted-zero-unit').length,
      extensionUnits: countedUnits
    },
    generatedBundlePaths,
    extensions
  };
}

function createProvenance(index, inventoryBytes, inventory, scope, retrievedAt) {
  const counts = countInventory(inventory);
  const license = index.records.find(record => record.path === 'blobs/source/LICENSE.txt');
  const core = index.records.find(record => record.path === 'blobs/artifact/core/nls.metadata.json');
  if (!license || !core) fail('license or core provenance record is missing');
  if (scope.counts.totalBuiltIns !== 93 || scope.counts.extensionUnits !== counts.extensionUnits) fail('provenance scope counts do not agree');
  return {
    schemaVersion: 1,
    generatorVersion: 2,
    audit: { retrievedAt },
    source: {
      repository: EXPECTED_BASELINE.repository,
      tag: EXPECTED_BASELINE.tag,
      commit: EXPECTED_BASELINE.commit,
      sourceLocale: EXPECTED_BASELINE.sourceLocale,
      node: index.baseline.node,
      retrievalMethod: 'verified sparse Git source plus bounded Stable artifact ZIP ranges',
      officialReleaseApi: index.baseline.latestReleaseApi,
      officialArtifactUrl: index.baseline.artifactEndpoint,
      commitArtifactUrl: `https://update.code.visualstudio.com/commit:${EXPECTED_BASELINE.commit}/win32-x64-archive/stable`,
      repositoryCommitUrl: `https://github.com/microsoft/vscode/commit/${EXPECTED_BASELINE.commit}`,
      approvedUpstreamPaths: [...new Set(index.records.map(record => record.upstreamPath))].sort(compareOrdinal)
    },
    artifact: {
      bytes: index.baseline.artifactSize,
      coreEntry: PINNED_CORE.coreEntry,
      coreCompression: 'deflate',
      coreCompressedStart: PINNED_CORE.coreCompressedStart,
      coreCompressedEnd: PINNED_CORE.coreCompressedEnd,
      coreCompressedBytes: PINNED_CORE.coreCompressedEnd - PINNED_CORE.coreCompressedStart + 1,
      coreInflatedBytes: PINNED_CORE.coreInflatedSize,
      coreSha256: core.sha256
    },
    license: {
      path: license.upstreamPath,
      sha256: license.sha256,
      bytes: license.bytes,
      reference: `https://github.com/microsoft/vscode/blob/${EXPECTED_BASELINE.commit}/LICENSE.txt`
    },
    counts: {
      consumedRecords: index.records.length,
      localBuiltIns: scope.counts.localBuiltIns,
      externalBuiltIns: scope.counts.externalBuiltIns,
      totalBuiltIns: scope.counts.totalBuiltIns,
      accountedZeroUnit: scope.counts.accountedZeroUnit,
      coreModules: new Set(inventory.units.filter(unit => unit.component === 'core').map(unit => unit.module)).size,
      modules: counts.modules,
      coreUnits: counts.coreUnits,
      extensionUnits: counts.extensionUnits,
      totalUnits: counts.totalUnits,
      bundleOwners: counts.bundleOwners
    },
    inventorySha256: sha256Bytes(inventoryBytes),
    consumedBlobs: index.records.map(({ path: recordPath, origin, upstreamPath, kind, sha256, bytes }) => ({ path: recordPath, origin, upstreamPath, kind, sha256, bytes })),
    externalArtifacts: index.externalArtifacts
  };
}

async function writeAtomic(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, destination);
}

async function promoteAccounting(outputRoot, inventoryBytes, provenance, scope) {
  const sourceRoot = path.join(outputRoot, 'sources');
  await writeAtomic(path.join(sourceRoot, 'inventory.en.json'), inventoryBytes);
  await writeAtomic(path.join(sourceRoot, 'provenance.json'), canonicalBytes(provenance));
  await writeAtomic(path.join(sourceRoot, 'scope.json'), canonicalBytes(scope));
}

function deriveTranslations(inventory) {
  const owners = new Set(inventory.units.map(unit => unit.bundle));
  if (!owners.delete('vscode')) fail('canonical inventory has no core vscode bundle owner');
  const extensionOwners = [...owners].sort(compareOrdinal);
  for (const owner of extensionOwners) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) fail(`unsafe extension bundle ID ${owner}`);
  return [
    { id: 'vscode', path: './translations/main.i18n.json' },
    ...extensionOwners.map(id => ({ id, path: `./translations/extensions/${id}.i18n.json` }))
  ];
}

function deriveManifest(template, translations) {
  const localizations = template?.contributes?.localizations;
  if (!Array.isArray(localizations) || localizations.length !== 1) fail('provisional manifest localization shape changed');
  const localization = localizations[0];
  if (template.name !== 'vscode-language-pack-yue-provisional' || template.publisher !== 'local-provisional' || template.version !== '0.0.0' || template.private !== true) fail('provisional private manifest identity changed');
  if (localization.languageId !== 'yue' || localization.languageName !== 'Cantonese' || localization.localizedLanguageName !== '粵語') fail('exact yue declaration changed');
  return {
    ...template,
    contributes: {
      ...template.contributes,
      localizations: [{ ...localization, translations }]
    }
  };
}

function resolveGeneratedBundle(root, relativePath) {
  if (typeof relativePath !== 'string' || !/^extension\/translations\/extensions\/[A-Za-z0-9][A-Za-z0-9._-]*\.i18n\.json$/.test(relativePath)) fail(`invalid generated bundle ledger path ${relativePath}`);
  const bundleRoot = path.resolve(root, 'extension', 'translations', 'extensions');
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(bundleRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.length === 0) fail(`generated bundle path escapes its root: ${relativePath}`);
  return target;
}

function validateTopology(manifest, scope, generated) {
  const localization = manifest.contributes.localizations[0];
  const ids = new Set();
  const paths = new Set();
  for (const translation of localization.translations) {
    if (typeof translation.id !== 'string' || ids.has(translation.id)) fail('manifest has an invalid or duplicate translation ID');
    if (typeof translation.path !== 'string' || !translation.path.startsWith('./') || path.posix.normalize(translation.path.slice(2)) !== translation.path.slice(2) || paths.has(translation.path)) fail('manifest has an invalid or duplicate translation path');
    ids.add(translation.id);
    paths.add(translation.path);
    const generatedPath = `extension/${translation.path.slice(2)}`;
    const bytes = generated.get(generatedPath);
    if (!bytes) fail(`manifest translation path is missing: ${translation.path}`);
    const envelope = parseJson(bytes, generatedPath);
    if (canonicalStringify(envelope) !== canonicalStringify({ version: '1.0.0', contents: {} })) fail(`runtime bundle is not an empty 1.0.0 envelope: ${translation.path}`);
  }
  if (scope.generatedBundlePaths.length !== localization.translations.length - 1) fail('scope ledger and extension manifest bundle counts differ');
  for (const ledgerPath of scope.generatedBundlePaths) {
    resolveGeneratedBundle('.', ledgerPath);
    if (!generated.has(ledgerPath)) fail(`generated bundle ledger path is missing: ${ledgerPath}`);
  }
}

async function buildFullGeneration(cacheRoot, manifestTemplate, retrievedAt) {
  const generatedInventory = await generateInventory(cacheRoot);
  const scope = createScope(generatedInventory.index, generatedInventory.manifests, generatedInventory.inventory);
  const provenance = createProvenance(generatedInventory.index, generatedInventory.bytes, generatedInventory.inventory, scope, retrievedAt);
  const translations = deriveTranslations(generatedInventory.inventory);
  const manifest = deriveManifest(manifestTemplate, translations);
  const envelope = canonicalBytes({ version: '1.0.0', contents: {} });
  const generated = new Map([
    ['sources/inventory.en.json', generatedInventory.bytes],
    ['sources/provenance.json', canonicalBytes(provenance)],
    ['sources/scope.json', canonicalBytes(scope)],
    ['extension/package.json', canonicalBytes(manifest)],
    ['extension/translations/main.i18n.json', envelope]
  ]);
  for (const translation of translations.slice(1)) generated.set(`extension/${translation.path.slice(2)}`, envelope);
  validateTopology(manifest, scope, generated);
  return { ...generatedInventory, generated, provenance, scope, manifest };
}

function comparableGenerated(generation) {
  const result = new Map(generation.generated);
  const normalized = structuredClone(generation.provenance);
  normalized.audit.retrievedAt = '<audit-only>';
  result.set('sources/provenance.json', canonicalBytes(normalized));
  return result;
}

function compareGenerated(left, right) {
  if (left.size !== right.size) fail('reproducible generation produced a different file count');
  for (const [name, bytes] of left) {
    const other = right.get(name);
    if (!other || !bytes.equals(other) || sha256Bytes(bytes) !== sha256Bytes(other)) fail(`reproducible generation differs at ${name}`);
  }
}

async function writeGeneratedTree(root, generation) {
  for (const [relative, bytes] of generation.generated) await writeAtomic(path.join(root, ...relative.split('/')), bytes);
}

async function readPriorLedger(root) {
  try {
    const scope = parseJson(await readFile(path.join(root, 'sources', 'scope.json')), 'prior scope ledger');
    if (scope.generatedBundlePaths === undefined) return [];
    if (!Array.isArray(scope.generatedBundlePaths)) fail('prior generated bundle ledger is invalid');
    for (const relative of scope.generatedBundlePaths) resolveGeneratedBundle(root, relative);
    return scope.generatedBundlePaths;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function assertStaleLedgerSafety(root, priorPaths, nextPaths) {
  const next = new Set(nextPaths);
  for (const relative of priorPaths) {
    if (next.has(relative)) continue;
    const target = resolveGeneratedBundle(root, relative);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`stale generated bundle is not a regular file: ${relative}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function promoteFullTree(root, staging, priorPaths, nextPaths) {
  await assertStaleLedgerSafety(root, priorPaths, nextPaths);
  const generatedPaths = [
    'sources/inventory.en.json',
    'sources/provenance.json',
    'sources/scope.json',
    'extension/package.json',
    'extension/translations/main.i18n.json',
    ...nextPaths
  ];
  const next = new Set(nextPaths);
  const stalePaths = priorPaths.filter(relative => !next.has(relative));
  const transactions = [
    ...generatedPaths.map(relative => ({ relative, promote: true })),
    ...stalePaths.map(relative => ({ relative, promote: false }))
  ];
  if (new Set(transactions.map(item => item.relative)).size !== transactions.length) fail('promotion transaction contains duplicate paths');
  const moved = [];
  try {
    for (const [index, item] of transactions.entries()) {
      const live = path.join(root, ...item.relative.split('/'));
      const staged = path.join(staging, ...item.relative.split('/'));
      const backup = `${live}.old-${process.pid}-${index}`;
      let hadLive = true;
      try {
        const metadata = await lstat(live);
        if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`generated destination is not a regular file: ${item.relative}`);
      } catch (error) { if (error?.code === 'ENOENT') hadLive = false; else throw error; }
      if (hadLive) await rename(live, backup);
      try {
        if (item.promote) {
          await mkdir(path.dirname(live), { recursive: true });
          await rename(staged, live);
        }
        moved.push({ live, promoted: item.promote, backup: hadLive ? backup : null });
      } catch (error) {
        if (hadLive) await rename(backup, live).catch(() => {});
        throw error;
      }
    }
    for (const item of moved) if (item.backup) await rm(item.backup, { force: true });
  } catch (error) {
    for (const item of moved.reverse()) {
      if (item.promoted) await rm(item.live, { force: true }).catch(() => {});
      if (item.backup) await rename(item.backup, item.live).catch(() => {});
    }
    throw error;
  }
}

async function generateAndPromote(cacheRoot, outputRoot, outputSpecified, checkReproducible) {
  const manifestTemplate = parseJson(await readFile(path.resolve('extension/package.json')), 'provisional manifest');
  if (outputSpecified) {
    const generation = await buildFullGeneration(cacheRoot, manifestTemplate, new Date().toISOString());
    await writeGeneratedTree(outputRoot, generation);
    return generation;
  }
  const ownedTemporary = await createOwnedTemp(path.join(outputRoot, '.generation-tmp'), 'source-generate-');
  const temporaryRoot = ownedTemporary.path;
  const firstRoot = path.join(temporaryRoot, 'first');
  const secondRoot = path.join(temporaryRoot, 'second');
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  try {
    const first = await buildFullGeneration(cacheRoot, manifestTemplate, new Date().toISOString());
    const second = await buildFullGeneration(cacheRoot, manifestTemplate, new Date(Date.now() + 1).toISOString());
    await writeGeneratedTree(firstRoot, first);
    await writeGeneratedTree(secondRoot, second);
    compareGenerated(comparableGenerated(first), comparableGenerated(second));
    const priorPaths = await readPriorLedger(outputRoot);
    await promoteFullTree(outputRoot, firstRoot, priorPaths, first.scope.generatedBundlePaths);
    return first;
  } finally {
    await removeOwnedTemp(ownedTemporary);
  }
}

async function promoteInventory(outputRoot, bytes) {
  const directory = path.join(outputRoot, 'sources');
  const destination = path.join(directory, 'inventory.en.json');
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.inventory.en.json.tmp-${process.pid}`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, destination);
  return destination;
}

const { cacheRoot, outputRoot, outputSpecified, checkReproducible, inventoryOnly } = parseArgs(process.argv.slice(2));
try {
  verifyCacheContract(cacheRoot);
  let first;
  if (!inventoryOnly) first = await generateAndPromote(cacheRoot, outputRoot, outputSpecified, checkReproducible);
  else first = await generateInventory(cacheRoot);
  if (inventoryOnly && checkReproducible) {
    const second = await generateInventory(cacheRoot);
    if (!first.bytes.equals(second.bytes) || sha256Bytes(first.bytes) !== sha256Bytes(second.bytes)) fail('two independent inventory generations were not byte-identical');
  }
  let destination;
  if (inventoryOnly) {
    destination = await promoteInventory(outputRoot, first.bytes);
  } else destination = outputRoot;
  process.stdout.write(`Generated ${first.summary.totalUnits} English units (${first.summary.coreUnits} unique core from ${first.summary.coreSourceOccurrences} source occurrences, ${first.summary.extensionUnits} extension) across ${first.summary.bundleOwners} bundle owners; consumed ${first.summary.consumedCalls}/${first.summary.candidateCalls} localization calls and folded ${first.summary.foldedExactCalls} exact repeats.\n`);
  process.stdout.write(`Inventory SHA-256: ${sha256Bytes(first.bytes)}\n`);
  process.stdout.write(`Wrote ${destination}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
