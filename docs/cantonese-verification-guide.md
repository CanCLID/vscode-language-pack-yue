<!-- generated-by: gsd-doc-writer -->
# Cantonese translation verification guide

This is the verifier-facing companion to `docs/cantonese-style-guide.md`. It defines the black-box boundary between first-pass translation and terminology verification, and identifies the canonical inputs used only after the first-pass corpus is complete.

## Role boundary

The translator receives:

- the English source string and its inventory identity;
- the supplied English context and translator notes;
- protected-content instructions derived from the English source; and
- `docs/cantonese-style-guide.md`.

The translator does not receive terminology verdicts, rejected forms, banned alternatives, source-term occurrence concordances, or findings generated from completed targets. Drafting therefore tests whether the English context and language policy are sufficient to produce natural Cantonese without answer leakage.

The verifier receives everything above plus the completed Cantonese targets and the canonical verification inputs listed below. Verification may identify corrections, but it must not mutate targets automatically.

## Canonical verifier inputs

- `sources/inventory.en.json` — pinned English identities, source fingerprints, context, and protected-content records.
- `terminology/preference-overrides.json` — explicit project decisions that supersede conflicting candidates for their recorded senses.
- `terminology/termbase.json` — reviewed concepts, preferred and rejected forms, aliases, examples, and contextual guidance.
- `terminology/do-not-translate.json` — tokens that must remain unchanged in their governed scope.
- `terminology/semantic-families.json` — related actions and states that require consistency review.
- `terminology/contextual-ambiguities.json` — broad English forms whose senses must be resolved occurrence by occurrence.
- `terminology/source-term-index.json` — the read-only mapping from governed English terms to every source occurrence; this is verifier-only and must never be used to steer the first-pass translation.
- the complete target corpus — every pinned source identity with a non-empty Cantonese target and current source fingerprint.

Raw glossary extracts, comparative catalogs, and evidence-acquisition artifacts are bookkeeping and audit material. They are not normal translation or verification inputs because their reviewed outcomes have already been reconciled into the canonical files above.

## Pipeline

1. **Prepare work units.** Build translator work units from the pinned English inventory. Include identity, English source, context, translator notes, and protected-content instructions. Do not attach terminology matches or verifier findings.
2. **Complete the first pass.** Translate every work unit using only the translator-facing inputs. Structural validation may check identities, fingerprints, placeholders, locked syntax, and target presence, but must not reveal terminology answers or rewrite targets.
3. **Open the verification gate.** Terminology correction begins only when every pinned unit has a target. Before that gate, terminology tools may account for coverage but must not ask the translator to normalise ambiguous wording.
4. **Generate concordances.** Join `terminology/source-term-index.json` to the completed corpus. For each governed English term, deterministically collect every matching source occurrence with its context and target.
5. **Apply terminology authority.** Check each occurrence against `terminology/preference-overrides.json`, `terminology/termbase.json`, and `terminology/do-not-translate.json`. Apply a decision only to its recorded sense. Report mismatches as review findings; never perform global replacement.
6. **Resolve ambiguity.** For each record in `terminology/contextual-ambiguities.json`, identify the actual senses present in the completed corpus, assign every occurrence to one sense, and define exactly one allowed translation family per approved sense. Listed choices are non-exhaustive; banned alternatives remain scoped to the recorded sense.
7. **Review relationships and language.** Use `terminology/semantic-families.json` and `docs/cantonese-style-guide.md` to check syntactic symmetry, aspect, register, UI-surface fit, and naturalness. A technically consistent target can still fail native-Cantonese review.
8. **Correct and repeat.** Apply reviewed corrections to the canonical targets, regenerate concordances and findings, and repeat until every finding is resolved or has an exact-ID rationale.
9. **Approve the corpus.** Native Hong Kong Cantonese review and developer/domain review remain independent. Both must approve every in-scope unit against the current source fingerprint before the corpus is frozen.

## Verification rules

