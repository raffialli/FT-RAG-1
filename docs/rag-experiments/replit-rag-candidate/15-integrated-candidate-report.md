# Report 15 — Integrated Replit RAG Candidate

**Branch:** `experiment/replit-rag-candidate-integrated`  
**Date:** 2026-06-02  
**Base branch:** `experiment/replit-confidence-citation-validation-fixes`  
**Base commit:** `c9532b1861f2055d63b59bcd951c4ca7163816dc`

---

## Overview

This branch represents the first clean integrated candidate build of the FalconTrust Replit RAG pipeline. It combines all five verified improvement lanes audited by Codex into a single branch suitable for end-to-end Codex review and potential VM/client-test deployment.

**Source lanes integrated (in application order):**

| Lane | Branch | Status |
|------|---------|--------|
| OCR cleanup | `experiment/replit-ocr-cleanup-lane` | ✓ Integrated |
| Section/chunk quality | `experiment/replit-section-chunk-quality-lane` | ✓ Integrated |
| Reference/noise filtering | `experiment/replit-reference-noise-filtering-lane` | ✓ Integrated |
| Confidence/citation validation | `experiment/replit-confidence-citation-validation-lane` | ✓ Integrated |
| Confidence/citation fixes (Codex audit response) | `experiment/replit-confidence-citation-validation-fixes` | ✓ Integrated (base commit) |

---

## Files in This Branch

All lane improvements are present on main. The integrated branch is HEAD of main.

### RAG pipeline files (`artifacts/api-server/src/lib/rag/`)

| File | Lane | Purpose |
|------|------|---------|
| `ocr-cleaner.ts` | OCR cleanup | Journal header removal, broken hyphenation repair, mid-line heading splits, known OCR substitution repair |
| `ocr-detector.ts` | OCR cleanup | Before/after cleanup comparison, per-document artifact reporting |
| `chunker.ts` | Section/chunk quality | Line-start + mid-line heading detection, `sectionPath` metadata on every chunk |
| `chunk-classifier.ts` | Reference/noise filtering | `noiseScore`/`noiseCategory` per chunk; hard exclusion threshold; reference-query bypass |
| `retriever.ts` | Reference/noise filtering | Applies noise hard-exclusion on normal queries; allows reference chunks on explicit bibliography queries |
| `scoring.ts` | Confidence/citation fixes | Pure scoring functions (zero external deps): `parseCitationNumbers`, `validateCitations`, `assessEvidenceSufficiency`, `assessConfidence`, `capConfidence`, `maxConfidenceForSufficiency` |
| `answer-gen.ts` | Confidence/citation fixes | Imports all scoring from `scoring.ts`; builds grounded prompts; returns structured result with `evidenceSufficiency`, `citationValidation`, `confidence` |
| `answer-gen.test.mts` | Confidence/citation fixes | 65 deterministic regression tests; no LLM calls |
| `ingester.ts` | OCR cleanup | Saves raw extracted text before cleanup; applies `cleanOcrText` before chunking |
| `embeddings.ts` | Foundation | Local ONNX embeddings (all-MiniLM-L6-v2); Ollama Cloud chat generation |
| `bm25.ts` | Foundation | BM25 lexical search |
| `vector-store.ts` | Foundation | Flat JSON cosine similarity store |
| `reports.ts` | Foundation | Query report persistence |
| `types.ts` | Foundation | Shared types including `noiseScore`, `noiseCategory`, `evidenceSufficiency`, `citationValidation` |

---

## Lane-by-Lane Verification Checklist

### OCR Cleanup Lane ✓

- [x] Raw extracted text saved before cleanup (`DATA_DIR/raw-documents/`)
- [x] `cleanOcrText()` called in `ingester.ts` before `chunkDocument()`
- [x] Chunks and embeddings use cleaned text only
- [x] Journal headers removed (`removed-journal-headers` flag)
- [x] Layout annotations removed (`removed-layout-annotations` flag)
- [x] Logo/ad artifacts removed (`removed-logo-artifacts`, `removed-ads` flags)
- [x] Broken hyphenation repaired (`fixed-hyphenation` flag)
- [x] Mid-line heading splitting (`split-midline-headings` flag)
- [x] Known OCR substitutions repaired (`repaired-ocr-substitutions` flag)
- [x] Frontmatter removed (`removed-frontmatter` flag)

