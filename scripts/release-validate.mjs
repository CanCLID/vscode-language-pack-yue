#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildReleaseArtifacts } from './lib/release-artifacts.mjs';
import { recordsFromRuntimeBundles, validateManifestTopology, validateTargetState } from './lib/invariants.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'); const json=async p=>JSON.parse(await readFile(path.join(ROOT,...p.split('/')),'utf8'));
const inputs={inventory:await json('sources/inventory.en.json'),provenance:await json('sources/provenance.json'),scope:await json('sources/scope.json'),corpus:await json('translations/corpus.yue.json'),candidate:await json('release/candidate.json'),styleGuide:await readFile(path.join(ROOT,'docs/cantonese-style-guide.md'),'utf8'),termbase:await json('terminology/termbase.json')};
const expected=buildReleaseArtifacts(inputs); const manifest=await json('extension/package.json');
if(manifest.publisher!=='CanCLID'||manifest.name!=='vscode-language-pack-yue'||manifest.repository?.url!=='https://github.com/CanCLID/vscode-language-pack-yue'||manifest.private!==undefined)throw new Error('[release-identity] final Marketplace identity is invalid');
if(manifest.engines?.vscode!==`^${inputs.provenance.source.tag}`||manifest.categories?.length!==1||manifest.categories[0]!=='Language Packs')throw new Error('[candidate-metadata] source compatibility or category is stale');
const bundles=new Map(); for(const translation of manifest.contributes.localizations[0].translations)bundles.set(translation.path,await json(`extension/${translation.path.slice(2)}`));
validateManifestTopology(inputs.inventory,manifest,bundles,{extensionRoot:path.join(ROOT,'extension')}); validateTargetState(inputs.inventory,recordsFromRuntimeBundles(inputs.inventory,manifest,bundles));
for(const [relative,bytes] of expected.files){const actual=await readFile(path.join(ROOT,...relative.split('/')));if(!actual.equals(bytes))throw new Error(`[candidate-bytes] ${relative} is stale`)}
const icon=await readFile(path.join(ROOT,'extension/images/icon.png'));if(icon.length<100||icon.readUInt32BE(16)!==128||icon.readUInt32BE(20)!==128)throw new Error('[release-icon] expected official language-pack globe 128x128 PNG');
for(const name of ['README.md','CHANGELOG.md','LICENSE','ThirdPartyNotices.txt'])if((await stat(path.join(ROOT,'extension',name))).size<100)throw new Error(`[candidate-material] ${name} is incomplete`);
console.log(`Validated public release: ${inputs.inventory.units.length} translations, ${bundles.size} bundles, exact metadata/legal/icon bytes.`);
