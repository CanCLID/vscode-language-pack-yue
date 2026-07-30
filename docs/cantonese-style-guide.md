<!-- generated-by: gsd-doc-writer -->
# Cantonese localization style guide

This is the translator-facing guide for writing the English Visual Studio Code interface in natural vernacular Traditional Hong Kong Cantonese (`yue`). It covers language, meaning, tone, and UI phrasing. Examples are illustrative, not a phrasebook to copy without context.

During the first translation pass, work only from the English string, its supplied context and protected-content instructions, and this guide. Do not consult terminology verdicts, occurrence concordances, or QA findings. Those checks are deliberately applied after the complete first-pass corpus exists.

## Audience and locale

Write for Cantonese-speaking developers in Hong Kong. The result should sound as if the interface was written in Cantonese, not as if a Standard Written Chinese sentence had a few Hong Kong words substituted into it.

- Translate from the pinned English source only. Do not use another Chinese language pack as drafting material.
- Use Traditional Hong Kong characters and Hong Kong technical usage.
- Prefer forms that are normal in everyday Hong Kong speech when they are clear in the software context.
- Keep familiar English developer terms when translating them would sound forced, obscure the specialised sense, or conflict with established project terminology.
- Do not use Mainland or Taiwan terminology merely because it is common in Chinese-language software. For example, use `數碼` for the digital-technology sense, not `數位` or `數字`.

## Meaning ledger and concision

Translate the intended message, not the English word order. Before shortening or rearranging a string, identify its actor, action, object, scope, polarity, condition, state, safety implication, and consequence. Preserve every element that affects what the user understands or decides.

Cantonese often expresses the same message more directly than English. Reorder clauses, replace nominal phrases with verbs, or split an overloaded sentence when that improves comprehension. Do not remove a reason, condition, affected object, irreversible consequence, or distinction between states merely to make the target shorter.

Prefer cause–result or task–result order when it reads naturally:

| English | Avoid | Prefer |
|---|---|---|
| Failed to open this link because it is malformed: `{0}` | 由於格式不正確，因此無法開啟此連結：`{0}` | 呢條連結格式唔啱，所以開唔到：`{0}` |
| Sign in to GitHub Copilot to generate a commit message. | 請登入 GitHub Copilot 以產生訊息。 | 登入 GitHub Copilot 先可以產生 commit message。 |

The preferred versions change the syntax substantially but retain the failure, cause, object, protected content, condition, and result.

## Cantonese grammar

Use Cantonese grammar throughout the sentence, including around untranslated English terms.

### Negation and ability

- Use `唔` for ordinary negation: `唔顯示`, `唔符合`.
- Use `冇` for absence or non-occurrence: `搵唔到` or `冇結果`, according to meaning.
- Express failed ability directly with `…唔到`: `開唔到檔案`, `連線唔到伺服器`. Avoid using `無法` as a default wrapper.
- Translate *available* by sense and sentence structure, commonly as `用到`, `用得`, or `用得到`; do not impose one universal equivalent.

### Aspect and state

- Put `咗` after the verb for a completed action or changed state: `揀咗`, `更新咗`, `撞咗`.
- When English describes an action that has completed, use the Cantonese perfective verb + `咗` where that action reading applies. Do not default to the Standard Written Chinese frame `已` + verb.
- Use the idiomatic verb form rather than mechanically adding aspect: `裝咗`, not `安裝咗` or `已安裝`.
- Use `緊` for an action actually in progress: `取消緊`, `開緊`. Do not translate ongoing state with `正在…` or `…中`.
- Use `返` for restoration or repetition and `過` for experience only when the English meaning calls for them.
- Do not add aspect to timeless labels, commands, or settings merely to make them sound conversational.

### Questions, conditions, and reference

- Form confirmation questions naturally: `係咪真係要…？`, `要唔要…？`, or `使唔使…？`, depending on force and context. Avoid `是否…？`.
- Put conditions where Cantonese expects them: `如果…，就…` or `…嗰陣時…`.
- For prerequisite actions, `…先可以…` is often clearer than a literal purpose clause.
- Use `嘅` and natural classifiers in prose: `呢個檔案`, `呢條連結`, `啲設定`. Compact labels may omit them.
- Use sentence particles sparingly. Add one only when it expresses the intended question, assurance, urgency, or conversational tone; do not decorate every message.
- Give Cantonese imperatives a natural particle when the interaction needs one (for example, `再試吓`); do not mechanically append a particle to terse menu labels.

## Register and address

Use a direct, helpful, task-oriented voice.

