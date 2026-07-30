# Cantonese VS Code language pack

## Product

- Extension: `CanCLID.vscode-language-pack-yue`
- Locale: `yue`; Traditional Hong Kong Cantonese
- Current source baseline: VS Code `1.129.1`, commit `8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8`
- Current release: `1.129.0`
- Scope: static VS Code core and declared built-in-extension localization only
- English is the sole translation source. Never inspect, copy, diff, or prompt from VS Code `zh-Hant`, `zh-TW`, or another localized pack while translating.

## Source of truth

| Purpose | File |
|---|---|
| English IDs, text, context, protected spans, fingerprints | `sources/inventory.en.json` |
| Source pin and acquisition provenance | `sources/provenance.json` |
| Included bundle scope | `sources/scope.json` |
| Hand-edited Cantonese targets | `translations/corpus.yue.json` |
| Language rules and examples | `docs/cantonese-style-guide.md` |
| Post-translation review rules | `docs/cantonese-verification-guide.md` |
| Highest-priority terminology decisions | `terminology/preference-overrides.json` |
| Reviewed sense-specific terminology | `terminology/termbase.json` |
| Protected English tokens | `terminology/do-not-translate.json` |
| Context-dependent English terms | `terminology/contextual-ambiguities.json` |
| Related action/state families | `terminology/semantic-families.json` |
| Release identity and version | `release/candidate.json` |

- `extension/translations/**/*.i18n.json`, `extension/package.json`, `extension/README.md`, and `extension/CHANGELOG.md` are generated. Never translate or correct them directly.
- `.planning/`, review ledgers, snapshots, receipts, caches, raw glossary material, and old work packets are historical or disposable. Do not require, update, or commit them.
- Never inspect `notes/` unless the user explicitly requests it. Exclude it from every search.

## Translation contract

- Read `docs/cantonese-style-guide.md` before writing targets.
- Write natural spoken Hong Kong Cantonese, not Standard Written Chinese with Cantonese vocabulary.
- Prefer concise task-oriented rephrasing. Preserve actor, action, object, scope, polarity, condition, state, safety implication, and consequence.
- Use Hong Kong technical usage. Keep familiar developer terms in English where that is more natural or more precise.
- Resolve terminology by English sense and UI context; never globally replace an ambiguous spelling.
- Terminology precedence: `preference-overrides.json` > applicable sense in `termbase.json` > translator judgment under the style guide. `do-not-translate.json` controls protected tokens in its recorded scope.
- Naturalness overrides mechanical symmetry. Review true sibling actions/states together and keep narrow contextual exceptions.
- Preserve IDs and exact source fingerprints. Preserve placeholder multisets, escapes, Markdown, links, command URIs, code, keybindings, product names, mnemonic semantics, and locked spans.
- Accelerators must use an ASCII Latin letter or digit, never a Chinese character. Distinguish accelerators from literal ampersands.
- Keep one space at an unprotected Latin/digit–Han boundary; do not insert spaces inside protected content.
- Use full-width punctuation in Cantonese prose; keep syntax punctuation unchanged inside protected content.
- Automated review is never human approval. Human review must check both native-Cantonese naturalness and developer/domain accuracy.

## Existing-target work

Use `.agents/skills/update-vscode-language-pack/SKILL.md` for all translation work:

- user reports a wrong translation;
- user asks the agent to add, modify, or review targets;
- user has already edited the corpus or generated bundles;
- VS Code is being pinned to a newer release.

For corrections against the same English baseline:

1. Inspect the working-tree diff without overwriting user edits.
2. Map every requested/generated-bundle change to its stable inventory ID.
3. Edit only `translations/corpus.yue.json`.
4. Run `node scripts/release-generate.mjs`.
5. Run `node scripts/validate.mjs`.
6. Review the corpus and generated-bundle diff; unrelated generated changes are failures.

Do not change the source inventory, provenance, scope, engine, or release version for same-baseline corrections.

## New VS Code baseline

1. Select an exact released Stable tag and full `microsoft/vscode` commit; never use `main` or Insiders unless explicitly requested.
2. Update every pin discovered by searching the repository: VS Code tag/commit, upstream Node version, archive endpoint/hash/size, external built-in versions/hashes, provenance, scope, release version, and engine constraint.
3. Acquire only allowlisted English source through `scripts/source-acquire.mjs`; reject localized `package.nls.<locale>.json` and any path containing `vscode-loc`, `zh-Hant`, `zh-TW`, or equivalents.
4. Regenerate a staged English inventory with `scripts/source-generate.mjs` before changing canonical files.
5. Diff by composite ID `(bundle, module, key)` and `sourceFingerprint`:
   - unchanged ID + fingerprint: carry the current target;
   - same ID + changed fingerprint/context: reopen and retranslate;
   - added ID: translate;
   - removed ID: remove;
   - possible move: use English/context similarity only as a review hint; never auto-approve it.
6. Translate all reopened/added units under the local skill. Do not expose termbase answers during the first pass; apply terminology and ambiguity review after every unit has a target.
7. Validate exact inventory/corpus coverage and protected content before replacing canonical source files.
8. Regenerate runtime bundles and run `node scripts/validate.mjs`.
9. Stop for human review. Do not claim approval or publish automatically.

## Validation and release

- Generation: `node scripts/release-generate.mjs`
- Generated-byte check: `node scripts/release-generate.mjs --check`
- Full structural/protected/release check: `node scripts/validate.mjs`
- Release-candidate check: `node scripts/release-validate.mjs`
- The upstream cache is optional for same-baseline corrections; when present, full validation also checks reproducible source generation.
- Package only after validation. Inspect and publish the exact tested VSIX; never rebuild between approval and publication.
- Publishing, version changes, Marketplace mutation, and GitHub pushes require an explicit user request.

## Repository rules

- Preserve unrelated user changes.
- Use `rg`/`rg --files` and always exclude `notes/`.
- Do not install tools or dependencies unless explicitly authorized.
- Do not add historical `.planning/` material back to Git.
- Keep documentation and collaboration mainly in English; use Cantonese where translation examples require it.
