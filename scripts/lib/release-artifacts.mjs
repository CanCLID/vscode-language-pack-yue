import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalBytes, canonicalHash, canonicalStringify, compareOrdinal } from './canonical-json.mjs';
import { deriveTranslations, validateInventory, validateProvenance, validateScope, validateTargetState } from './invariants.mjs';

const sha = value => `sha256:${canonicalHash(value)}`;
const fail = message => { throw new Error(`[release-input] ${message}`); };

export function validateReleaseInputs({ inventory, provenance, scope, corpus, candidate, styleGuide, termbase }) {
  validateInventory(inventory, canonicalBytes(inventory));
  validateProvenance(provenance, inventory, canonicalBytes(inventory), scope);
  validateScope(inventory, scope);
  if (corpus?.schemaVersion !== 'translation-corpus-v1' || corpus.sourceLocale !== 'en' || corpus.targetLocale !== 'yue') fail('final corpus schema or locale is invalid');
  if (corpus.recordCount !== inventory.units.length || corpus.records?.length !== inventory.units.length) fail('final corpus record count must match the English inventory');
  if (corpus.inventoryHash !== `sha256:${canonicalHash(inventory)}`) fail('corpus inventory binding is stale');
  validateTargetState(inventory, corpus.records);
  if (candidate?.schemaVersion !== 'release-candidate-config-v1' || candidate.status !== 'public-release-authorized' || candidate.publicReleaseAuthorized !== true || candidate.locale !== 'yue') fail('release is not explicitly authorized');
  if (!candidate.externalIdentity || Object.keys(candidate.externalIdentity).sort(compareOrdinal).join(',') !== 'extensionName,publisher,repository') fail('external identity shape is invalid');
  if (candidate.externalIdentity.publisher !== 'CanCLID' || candidate.externalIdentity.extensionName !== 'vscode-language-pack-yue' || candidate.externalIdentity.repository !== 'https://github.com/CanCLID/vscode-language-pack-yue') fail('final external identity is invalid');
  if (typeof styleGuide !== 'string' || styleGuide.length < 1000 || !termbase || typeof termbase !== 'object') fail('style guide and termbase policy inputs are required');
  const [major, minor] = provenance.source.tag.split('.');
  if (!new RegExp(`^${major}\\.${minor}\\.\\d+$`).test(candidate.version)) fail('candidate version must align with the source major/minor');
  return { units: inventory.units.length, translations: deriveTranslations(inventory) };
}

function originalIcon() {
  return readFileSync(path.resolve(import.meta.dirname, '../../release/assets/languagepack.png'));
}

function materials(provenance, candidate) {
  const tag=provenance.source.tag, commit=provenance.source.commit;
  const license=`MIT License\n\nCopyright (c) 2026 Cantonese Language Pack contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`;
  return {
    readme: `# Cantonese Language Pack for VS Code\n\nCantonese Language Pack 為 VS Code 提供香港粵語介面。\n\n## 用法\n\n你可以用 **Configure Display Language** 指令設定 VS Code 嘅顯示語言。撳 \`Ctrl+Shift+P\` 開啟 **Command Palette**，輸入 \`display\`，再揀 **Configure Display Language**。喺語言清單揀「粵語」之後，重新啟動 VS Code 就得。\n\n詳情請睇 [VS Code 文件](https://go.microsoft.com/fwlink/?LinkId=761051)。\n\n## 貢獻\n\n如果翻譯有問題，請喺 [GitHub repository](https://github.com/CanCLID/vscode-language-pack-yue/issues) 開 issue。\n\n## 授權\n\nSource code and strings are licensed under the [MIT](https://github.com/CanCLID/vscode-language-pack-yue/blob/main/extension/LICENSE) license.\n\n**Enjoy!**\n`,
    changelog: `# Changelog\n\n## ${candidate.version}\n\n- Cantonese language-pack release for VS Code ${tag}.\n- Includes ${candidate.unitCount.toLocaleString('en-US')} translations across ${candidate.bundleCount} runtime bundles.\n- Source baseline: ${commit}.\n`,
    license,
    notices: `Third-Party Notices\n\nVisual Studio Code source\nCopyright (c) Microsoft Corporation\nRepository: https://github.com/microsoft/vscode\nTag: ${tag}\nCommit: ${commit}\nLicense reference: https://github.com/microsoft/vscode/blob/${commit}/LICENSE.txt\n\n${license}`
  };
}

export function buildReleaseArtifacts(inputs) {
  const { inventory, provenance, corpus, candidate } = inputs;
  const validated=validateReleaseInputs(inputs);
  const targets=new Map(corpus.records.map(record=>[record.id,record.target]));
  const envelopes=new Map(validated.translations.map(item=>[item.id,{version:'1.0.0',contents:{}}]));
  for (const unit of inventory.units) {
    const contents=envelopes.get(unit.bundle).contents;
    (contents[unit.module] ??= {})[unit.key]=targets.get(unit.id);
  }
  const manifest={
    name:candidate.externalIdentity.extensionName, displayName:'Cantonese (Hong Kong) Language Pack for Visual Studio Code',
    description:'Language pack extension for Cantonese', version:candidate.version,
    publisher:candidate.externalIdentity.publisher, repository:{type:'git',url:candidate.externalIdentity.repository},
    license:'MIT', icon:'images/icon.png', categories:['Language Packs'], keywords:['粵語'],
    engines:{vscode:`^${provenance.source.tag}`},
    contributes:{localizations:[{languageId:'yue',languageName:'Cantonese',localizedLanguageName:'粵語',translations:validated.translations}]}
  };
  const files=new Map();
  for(const translation of validated.translations){ const relative=translation.path.slice(2); files.set(`extension/${relative}`,canonicalBytes(envelopes.get(translation.id))); }
  const text=materials(provenance, {...candidate, unitCount: inventory.units.length, bundleCount: validated.translations.length});
  files.set('extension/package.json',canonicalBytes(manifest)); files.set('extension/README.md',Buffer.from(text.readme)); files.set('extension/CHANGELOG.md',Buffer.from(text.changelog)); files.set('extension/LICENSE',Buffer.from(text.license)); files.set('extension/ThirdPartyNotices.txt',Buffer.from(text.notices)); files.set('extension/images/icon.png',originalIcon());
  const outputHashes=Object.fromEntries([...files].map(([path,bytes])=>[path,`sha256:${canonicalHash([...bytes])}`]));
  const generationReceipt={schemaVersion:'release-generation-receipt-v1',status:'complete',unitCount:inventory.units.length,bundleCount:validated.translations.length,publicReleaseReady:true,authority:'translations/corpus.yue.json',inputs:{inventoryHash:sha(inventory),corpusHash:sha(corpus),provenanceHash:sha(provenance),scopeHash:sha(inputs.scope),candidateHash:sha(candidate)},policyBindings:{styleGuideHash:`sha256:${canonicalHash(inputs.styleGuide)}`,termbaseHash:sha(inputs.termbase)},outputHashes};
  return { files, manifest, receipt:generationReceipt };
}
