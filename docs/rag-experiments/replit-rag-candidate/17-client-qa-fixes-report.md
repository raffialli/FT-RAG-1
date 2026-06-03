# Report 17 — Client QA Fixes Lane

**Branch:** `experiment/replit-client-qa-fixes-lane`  
**Date:** 2026-06-03  
**Status:** Implementation complete — awaiting QA validation

---

## Summary

Targeted fixes addressing six failure modes identified in Necris QA review before client testing. Changes span the retrieval pipeline, confidence calibration, answer synthesis prompt, and client UI source display.

---

## Client QA Benchmark

Ten benchmark questions used for evaluation. This section records the target behaviour for the five questions with known deficiencies.

| # | Question (abbreviated) | Pre-fix behaviour | Target after fix |
|---|---|---|---|
| Q3 | How should emergency managers communicate flood risk to the public? | Conservative "corpus lacks info" — confidence low | Partial answer with indirect evidence; confidence medium |
| Q4 | What role does community engagement play in flood resilience? | Overstated "high" confidence on single-source evidence | Confidence ≤ medium (single-source + partial coverage) |
| Q6 | How have EWS reduced flood fatalities? | No quantitative data; corpus correctly returns insufficient | Unchanged — stay low |
| Q7 | How does climate change affect FRM policy? | Overstated high confidence despite corpus gap | Confidence ≤ medium |
| Q10 | What references are cited in the FRM book? | Bibliography chunks suppressed; generic non-answer | FRM bibliography chunks retrieved and listed |

---

## Fixes Implemented

### Fix 1 — Q3: Communication query reranking boost

**File:** `artifacts/api-server/src/lib/rag/retriever.ts`  
**Change:** Added `isCommQuery` detection in `rerankResults`. When a query contains communication-related terms (`communicat*`, `public*risk`, `outreach`, etc.), chunks containing ≥2 communication terms receive a +0.08 rerank bonus (additional +0.05 for ≥3 terms).  
**Rationale:** BM25/vector search surfaces communication-adjacent chunks but the reranker gave no signal boost for them. The communication terms in the corpus (JEM articles on public warning systems) were ranking behind general flood-risk chunks.

### Fix 2 — Q10: Reference query chunk boost + diversity relaxation

**File:** `artifacts/api-server/src/lib/rag/retriever.ts`  
**Changes (two sub-fixes):**

1. **Rerank boost:** When `refQuery=true`, `reference-list`/`bibliography` chunks receive +0.22 rerank adjustment; `citation-heavy` chunks get +0.08. This actively surfaces bibliography content rather than merely neutralising the penalty.

2. **Diversity cap lifted:** `diverseSelect` now accepts `refQuery`; when true, `sourceCap` is raised to `topK` (effectively unlimited). Previously the DIVERSITY_SOURCE_CAP=3 prevented more than 3 FRM-book bibliography chunks from appearing in the top-5 results.

**Rationale:** `isReferenceQuery` already detected Q10 correctly (matches "references" and "cited"). The problem was that (a) bibliography chunks had low initial vector/BM25 scores because they contain author names not query terms, and (b) diversity selection blocked 4th and 5th FRM chunks.

### Fix 3 — Confidence calibration: mild-hedging patterns

**File:** `artifacts/api-server/src/lib/rag/scoring.ts`  
**Change:** Added 8 new patterns to `isMildlyHedged`:
- `only indirect(ly)`
- `indirectly supported`
- `does not fully (answer|address|cover)`
- `not fully supported`
- `not well supported`
- `cannot (be) definitively`
- `insufficient to (fully|definitively) (answer|address)`
- `only partially (addressed|covered|answered|supported)`

**Rationale:** The LLM commonly uses these hedging phrases when evidence is partial. Without detection, the answer scored as "direct" evidence which inflated confidence to "high" for Q3/Q4/Q7 style queries with partial corpus coverage.

### Fix 4 — Citation support labels: query-aware support level

**File:** `artifacts/api-server/src/lib/rag/answer-gen.ts`  
**Change:** `buildSources` now calls `querySupportLevel(query, chunk)` instead of a raw score comparison. A chunk with `score > SCORE_DIRECT` is still downgraded to `"partial"` if fewer than 2 query content words appear in its text (overlap < 25%). This prevents tangentially-retrieved high-RRF chunks from being labelled `"direct"` support.  
**Threshold:** Minimum 2 matching terms of length > 3 from the query, OR 25% overlap ratio.

### Fix 5 — Client-facing source titles

**Files:** `artifacts/api-server/src/lib/rag/source-titles.ts` (new), `artifacts/api-server/src/lib/rag/answer-gen.ts`, `artifacts/api-server/src/lib/rag/types.ts`, `lib/api-spec/openapi.yaml`, `artifacts/rag-candidate/src/components/QueryPanel.tsx`