- Omit the user in commands and labels. In prose, use `你` only when the actor would otherwise be unclear. Never use the formal written-Chinese `您`.
- Translate *please* according to the interaction, not word-for-word. `唔該` or `麻煩` may suit a genuine request; many commands and recovery instructions need no politeness marker.
- State failures as an action that could not be completed: `Save 唔到`, `開唔到檔案`. Avoid bureaucratic phrases such as `操作無法完成`.
- Do not add apologies, blame, urgency, certainty, or reassurance that the English does not contain.
- Prefer short everyday verbs where they are unambiguous: for example, `閂` for closing an ordinary window and `搵` for a find/search action. Preserve a specialised technical term when the everyday verb would collapse an important distinction.

English technical tokens can sit naturally inside Cantonese syntax: `reload 咗個檔案`, `開個 terminal`, `摺埋呢截`, `偷睇定義`. Capitalisation should follow the product or registry entry, not English sentence position.

### Current product wording

Use these exact forms when the named product sense applies:

- letter case → `大細階`;
- regular expression / regex → `正則表達式`;
- whole word → `成個字`;
- the product concept extension → `擴充功能`;
- `icon` stays English; and
- `Alt` and every other keyboard key name stay English.

Do not use `聊天`. Choose context-natural chat/對話 wording instead: the surrounding sentence may use English `chat`, Cantonese `對話`, or a natural verb phrase according to the actual UI sense.

These are contextual decisions, not blind search-and-replace instructions. First resolve the English sense and UI surface. Preserve the actor, action, object, scope, polarity, condition, state, safety implication, and consequence, as well as every protected span. Do not collapse distinct senses merely because they share an English spelling.

Treat the following as review prompts rather than unconditional bans: `上方`, `下方`, `非預期`, `正`, `正在`, `多個`, `未能`, and stiff `得／不得` constructions. Rewrite them contextually as concise vernacular Cantonese where the meaning allows. For ability, prefer direct forms such as `得到` and `唔到`; for location, name the actual relationship naturally. Prefer `呢度要有` over `預期有` or `預期係` when the message says that something is required at the current location.

## UI surface patterns and punctuation

Match the form to the UI surface rather than applying one sentence template everywhere.

- **Menus, buttons, and commands:** start with the action, keep them compact, and omit final punctuation. Preserve an ellipsis when it means that another step or dialog follows.
- **Settings names:** use a stable noun phrase. **Settings descriptions:** say what behaviour is controlled and retain its condition and scope.
- **Progress and status:** name the action or result and use aspect only when warranted: `取消緊……`, `取代咗 3 次`.
- **Errors:** identify the failed action and affected object first or immediately after the cause. Retain diagnostic details and recovery actions.
- **Warnings and confirmations:** name the affected object and preserve destructive or irreversible consequences explicitly.
- **Accessibility strings:** preserve the announced event, state, and object. Do not replace semantic information with visual-only wording.
- **Fragments:** keep the grammatical role expected by the host sentence. Do not turn every fragment into a standalone sentence.
- **Punctuation:** use full-width `，。？！：；` in Cantonese prose. Keep ASCII punctuation inside code, URLs, placeholders, commands, keybindings, and other protected content. Use the project’s established ellipsis form consistently for the relevant surface.

### Mnemonics and literal ampersands

For a localized menu label, place the accelerator at the end in parentheses and keep the accelerator key ASCII. For example:

| English menu label | Cantonese menu label |
|---|---|
| `&File` | `檔案(&F)` |
| `&Edit` | `編輯(&E)` |
| `&Search` | `搵(&S)` |

Retain the source key where practical so documentation and muscle memory still match. If keys collide within the same menu, choose another meaningful ASCII Latin character or digit and review the whole sibling menu together. Never attach an accelerator marker to a Chinese character. `Alt` and all other keyboard key names remain English.

An ampersand may instead be literal text or part of a source-format escape sequence. Determine its runtime role before translating it, preserve the required number of ampersands, and verify the rendered label. Do not infer a mnemonic solely from seeing `&` or `&&`, and do not move a literal ampersand into accelerator parentheses.

## Semantic symmetry

Related strings should be predictable at both word and sentence level when they express the same relationship.

- Keep true inverse commands parallel: `啟用／停用`, `顯示／隱藏`.
- Keep state families parallel: `已連線／未連線` should be recast consistently if the project uses a more natural aspect pattern.
- Use the same clause order for sibling settings, prompts, or diagnostics when their meanings and UI roles match.
- Do not force symmetry across different senses. *Remove*, *delete*, *uninstall*, and *discard* may all describe taking something away, but they have different objects and consequences.
- Naturalness and clarity outrank formal symmetry. Record a narrow exception when matching the family would make one string misleading or unnatural.

