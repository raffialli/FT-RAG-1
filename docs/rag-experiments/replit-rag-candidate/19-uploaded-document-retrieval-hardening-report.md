# Report 19 - Uploaded Document Retrieval Hardening

**Branch:** `codex/rag-retrieval-hardening`
**Base:** `candidate/client-test-ready` @ `dc4c700939f67f3177e62e3bf534b61f891f4520`
**Fix commit:** `2eb54ff1eb2e346270893df7f538771f59fb3acb`
**Version:** `v0.20.0`
**Date:** 2026-06-06

---

## Context

This lane audits and hardens the FalconTrust RAG Candidate app for reliable client uploaded-document Q&A. The known live failure is:

> What were the two main earthquakes discussed, including their magnitudes and locations?

The deployed runtime corpus contains the answer-bearing evidence in the uploaded JEM May-June 2025 document:

> Pazarcik Mw = 7.7 and Elbistan Mw = 7.6, Kahramanmaras-Turkiye earthquakes

Live v0.19.1 did not surface that title/abstract evidence for the broad question. It retrieved partial earthquake context, answered that magnitudes were not provided, and returned `low` confidence / `weak` evidence.

---

## Starting State

Local repo state before fixes:

- Branch: `candidate/client-test-ready`
- Commit: `dc4c700939f67f3177e62e3bf534b61f891f4520`
- Local worktree: clean
- Local corpus: 9 docs / 693 chunks / 693 vectors
- Live runtime, authenticated read-only QA: 10 docs / 836 chunks / 836 vectors
- Live provider/model: OpenAI / `gpt-4.1-mini`
- Embeddings: `Xenova/all-MiniLM-L6-v2`

The local checked-in corpus does not include the JEM May-June 2025 uploaded document, so the earthquake failure cannot be reproduced fully from the local corpus alone. The fix was therefore tested with deterministic synthetic retrieval fixtures and read-only live baseline checks.

---

## Proven Failures

1. **Live retrieval missed answer-bearing title/abstract evidence.**
   - The live query retrieved earthquake context but not the title/abstract chunk that includes both magnitudes and named locations.
   - The answer said magnitudes were not provided.

2. **Broad chunk search was too brittle.**
   - Live `/api/rag/chunks` searches for `earthquake magnitude location`, `earthquakes magnitudes locations`, and `two main earthquakes` returned zero chunks.
   - A targeted search for `7.7 earthquake` found the answer-bearing chunk, proving the corpus contained the needed text.

3. **Prompt context was prefix-biased.**
   - Before this lane, answer generation passed `text.substring(0, 1000)` for each retrieved chunk.
   - A long chunk could contain the answer later in the chunk while the model only saw the prefix.

4. **Diagnostics were too shallow for retrieval-layer debugging.**
   - The previous debug trace exposed only candidate counts and broad pipeline counters.
   - It did not expose rescue counts or top candidate score components/previews.

---

## Inferred Risks

1. **Uploaded-document title/abstract questions are fragile.**
   Title and abstract chunks often carry the concise answer for event-name, numeric, and location questions. Prefix-only prompt clipping and weak lexical matching can hide those answers.

2. **Non-ASCII and OCR-normalized names are fragile.**
   Queries and chunks can differ on `Pazarcik` / `Pazarcık`, `Kahramanmaras` / `Kahramanmaraş`, and similar OCR/diacritic variants.

3. **Numeric attribute questions need lexical rescue.**
   Small embedding models can miss exact decimal facts. BM25/exact rescue should preserve decimals and short scientific tokens such as `Mw`.

---

## Fixes Made

### 1. Search normalization and token expansion

**File:** `artifacts/api-server/src/lib/rag/bm25.ts`

Added `normalizeForSearch()` and stronger `tokenize()` behavior:

- normalizes diacritics and Turkish dotless/dotted `i`;
- preserves decimal tokens such as `7.7`;
- preserves important short tokens such as `Mw`;
- stems conservative plurals;
- expands `Mw` <-> `magnitude`;
- expands `earthquake(s)` <-> `quake`;
- expands `location(s)` to related location cues.

`bm25Search()` and `exactPhraseSearch()` now use normalized text instead of raw lowercase matching.

### 2. Wider hybrid candidate pools

**File:** `artifacts/api-server/src/lib/rag/retriever.ts`

Increased vector and BM25 candidate pools from 25 to 50 and retained up to 60 fused candidates before rerank/filtering. This gives lexical and rescue candidates room to survive the retrieval pipeline.

### 3. General attribute rescue

**File:** `artifacts/api-server/src/lib/rag/retriever.ts`

Added `attributeRescueSearch()` for questions asking for named events/items plus attributes such as magnitudes and locations. This is not earthquake-specific; it applies to event questions involving terms such as earthquake, flood, storm, hurricane, wildfire, or disaster when the query asks for names plus magnitude/location-style attributes.

### 4. Query-aware prompt context

**File:** `artifacts/api-server/src/lib/rag/prompt-context.ts`

Added a pure prompt-context module that selects the most query-relevant excerpt from each retrieved chunk instead of blindly passing the first 1000 characters.

The excerpt scorer favors:

- query token overlap;
- numeric and magnitude evidence;
- location-related evidence;
- title/abstract/introduction cues.

`answer-gen.ts` now calls `buildEvidenceBlock(query, topChunks)`.

### 5. Expanded retrieval diagnostics

**File:** `artifacts/api-server/src/lib/rag/retriever.ts`

`debugTrace` now includes:

- `exactRescueCandidates`
- `conceptRescueCandidates`
- `attributeRescueCandidates`
- compact `topCandidates` with rank, source, page range, section, score components, noise category, and text preview.