**Evidence from live documents API:** All 9 ingested docs report cleaning flags. Example:
```
JEM_2024_Special_Issue: fixed-hyphenation, removed-layout-annotations, removed-logo-artifacts,
  removed-journal-headers, removed-frontmatter, removed-ads, split-midline-headings
Flood_Risk_Management-OCR: fixed-hyphenation, repaired-ocr-substitutions, removed-frontmatter,
  split-midline-headings
```

### Section/Chunk Quality Lane ✓

- [x] Line-start heading detection in `chunker.ts` (`detectSectionHeading`)
- [x] Mid-line heading splitting applied before embedding
- [x] `sectionPath` metadata on chunks used by `assessEvidenceSufficiency` (HQ section bonus)
- [x] Reference/noise suppression from chunking (via `chunk-classifier.ts` — applied at retrieval)

### Reference/Noise Filtering Lane ✓

- [x] `chunk-classifier.ts` classifies: `reference-list`, `bibliography`, `ad-subscription`, `editorial-frontmatter`, `toc`, `citation-heavy`, `useful-content`
- [x] `noiseScore` (0–1) and `noiseCategory` present on all `RetrievedChunk` objects
- [x] `NOISE_HARD_EXCLUSION_THRESHOLD = 0.72` — chunks above this excluded from normal queries
- [x] `isReferenceQuery()` bypass — explicit bibliography/reference queries allow noisy chunks
- [x] Reranking penalties applied per category (`NOISE_RERANK_PENALTY`)
- [x] **Live verification:** All 50 top-5 evidence chunks across 10 benchmark queries returned `noiseCategory=useful-content`, `noiseScore=0.0`. Zero noisy chunks in any answer evidence.

### Confidence/Citation Validation Lane ✓

- [x] `evidenceSufficiency` (`sufficient`/`partial`/`weak`/`insufficient`) in every query result
- [x] `citationValidation` (`citedNumbers`, `validCitations`, `invalidCitations`, `noisyCitedChunks`, `allValid`, `warnings`) in every query result
- [x] `parseCitationNumbers` handles `[1,2]`, `[1, 2]`, `[1,2,3]`, `[1] [2]`, deduplication, sorted output
- [x] `confidence=high` requires `evidenceSufficiency=sufficient` (cap enforced)
- [x] `confidence=medium` max for `partial` sufficiency
- [x] `confidence=low` max for `weak` or `insufficient` sufficiency

### Confidence/Citation Fixes Lane ✓ (Codex audit response)

- [x] Fix 1: Comma citation parsing — `[1,2]` and `[1, 2]` correctly parsed
- [x] Fix 2: Sufficiency→confidence cap — `capConfidence()` + `maxConfidenceForSufficiency()` enforced at end of `assessConfidence()`
- [x] Fix 3: 65 deterministic regression tests in `answer-gen.test.mts`, all passing
- [x] `scoring.ts` has zero external imports (safe for test environments)

---

## Commands Run and Results

```bash
# Static checks
pnpm install --frozen-lockfile                                    → PASS (lockfile intact)
pnpm --filter @workspace/api-server run typecheck                → PASS (0 errors)
pnpm --filter @workspace/rag-candidate run typecheck             → PASS (0 errors)
pnpm --filter @workspace/api-server run test                     → PASS (65/65)
pnpm --filter @workspace/api-server run build                    → PASS (dist/index.mjs 1.9MB)
PORT=4173 BASE_PATH=/ pnpm --filter @workspace/rag-candidate run build  → PASS (391KB JS bundle)
```

### Build output

```
API server:   dist/index.mjs 1.9mb ⚡ Done in 1566ms
Frontend:     dist/public/assets/index-*.js 391.21KB │ gzip: 121.57KB  ✓ built in 12.41s
```

---