- Treat `terminology/preference-overrides.json` as the highest terminology decision layer when it conflicts with older candidate or adjudication material.
- Treat terminology as sense-specific. Matching English spelling alone is never enough to justify a correction.
- Enforce the current governed forms by sense: letter case → `大細階`, regex → `正則表達式`, whole word → `成個字`, and the product concept extension → `擴充功能`. Keep `icon`, `Alt`, and every keyboard key name in English. Reject `聊天` and require context-natural chat/對話 wording.
- Require mnemonic markers to bind an English ASCII Latin character (or a digit when justified), never a Chinese character. Validate literal ampersands separately from accelerators.
- For completed actions, require the natural Cantonese verb + `咗` reading where applicable instead of Standard Written Chinese `已` + verb. Check that imperatives carry a natural Cantonese particle when the interaction needs one.
- Review `上方`, `下方`, `非預期`, `正`, `正在`, `多個`, `未能`, and stiff `得／不得` constructions contextually. Prefer concise vernacular forms such as `得到` or `唔到`, and prefer `呢度要有` over `預期有` or `預期係` where that preserves the message.
- Keep contextual choices non-exhaustive. They guide the reviewer but do not cap the vocabulary before the actual corpus senses are known.
- Enforce scoped bans. For example, display or image *resolution* uses `解像度`, not `解析度`; problem resolution is a different sense. Software feature, compatibility, or service *support* uses `支援`, not `支持`; physical support may require another term.
- Preserve familiar English version-control actions and any other terms recorded as keep-English decisions.
- Verify all repeated occurrences one-for-one. One matching target token cannot satisfy several source occurrences.
- Keep findings advisory and stable-ID based. Target text changes may make a finding stale, but must not change its source identity.
- Do not consult raw evidence during routine verification. Escalate to evidence or new research only when the canonical authority is genuinely insufficient or contradictory.
- Never apply these checks as blind replacement instructions. Preserve actor, action, object, scope, polarity, condition, state, safety implication, consequence, and protected content; respect the sense boundaries defined by the canonical terminology decisions.

## Completion checklist

- Every pinned English identity has one current, non-empty target.
- Structural and protected-content validation passes without omissions or duplicate consumption.
- Every indexed terminology occurrence has exactly one verification outcome.
- Every contextual ambiguity occurrence has a reviewed sense assignment after corpus completion.
- Preferred, rejected, banned, and keep-English decisions are applied only in their governed senses.
- Semantic-family differences are either corrected or justified at exact source-ID scope.
- Every automated finding is resolved or waived with a specific rationale.
- Native Cantonese and developer/domain reviewers have independently approved every target.

## Ordered verifier commands

Run from the repository root after `freeze-first-pass` has produced a current receipt. Leaf agents use the separate, deliberately minimal assignment contract in `.planning/phases/04-complete-cantonese-translation-and-review/leaf-verifier-instructions.md`; do not copy verifier authority into translator instructions.

```text
node scripts/translation-work.mjs review-status
node scripts/translation-work.mjs review-run --stage structural-protected
node scripts/translation-work.mjs review-run --stage terminology-dnt
node scripts/translation-work.mjs review-run --stage contextual-ambiguity
node scripts/translation-work.mjs review-run --stage semantic-family
node scripts/translation-work.mjs review-run --stage cantonese-swc-english-identical
node scripts/translation-work.mjs review-partition --kind review --max-translations 200
node scripts/translation-work.mjs review-partition --kind correction --max-translations 200
```

The exact stage reported by `review-status` is the only legal next stage. Exit 0 means the requested operation and its bindings are valid; exit 1 means stale/invalid evidence or an open prerequisite; exit 2 means invalid command syntax. `--check` validates without writing reports, receipts, or partition manifests. Verifier commands may write only evidence under the Phase 4 `work/review` directory and never target text.

Each stage receipt binds the current corpus fingerprint, verifier policy, previous receipt, and report. A target correction invalidates that stage and every later receipt, so restart at the first stage reported stale and run the full regression sequence. The first-pass snapshot is never changed.

Findings remain advisory and use a stable finding ID separate from the mutable target fingerprint. Closing one requires its exact ID, current target fingerprint, one of `corrected`, `confirmed-correct`, `accepted-contextual-variant`, `deliberate-keep-English`, or `exact-ID-waiver`, and a specific rationale. Wildcards, pattern waivers, and global allowlists are invalid. English-identical targets are explicitly enumerated in the final linguistic stage.

For contextual ambiguity, review every worksheet occurrence, assign exactly one reviewed sense, and declare exactly one non-empty allowed translation family for each approved sense. Existing prompts are non-exhaustive: a new family is valid when the decision records a specific justification and current target attestation. Never key a sense rule only by the English spelling.

Review and correction partitions own disjoint exact finding IDs and one decision output each. Their workload is bounded and reported by affected translations, governed occurrences, risk classes, ambiguity/family breadth, and target length; file count is not a workload measure. Correction agents may change only their declared target identities and may not edit findings or another partition.

Authority becomes visible only after the current first-pass gate. Automated-agent review is provisional and does not claim human approval. Freeze for downstream generation only when all stages are current, every finding has a current exact-ID disposition, ambiguity assignments are exhaustive, and the independent native-Cantonese and developer/domain review gates are satisfied or explicitly recorded as deferred provisional work.