The API contract already treats `debugTrace` as a loose record, so this is backward-compatible with the current UI JSON rendering.

### 6. Version bump

**Files:**

- `artifacts/rag-candidate/src/version.ts`
- `docs/rag-experiments/replit-rag-candidate/versioning.md`

Bumped from `v0.19.1` to `v0.20.0` so a deployed patched build has a visible runtime/version signal.

---

## Tests Added

**File:** `artifacts/api-server/src/lib/rag/retrieval-hardening.test.mts`

Added deterministic tests for:

- diacritic normalization;
- plural stemming;
- `Mw` / magnitude expansion;
- decimal preservation;
- location expansion;
- BM25 ranking of answer-bearing numeric/title evidence;
- exact/entity rescue across diacritic/plural variants;
- prompt excerpting around an answer-bearing passage inside a long chunk.

The API test script now runs both the existing scoring/provenance suite and the new retrieval hardening suite.

---

## Validation Results

Commands run locally:

```bash
node --experimental-strip-types artifacts/api-server/src/lib/rag/answer-gen.test.mts
```

Result: 157 passed / 0 failed.

```bash
node --experimental-strip-types artifacts/api-server/src/lib/rag/retrieval-hardening.test.mts
```

Result: 10 passed / 0 failed.

```bash
node_modules/.bin/tsc.cmd --build
```

Result: passed.

```bash
node artifacts/api-server/build.mjs
```

Result: passed.

Dependency note: the Windows workspace initially had an incomplete `node_modules/zod` layout after a pnpm/Corepack failure. Running frozen install through the bundled Codex Node runtime repaired dependencies enough for typecheck and API bundling to pass. The final pnpm install lifecycle still fails on Windows because the root preinstall uses `sh`; Linux server validation should use the normal pnpm workflow.

---

## Live Before/After

### Before / current deployed v0.19.1

Authenticated live QA at `2026-06-06T17:04:49.111Z`:

- Corpus: 10 docs / 836 chunks / 836 vectors.
- Answer: identifies broad Turkey/Syria/Kahramanmaras/Hatay context but says exact magnitudes are not provided.
- Confidence: `low`.
- Evidence sufficiency: `weak`.
- Broad chunk searches:
  - `earthquake magnitude location`: 0
  - `earthquakes magnitudes locations`: 0
  - `two main earthquakes`: 0

### After

Not deployed yet. Local deterministic tests prove the code path now ranks the answer-bearing magnitude/location chunk first lexically and clips prompt evidence around the `Pazarcik Mw = 7.7 and Elbistan Mw = 7.6` passage.

The patched live after-result must be collected after deploying commit `2eb54ff1eb2e346270893df7f538771f59fb3acb` or applying the exported patch.

---

## Portable Patch Handoff

An exact `git format-patch` handoff was exported outside the repo:

```text
E:\Code\CP_projects\overlay_tools\falcontrust_rag_retrieval_hardening_patch\0001-Harden-RAG-retrieval-for-uploaded-document-QA.patch
```

The handoff README is:

```text
E:\Code\CP_projects\overlay_tools\falcontrust_rag_retrieval_hardening_patch\README.md
```

This allows applying the verified commit to `/opt/falcontrust-replit-audit` without pushing to GitHub.

---

## Files Changed

| File | Purpose |
|---|---|
| `artifacts/api-server/package.json` | Run retrieval hardening tests with API test script |
| `artifacts/api-server/src/lib/rag/answer-gen.ts` | Use query-aware evidence block |
| `artifacts/api-server/src/lib/rag/bm25.ts` | Normalize and expand lexical retrieval tokens |
| `artifacts/api-server/src/lib/rag/prompt-context.ts` | Select query-relevant prompt excerpts |
| `artifacts/api-server/src/lib/rag/retriever.ts` | Wider pools, attribute rescue, richer diagnostics |
| `artifacts/api-server/src/lib/rag/retrieval-hardening.test.mts` | New deterministic retrieval/prompt tests |
| `artifacts/rag-candidate/src/version.ts` | Version bump to `v0.20.0` |
| `docs/rag-experiments/replit-rag-candidate/versioning.md` | Version history update |
| `docs/rag-experiments/replit-rag-candidate/19-uploaded-document-retrieval-hardening-report.md` | This report |

---

## Remaining Risks

1. **No deployed after-result yet.**
   The live runtime is still v0.19.1 and still fails the earthquake regression. Deployment or patch application is required before final readiness can be claimed.

2. **Curated-question regression not rerun on patched live runtime.**
   Existing deterministic tests pass, but the post-deploy curated/live gate must be rerun after deploying v0.20.0.

3. **Local corpus lacks the 10th uploaded document.**
   The checked-in corpus is 9 docs / 693 vectors, while the live runtime is 10 docs / 836 vectors. The fix intentionally avoids destructive corpus operations and must be validated against the preserved runtime corpus.

4. **GitHub push was not authorized.**
   A branch push attempt was blocked by policy because publishing code to the remote was not explicitly approved. The patch artifact is available for manual deployment.

---

## Recommendation

**Not ready for renewed client testing yet.**

The code hardening is implemented, committed, and locally verified. The app should only be considered ready after:

1. Apply or deploy commit `2eb54ff1eb2e346270893df7f538771f59fb3acb` to the server runtime.
2. Confirm the UI/API reports `v0.20.0`.
3. Rerun the earthquake regression and confirm retrieval includes the answer-bearing title/abstract chunk before generation.
4. Confirm the final answer includes Pazarcik Mw = 7.7 and Elbistan Mw = 7.6 with supporting citations.
5. Rerun curated/live regression gates with the preserved 10-doc runtime corpus.

Only after those checks pass should the app be returned to open-ended client uploaded-document testing.