## 10-Question Benchmark Results (Live LLM Run)

**Date:** 2026-06-02  
**Model:** qwen3.5 (Ollama Cloud)  
**Corpus:** 9 documents, 693 chunks, 10 queries  

| # | Query | Conf | Suf | Cited | AllValid | Noisy chunks | Grounded |
|---|-------|------|-----|-------|----------|--------------|----------|
| Q1 | Small town resilience | **medium** | partial | [1,2,4,5] | ✓ | 0/5 | ✓ |
| Q2 | Japan flood warning | low | insufficient | [1,2,3,4,5] | ✓ | 0/5 | hedged |
| Q3 | South Sudan strategies | low | insufficient | [1,2,3,5] | ✓ | 0/5 | hedged |
| Q4 | Community resilience EM | **high** | sufficient | [1,3,4] | ✓ | 0/5 | ✓ |
| Q5 | Flood vulnerability | **medium** | partial | [2,3,4] | ✓ | 0/5 | ✓ |
| Q6 | EWS fatality rates | low | insufficient | [1,2,3,4] | ✓ | 0/5 | hedged |
| Q7 | Climate change FRM | **medium** | partial | [1,2,3,4,5] | ✓ | 0/5 | ✓ |
| Q8 | Flood risk comms | low | insufficient | [1,2,3,5] | ✓ | 0/5 | hedged |
| Q9 | Resilience methods | low | insufficient | [1,2,4] | ✓ | 0/5 | hedged |
| Q10 | Social risk | **medium** | partial | [1,2,3,4,5] | ✓ | 0/5 | ✓ |

**Summary:** 1 high, 4 medium, 5 low  
**Noisy chunks in evidence:** 0 across all 50 top-5 slots  
**Citation allValid:** 10/10  
**Overstated confidence (high with non-sufficient evidence):** 0

### Policy compliance

| Check | Result |
|-------|--------|
| `high` confidence never returned with `partial`/`insufficient` evidence | ✓ PASS |
| No noisy/reference/ad chunks in top evidence | ✓ PASS |
| Reference chunks allowed on reference queries | ✓ (not tested live; unit-tested in scoring.ts) |
| Q3 (South Sudan) confidence ≠ high | ✓ low |
| Q6 (EWS fatalities) confidence ≠ high | ✓ low |
| Q7 (Climate change FRM) confidence ≠ high | ✓ medium (partial, single-source) |
| Q9 (Resilience methods) confidence ≠ high | ✓ low (insufficient) |
| Q10 (Social risk) confidence ≠ high | ✓ medium (partial) |

### Comparison to Report 13 baseline

| Query | R13 conf | R14 predicted | R15 actual | Change |
|-------|----------|--------------|------------|--------|
| Q1 Small town resilience | high | medium (capped) | **medium** | ↓ ✓ |
| Q2 Japan flood warning | low | low | low | — ✓ |
| Q3 South Sudan | low | low | low | — ✓ |
| Q4 Community resilience EM | high | medium (capped) | **high** | ↑ note 1 |
| Q5 Flood vulnerability | high | medium (capped) | **medium** | ↓ ✓ |
| Q6 EWS fatalities | low | low | low | — ✓ |
| Q7 Climate change FRM | low | low | **medium** | ↑ note 2 |
| Q8 Flood risk comms | high | medium (capped) | **low** | ↓↓ note 3 |
| Q9 Resilience methods | high | medium (capped) | **low** | ↓↓ note 3 |
| Q10 Social risk | medium | medium | medium | — ✓ |

**Note 1 — Q4:** R14 predicted medium (capped), but live result shows `sufficiency=sufficient` (multi-source: JEM Special Issue + JEM_V3N2 + Flood Risk Management book) — three distinct sources qualify as `sufficient`, so `high` is correctly allowed. The R14 prediction assumed single-source retrieval; actual retrieval found stronger evidence.

**Note 2 — Q7:** R13 returned `low` (severely hedged). This run returned `medium` (partial, single-source) — the LLM found relevant climate/adaptation policy content rather than hedging. Single-source warning present; `medium` is the correct capped result.