## Technical language and protected syntax

Resolve the English sense in context before choosing a target. An isolated English word may represent several unrelated UI concepts; never perform a global substitution merely because the spelling matches.

Choose the term that best fits the actual object and action. Prefer established Hong Kong usage, but do not force a formal translation when an untranslated developer term or an everyday Cantonese word is clearer. Keep terminology decisions provisional during the first pass: translate from context and do not interrupt drafting to normalise earlier strings.

Keep product names, commands, protocols, code, URLs, placeholders, keybindings, Markdown syntax, and locked fragments exactly as required by the supplied protected-content instructions. Familiar developer terms may intentionally remain English. Translate the surrounding grammar so the whole line still reads as Cantonese.

### First-pass batch contract

For an assigned first-pass batch, read only this guide and the assigned machine-readable manifest. Treat the manifest as the complete work assignment: use only its supplied English records and context, and write only the output path it declares. Do not inspect unrelated targets or broaden the assignment.

When the declared output starts empty, draft a non-empty target for every assigned record before refining any one translation. First complete the whole batch-wide draft, then validate its draft receipt as directed by the manifest. After the receipt passes, reread and refine every record using the full assigned English context. Refinement may improve English meaning, natural Cantonese, UI fit, and protected-content correctness within the batch; it must not turn into corpus-wide normalisation or revision of earlier batches.

Preserve every placeholder, mnemonic marker, Markdown construct, link, command, code fragment, product name, and other locked content identified by the supplied record. Structural validation may reject a missing or duplicate identity, stale fingerprint, blank target, or damaged protected content. It checks correctness without supplying wording answers and never rewrites a target.

Run only the validation commands declared by the manifest. Validate the complete draft before refinement and validate the final records before writing the one declared output. Do not create, modify, or write any other assignment file.

## Representative patterns

These examples illustrate reusable decisions. They are deliberately few and should not be treated as a complete terminology list.

| Intent | Avoid | Prefer | Pattern |
|---|---|---|---|
| Cannot open file `{0}`. | 無法開啟檔案 `{0}`。 | 開唔到檔案「`{0}`」。 | Direct failed action; preserve placeholder. |
| The file was modified by another program. Reload it? | 檔案已被另一個程式修改。是否重新載入？ | 呢個檔案畀另一個程式改過。要唔要 reload？ | Natural passive and question; retain familiar token. |
| Replaced 3 occurrences. | 已取代 3 個相符項目。 | 取代咗 3 次。 | Verb plus completed aspect. |
| Cancelling… | 正在取消…… | 取消緊…… | Ongoing aspect without `正在`. |
| Save changes before closing? | 是否要在關閉前儲存變更？ | 閂之前要唔要 save 低啲改動？ | Time condition first; natural question. |
| Hide disabled items | 使已停用項目不可見 | 隱藏停用項目 | Compact action label. |
| Expand / Collapse | 展開／摺合 | 展開／摺埋 | Natural paired disclosure actions. |
| Peek Definition | 快速查看定義 | 偷睇定義 | Concise editor action in its specific UI sense. |

## Review checklist

Review each string in context, then review related strings together.

- Does it preserve the intended action, object, condition, state, severity, and consequence?
- Does it sound like natural Hong Kong Cantonese when read aloud?
- Have Standard Written Chinese scaffolds such as `是否`, `無法`, `正在`, and `…中` been removed where Cantonese has a clearer form?
- Have contextual prompts such as `上方／下方`, `非預期`, `正／正在`, `多個`, `未能`, stiff `得／不得`, or `預期有／預期係` been reviewed without blind replacement?
- Are the required current forms `大細階`, `正則表達式`, `成個字`, English `icon`, English key names, and `擴充功能` used for their governed senses, with `聊天` absent?
- Is the UI surface appropriate: compact label, explanatory setting, diagnostic, confirmation, status, fragment, or accessibility announcement?
- Was every ambiguous term resolved by sense rather than spelling?
- Does each technical term fit the sense and object in this occurrence?
- Are sibling actions and states syntactically parallel where their meanings match?
- Are placeholders, code, product names, Markdown, URLs, keybindings, mnemonic behaviour, and literal ampersands intact?
- Has concision removed only redundancy, not meaning?
- Has a native Hong Kong Cantonese reviewer checked naturalness and a developer-domain reviewer checked technical meaning?
