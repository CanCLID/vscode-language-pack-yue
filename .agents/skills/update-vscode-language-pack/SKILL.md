---
name: update-vscode-language-pack
description: Add, correct, review, or migrate Cantonese VS Code translations, including user-edited worktrees and updates to a newer pinned VS Code release. Regenerates and validates the pack, then stops for human review.
---

# Maintain or update the language pack

Read `AGENTS.md` and `docs/cantonese-style-guide.md` first. Use `docs/cantonese-verification-guide.md` for terminology and final review. Never use another Chinese VS Code pack as translation input. Do not publish unless explicitly requested.

## Choose the mode

Inspect `git status`, the relevant diff, and the current source pin before acting.

| Situation | Action |
|---|---|
| No edits; user reports or requests translations | Locate exact IDs from the English inventory; translate/correct them. |
| User already edited `translations/corpus.yue.json` | Treat edits as proposed human targets; preserve them, validate them, and ask only if intent is materially ambiguous. |
| User edited generated `extension/translations/**` only | Do not discard the edit. Map it to the inventory ID, reproduce the intended target in the canonical corpus, then regenerate. |
| Corpus and generated files both changed | Compare them. The corpus wins only when it clearly represents the user's intended edit; otherwise ask one focused question before overwriting either version. |
| User requests a newer VS Code baseline | Run the baseline-update workflow below. |

Ask the user before proceeding only when the requested identity/sense cannot be resolved safely, two user-authored versions conflict, or a choice changes public versioning/publishing. Do not ask for routine regeneration or validation.

## Shared target workflow

1. Read target records from `sources/inventory.en.json`; use their exact `id`, English `source`, `context`, `protected`, and `sourceFingerprint`.
2. Write only `translations/corpus.yue.json`. Preserve its canonical inventory order, record shape, IDs, and fingerprints.
3. For an explicit correction, consult the style guide and active terminology files before editing. For a large fresh delta, keep first-pass translators blind to terminology answers; expose only English/context/protected spans and the style guide, then apply terminology verification after coverage is complete.
4. Validate meaning, natural Cantonese, UI role, protected content, and sibling consistency. Never apply termbase entries as blind substitutions.
5. Run `node scripts/release-generate.mjs`, then `node scripts/validate.mjs`.
6. Review `git diff -- translations/corpus.yue.json extension/`. Every generated change must trace to an intended canonical target or an explicitly updated baseline/manifest.
7. Give the human reviewer the changed IDs, English source, old target, new target, and any non-obvious terminology decision. Stop for review unless the user already supplied and approved the exact final wording.

## Translation delegation

Use no parallel translation agents for a small, coherent change. Work inline for roughly 1–25 units; use one leaf agent when independent translation adds value. For 26–200 units, use at most 2 parallel leaves. For more than 200 units, partition into about 100–200 units per leaf, limited by available slots. Adjust downward when strings are long, risky, or context-heavy.

Partition by UI surface/module and keep obvious semantic or terminology families in one owner's packet. IDs must be exclusive across translator packets. A message may appear in a later consistency packet, but two translators must never own the same target. Subagents write only their declared machine-readable output; they never edit the corpus, policy files, generated bundles, or each other's outputs.

Use a minimal leaf prompt:

```text
Read .agents/skills/update-vscode-language-pack/SKILL.md, section "Leaf translator contract", and <packet-path>. Translate every record and write only <output-path>. Do not edit repository files.
```

If a fresh spawn returns `Unsupported content type`, respawn with the identical prompt. If it interrupts an existing leaf, send `Continue`. Retry at most three consecutive times at that point; a substantive response resets the count. If no subagent can be spawned, first wait for active work and close/reuse stale leaves. If capacity is not the cause, stop instead of silently translating a required delegated batch inline.

After translator outputs arrive:

1. Reject unknown, duplicate, missing, reordered, or stale IDs/fingerprints.
2. Validate protected content before merge.
3. Merge deterministically in inventory order.
4. Run one delta-wide terminology/ambiguity/semantic-family review. For a large delta, delegate by exclusive terminology family, not arbitrary files; overlapping messages may be reviewed in multiple families, but only the coordinator applies final edits.
5. Run one natural-Cantonese and technical review over every changed target. Automated review remains provisional.

## Leaf translator contract

- Input: one JSON packet containing packet ID and ordered records with exactly the stable ID, source fingerprint, English source, context, protected spans, and optional previous target.
- Source: translate only the supplied English. Read `docs/cantonese-style-guide.md`. Do not inspect existing targets outside the packet, terminology verdicts, raw glossary evidence, QA findings, or any Chinese VS Code pack.
- Process: draft a nonblank target for every packet record before refining any target; then reread and refine every record for meaning, vernacular Cantonese, UI fit, and protected syntax.
- Language: natural vernacular Traditional Hong Kong Cantonese; concise rephrasing is preferred when meaning is preserved. Keep normal Hong Kong developer terms in English when that is clearer.
- Integrity: preserve every placeholder, mnemonic role, Markdown construct, link, command URI, code fragment, keybinding, product name, locked span, ID, and source fingerprint.
- Output: one JSON object with `packetId` and ordered `records`; each record contains exactly `id`, `sourceFingerprint`, and nonblank `target`. Report ambiguity separately to the coordinator; do not omit the record or edit repository files.

## Baseline-update workflow

1. Resolve an exact released Stable VS Code tag, commit, and upstream Node pin from official sources. Record external built-in versions and verified hashes. Never use a floating branch.
2. Search the repository for every old tag, commit, Node pin, external version/hash, archive URL/size, engine constraint, and release-version reference. Update the complete pin set; do not assume one configuration file owns it all.
3. Acquire English-only source into an ignored cache with `scripts/source-acquire.mjs`; regenerate inventory/provenance/scope into a disposable staging root with `scripts/source-generate.mjs`.
4. Compare old and staged units by stable composite ID and source fingerprint. Produce machine-readable `unchanged`, `changed`, `added`, `removed`, and `possibleMove` lists. Similar English text is only a move hint.
5. Build a staged corpus: carry only unchanged targets; reopen changed units; add blank work records for additions; drop removals. Never carry a target across a changed fingerprint without translation/review.
6. Translate every changed and added unit through the delegation rules above. Resolve leaf ambiguity flags from English context and focused authoritative research without adding an intermediate human gate.
7. Run post-coverage verification using `preference-overrides.json`, `termbase.json`, `do-not-translate.json`, `contextual-ambiguities.json`, and `semantic-families.json`. Resolve by sense; record non-obvious exceptions in the appropriate policy file only when they generalize beyond one string.
8. Validate the staged inventory/corpus before replacing canonical files. Then replace inventory, provenance, scope, and corpus together; update `release/candidate.json` and generated compatibility metadata.
9. Regenerate and run all validation commands in `AGENTS.md`. Produce a concise review table of counts plus every changed/added ID and old/new target where applicable.
10. Stop for human review. Apply review corrections through the shared target workflow. Do not claim human approval, package, publish, push, or delete the prior baseline without explicit authorization.