**Note 3 — Q8/Q9:** Stronger hedging from the LLM this run drove both down to `low` (`insufficient` sufficiency due to severe hedge). This is correct policy behaviour — the hedging detector caught that the LLM itself flagged insufficient corpus coverage.

---

## Corpus State

```
Documents: 9
Total chunks: 693
  Flood_Risk_Management-OCR: 319 chunks
  JEM_2024_Special_Issue:     227 chunks
  JEM-12-1-04-Kohn:            35 chunks
  JEM_20-8-08-Wood:            38 chunks
  JEM_21-1-04-Huang:           24 chunks
  JEM_V3N2_3:                   9 chunks
  JEM_V3N3_3:                   6 chunks
  JEM_V6N5_9:                  19 chunks
  JEMv9n1_7:                   16 chunks
```

All documents cleaned (cleaning flags present on all 9).

---

## Known Remaining Gaps

1. **LLM non-determinism**: Confidence for borderline queries (Q7, Q8, Q9) can vary across runs as the LLM may hedge differently. The deterministic tests verify policy direction, not exact level. Multi-sample voting would stabilise this but is out of scope for this candidate.

2. **Section extraction completeness**: Some chunks have `sectionPath=null` (e.g., Q10 chunks from the Flood Risk Management book), preventing the HQ-section bonus in `assessEvidenceSufficiency`. Improved section heading detection would increase `sufficient` verdicts where evidence is strong.

3. **No live re-benchmark for reference-query bypass**: The `isReferenceQuery()` bypass is unit-tested in `scoring.ts` but not exercised in this benchmark. A dedicated bibliography query should be added to the standard benchmark suite.

4. **`sectionPath` relies on chunker label accuracy**: The HQ-section set in `scoring.ts` uses exact string matching. Imprecise heading detection silently lowers sufficiency scores for well-evidenced queries.

5. **Corpus coverage**: The corpus does not contain Japan-specific flood warning system performance data (Q2 correctly returns low), South Sudan adaptation strategies (Q3 correctly low), or quantitative EWS fatality statistics (Q6 correctly low). These are corpus gaps, not pipeline bugs.

6. **Single-source concentration**: Q1, Q7, Q8, Q10 retrieve all top-5 chunks from a single document. The single-source warning is emitted and confidence is capped, but diversifying the retrieval algorithm (e.g., MMR-style source diversification) would improve result quality.

---

## Integration Report: Lane Reports Preserved

The individual lane reports remain on disk and their branches on GitHub:

| Report | File |
|--------|------|
| Report 9 — Verification | `docs/rag-experiments/replit-rag-candidate/09-verification-report.md` |
| Report 10 — OCR cleanup | `docs/rag-experiments/replit-rag-candidate/10-ocr-cleanup-improvement-report.md` |
| Report 11 — Section/chunk quality | `docs/rag-experiments/replit-rag-candidate/11-section-chunk-quality-report.md` |
| Report 12 — Reference/noise filtering | `docs/rag-experiments/replit-rag-candidate/12-reference-noise-filtering-report.md` |
| Report 13 — Confidence/citation validation | `docs/rag-experiments/replit-rag-candidate/13-confidence-citation-validation-report.md` |
| Report 14 — Confidence/citation fixes | `docs/rag-experiments/replit-rag-candidate/14-confidence-citation-fixes-report.md` |

---

## Codex Audit Checklist

What Codex should verify end-to-end:

1. **OCR cleanup**: `cleanOcrText()` in `ingester.ts` runs before `chunkDocument()`. Raw text saved to `raw-documents/`. Cleaning flags in document metadata.
2. **Noise filtering**: `classifyChunkNoise()` called in `retriever.ts`. `noiseScore >= 0.72` chunks excluded from normal queries. `isReferenceQuery()` bypass tested.
3. **Confidence cap**: `capConfidence(tentative, maxConfidenceForSufficiency(sufficiency))` called at end of `assessConfidence()`. No path can return `high` when `sufficiency=partial`.
4. **Comma citations**: `parseCitationNumbers` regex `/\[(\d+(?:\s*,\s*\d+)*)\]/g` — handles `[1,2]`, `[1, 2]`, `[1,2,3]`.
5. **Test suite**: `pnpm --filter @workspace/api-server run test` → 65/65 pass, zero LLM calls, under 1 second.
6. **Integration**: No duplicate scoring logic between `answer-gen.ts` and `scoring.ts`. All scoring imported from `scoring.ts`.
7. **pnpm reproducibility**: `pnpm install --frozen-lockfile` passes without modification.