**Change:** Added `displayTitle?: string` to `AnswerSource`. A new `source-titles.ts` module maps all 9 known PDF filenames to readable titles. The API populates `displayTitle` on every source. The UI `SourceCard` renders `displayTitle` with the raw filename as a tooltip.

**Title map:**

| Raw filename | Display title |
|---|---|
| `Flood_Risk_Management-OCR_…pdf` | Flood Risk Management (FRM Book) |
| `JEM_2024_Special_Issue_…pdf` | JEM 2024 Special Issue |
| `bdevito67,+JEM_20-8-08-Wood-…pdf` | Practical Flood Risk Reduction (Wood, JEM 20-8) |
| `bdevito67,+JEM_21-1-04-Huang_…pdf` | Japan Flood Warning System (Huang, JEM 21-1) |
| `bdevito67,+JEM_V3N2_…pdf` | Flood Risk Communication & Governance (JEM V3N2) |
| `bdevito67,+JEM_V3N3_…pdf` | Flood Risk Assessment Methods (JEM V3N3) |
| `bdevito67,+JEM_V6N5_…pdf` | Community Resilience & Recovery (JEM V6N5) |
| `bdevito67,+JEMv9n1_…pdf` | Emergency Response Planning (JEM V9N1) |
| `bdevito67,+JEM-12-1-04-Kohn_…pdf` | Personal Preparedness Curriculum (Kohn, JEM 12-1) |

### Fix 6 — Answer synthesis prompt: partial-answer guidance

**File:** `artifacts/api-server/src/lib/rag/answer-gen.ts`  
**Change:** Replaced the instruction `"If the evidence does not contain enough information … say explicitly: 'The corpus does not contain sufficient information …'"` with a two-tier instruction:

> "If the evidence partially addresses the question, synthesize what the evidence shows and explicitly note which aspects have stronger vs. weaker support."  
> "Only say 'The corpus does not contain sufficient information' if NO relevant evidence is found at all."

**Rationale:** The original instruction caused the LLM to issue severe-hedging signals even when partial evidence existed, which triggered `isSeverelyHedged` and produced `confidence=low` for Q3 and Q4 where relevant (if partial) corpus coverage exists.

### Fix 7 — isReferenceQuery: expanded patterns

**File:** `artifacts/api-server/src/lib/rag/chunk-classifier.ts`  
**Change:** Added `list of (sources|references|citations)`, `what (sources|references|citations) are cited|used|included`, and `(sources|references) cited in` to the detection regex.  
**Rationale:** Q10 was already matched by the original "references" pattern, but the expanded set handles future variations like "what sources are used in the FRM book?" or "list of citations in Chapter 3".

---

## Test additions

**File:** `artifacts/api-server/src/lib/rag/answer-gen.test.mts`

Added 12 new deterministic assertions in section 4 for the new `isMildlyHedged` patterns, and 4 new scenario-based regressions in section 7 (Q3/Q4/Q10 + clean-answer guard).

**All 65 tests pass** (up from 53).

---

## Files changed

| File | Change type |
|---|---|
| `artifacts/api-server/src/lib/rag/source-titles.ts` | New |
| `artifacts/api-server/src/lib/rag/scoring.ts` | Edit — 8 new `isMildlyHedged` patterns |
| `artifacts/api-server/src/lib/rag/answer-gen.ts` | Edit — displayTitle, querySupportLevel, prompt |
| `artifacts/api-server/src/lib/rag/retriever.ts` | Edit — comm boost, refQuery boost, diverseSelect |
| `artifacts/api-server/src/lib/rag/chunk-classifier.ts` | Edit — isReferenceQuery expansion |
| `artifacts/api-server/src/lib/rag/types.ts` | Edit — displayTitle on AnswerSource |
| `lib/api-spec/openapi.yaml` | Edit — displayTitle in AnswerSource schema |
| `artifacts/rag-candidate/src/components/QueryPanel.tsx` | Edit — SourceCard uses displayTitle |
| `artifacts/api-server/src/lib/rag/answer-gen.test.mts` | Edit — 12 new assertions, 4 new scenarios |
| `docs/rag-experiments/replit-rag-candidate/17-client-qa-fixes-report.md` | New (this file) |

---

## Known limitations / follow-on work

- **Q3 still depends on LLM behaviour**: the prompt fix guides the model but cannot guarantee it won't punt to a conservative answer if retrieved chunks are too tangential. Real-world validation against the live LLM is required.
- **Q10 bibliography quality**: bibliography chunks from the FRM book are OCR-extracted and may contain garbled author names or partial URLs. The answer will reflect whatever the OCR produced.
- **SCORE_DIRECT/SCORE_PARTIAL thresholds** (0.22 / 0.12) remain unchanged — a dedicated recalibration pass with score distribution analysis across all 10 QA questions is recommended once live QA results are available.
- **`displayTitle` is optional** in the API schema — if a source file is added post-release without a mapping entry, the UI gracefully falls back to the sanitised filename.