---

## Codex Integrated Audit Blocker Fixes

**Date applied:** 2026-06-02  
**Commit message:** `Fix integrated candidate reproducibility and embedding metadata`

### Fix 1 — `allowBuilds` (pnpm-workspace.yaml)

**Applied: YES**

Codex found that `pnpm install` succeeds only when `protobufjs` and `sharp` are present in `onlyBuiltDependencies`. These were missing from the committed file.

**Exact change to `pnpm-workspace.yaml`:**

```yaml
# Before
onlyBuiltDependencies:
  - '@swc/core'
  - esbuild
  - msw
  - onnxruntime-node
  - unrs-resolver

# After
onlyBuiltDependencies:
  - '@swc/core'
  - esbuild
  - msw
  - onnxruntime-node
  - protobufjs
  - sharp
  - unrs-resolver
```

No dependency versions changed. Lockfile untouched (`pnpm install --frozen-lockfile` → PASS).

### Fix 2 — Embedding metadata mismatch

**Applied: YES**

**Actual embedding model used: `Xenova/all-MiniLM-L6-v2`** (local ONNX, 384-dim, ~23 MB q8 via `@huggingface/transformers`)

**Root cause:** `artifacts/api-server/src/lib/rag/vector-store.ts` line 14 had the wrong fallback default:

```typescript
// Before (wrong — leftover from early prototype)
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text:latest";

// After (correct — matches embeddings.ts)
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
```

**Where embedding metadata is written:** `vector-store.ts` `addOrUpdateRecords()` writes `embeddingModel` to the top-level field of `candidate-rag/data/vectors/index.json` on every ingest run.

**Where it is read:** `vector-store.ts` `loadVectorIndex()` reads `index.json` at startup. The `embeddingModel` field is informational metadata — it does not affect runtime search (cosine similarity is model-agnostic given correctly shaped vectors). Correctness matters for reproducibility documentation and Codex audit.

**Stored index state:** `candidate-rag/data/vectors/index.json` → `"embeddingModel": "Xenova/all-MiniLM-L6-v2"` (confirmed correct after fix).

**Nomic was never used in this candidate.** The codebase uses `@huggingface/transformers` for local ONNX inference only. An earlier `vector-store.ts` default was a stale prototype artifact predating the switch to local embeddings.

### Fix 3 — Ollama env vars for live generation benchmark

**Required environment variables:**

| Variable | Value | Where set |
|----------|-------|-----------|
| `OLLAMA_API_KEY` | (secret — in Replit Secrets) | Replit Secrets panel |
| `OLLAMA_BASE_URL` | `https://ollama.com` | Replit Secrets panel |
| `GENERATION_MODEL` | `qwen3.5:397b` | Replit Secrets panel or shell export |
| `EMBEDDING_MODEL` | *(optional — defaults to `Xenova/all-MiniLM-L6-v2`)* | Not required unless overriding |

**To rerun the 10-query live generation benchmark:**

```bash
# 1. Start the API server (workflow handles env injection automatically)
#    OR export vars manually for standalone runs:
export OLLAMA_BASE_URL=https://ollama.com
export OLLAMA_API_KEY=<from secrets>
export GENERATION_MODEL=qwen3.5:397b

# 2. Verify connectivity
curl -s http://localhost:80/api/rag/models | python3 -m json.tool

# 3. Run all 10 benchmark queries (topK=5)
for q in \
  "What strategies do small towns use to build flood resilience?" \
  "How did Japan flood warning systems perform during recent flood events?" \
  "What flood adaptation strategies are used in South Sudan?" \
  "How does community engagement improve emergency management outcomes?" \
  "What factors determine flood vulnerability in urban areas?" \
  "What quantitative evidence exists on early warning system fatality reduction rates?" \
  "How do climate change policies affect flood risk management mechanisms?" \
  "How is flood risk communicated to the public?" \
  "What methods are used to assess community resilience to floods?" \
  "How is social risk constructed in flood risk management?" ; do
  curl -s -X POST http://localhost:80/api/rag/query \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"$q\",\"topK\":5}" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('confidence'), d.get('evidenceSufficiency'), d.get('citationValidation',{}).get('allValid'))"
done
```

**Expected output** (integrated candidate baseline, Report 15):
```
medium partial True
low insufficient True
low insufficient True
high sufficient True
medium partial True
low insufficient True
medium partial True
low insufficient True
low insufficient True
medium partial True
```

**Notes:**
- Generation uses `/api/chat` (not `/api/embed` — Ollama Cloud does not expose `/api/embed`).
- Embedding runs locally (ONNX, no Ollama call needed for embeddings).
- If `GENERATION_MODEL` env var is unset, `embeddings.ts` defaults to `qwen3.5:397b`.
- Timeout per query: 180 s (configurable via `generateAnswer(prompt, timeoutMs)`).

### Verification commands run (post-fix)

```bash
pnpm install --frozen-lockfile                                   → PASS
pnpm --filter @workspace/api-server run typecheck               → PASS (0 errors)
pnpm --filter @workspace/rag-candidate run typecheck            → PASS (0 errors)
pnpm --filter @workspace/api-server run test                    → PASS (65/65)
pnpm --filter @workspace/api-server run build                   → PASS (dist/index.mjs ~1.9MB)
PORT=4173 BASE_PATH=/ pnpm --filter @workspace/rag-candidate run build  → PASS (391KB JS)
```

---

### pnpm build-approval reproducibility fix (allowBuilds)

**Problem:** `onlyBuiltDependencies` (name-only allowlist) is insufficient on a fresh
checkout with pnpm 10 because pnpm still prompts interactively for `pnpm approve-builds`,
which would write an uncommitted `allowBuilds` map to `pnpm-workspace.yaml`.

**Root cause (from pnpm 10.26.1 source):** pnpm has two parallel approval mechanisms:
- `onlyBuiltDependencies` – name-only allowlist (pnpm 9 compatible)
- `allowBuilds` – explicit `{ packageName: boolean }` map (pnpm 10, written by `pnpm approve-builds`)

`hasDependencyBuildOptions()` in pnpm checks `DEPS_BUILD_CONFIG_KEYS` which includes both.
If neither is present, pnpm falls back to the interactive `pnpm approve-builds` prompt even
with `--frozen-lockfile`. Committing `allowBuilds` removes that interactive requirement.

**Fix:** Added `allowBuilds` map to `pnpm-workspace.yaml` covering all four packages pnpm 10
identifies as having build scripts on Linux x64:
```yaml
allowBuilds:
  '@swc/core': true
  esbuild: true
  msw: true
  onnxruntime-node: true
  protobufjs: true
  sharp: true
  unrs-resolver: true
```

`onlyBuiltDependencies` is retained for pnpm 9 / older-pnpm-10 compatibility.
`pnpm install --frozen-lockfile` now passes on a clean checkout without any interactive step.


## Verdict

**READY_FOR_CODEX_AUDIT**

All five lanes integrated. Static checks pass (typecheck, build, 65 tests). Live benchmark shows correct policy behaviour across all 10 queries:
- Zero noisy/reference/ad chunks in evidence
- Zero `high` confidence with non-sufficient evidence
- All citation numbers valid
- Q3/Q6 correctly `low`; Q7/Q10 correctly `medium` (partial, single-source capped)

The branch is also a candidate for standalone VM/client-test deployment pending Codex approval. Known gaps (LLM non-determinism, section coverage, source diversification) do not affect correctness — they are quality-of-retrieval issues for future lanes.
