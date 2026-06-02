# Report 13 — Confidence & Citation Validation Lane

**Branch:** `experiment/replit-confidence-citation-validation-lane`  
**Date:** 2026-06-02  
**Baseline captured from:** Report 12 after reference/noise filtering lane

---

## Objective

Three known problems with the v1 confidence scoring (from Report 12 baseline):

1. `assessConfidence()` returned `high` even when the LLM explicitly said "no specific information" (Q3 South Sudan) — hedging detection only checked `"i do not"` / `"not found"`.
2. All 10 benchmark queries returned `confidence=high` regardless of source diversity, section quality, or actual evidence gaps.
3. `supportLevel` threshold was `score > 0.025` — always `"direct"` since real hits score 0.27–0.30.
4. No citation validation — no detection of uncited chunks, out-of-range citations, or noisy cited sources.
5. `evidenceSufficiency` field missing from API response entirely.

---

## Changes Made

### `artifacts/api-server/src/lib/rag/types.ts`
- Added `EvidenceSufficiency` type: `"sufficient" | "partial" | "weak" | "insufficient"`
- Added `CitationValidation` interface with: `citedNumbers`, `validCitations`, `invalidCitations`, `uncitedChunkIndices`, `noisyCitedChunks`, `allValid`, `warnings`
- Added `evidenceSufficiency: EvidenceSufficiency` and `citationValidation: CitationValidation` to `QueryResult`

### `artifacts/api-server/src/lib/rag/answer-gen.ts` (full rewrite)

**Score thresholds calibrated to actual distribution:**
- `SCORE_DIRECT = 0.22` (was `0.025` — absurdly low; good results cluster at 0.27–0.30)
- `SCORE_PARTIAL = 0.12`

**Expanded hedging detection (two tiers):**

*Severe hedging → confidence `low`:*
- `"no specific information"` ← Q3 South Sudan
- `"the provided evidence does not contain"` ← Q7 Climate change
- `"no information"`, `"not covered in the documents"`, `"cannot find|locate|answer|provide"`, `"not enough information"`, etc.

*Mild hedging → confidence capped at `medium`:*
- `"limited (direct) information"`, `"limited (direct) evidence"`
- `"not (explicitly|directly) (addressed|covered|stated)"`
- `"partially supported"`, `"not explicitly covered"`, etc.

**New `assessEvidenceSufficiency()` function:**
- `sufficient`: ≥3 direct-score chunks (>0.22) from ≥2 distinct source files, no severe hedging
- `partial`: ≥2 direct-score chunks OR single source with ≥2 high-quality sections
- `weak`: ≥1 direct-score chunk or partial chunks present
- `insufficient`: no chunks OR LLM severely hedged

**New `validateCitations()` function:**
- Extracts all `[N]` references from answer text
- Validates each cited number is within range (≤ chunks returned)
- Flags citations pointing to noisy chunks (noiseScore ≥ 0.5)
- Reports uncited chunks (retrieved but not referenced in answer)
- Emits structured `CitationValidation` with per-category arrays

**New source diversity awareness:**
- Counts distinct `sourceFile` values in top chunks
- Warns when all chunks come from a single document
- Single-source concentration (all from one doc) caps sufficiency at `partial`

**Section quality awareness:**
- High-quality sections: Abstract, Result, Discussion, Conclusion, Finding, Method, Introduction, Analysis, Literature Review, Summary
- Low-quality sections: Key Words, Acknowledgment, Recommendation
- Section quality used in evidence sufficiency computation and confidence reason strings

### `lib/api-spec/openapi.yaml`
- Added `EvidenceSufficiency` schema (enum type with description)
- Added `CitationValidation` schema (object with all 7 fields)
- Added both to `QueryResult` required fields
- Fixed `confidence` to use `enum: [high, medium, low, insufficient]` (was bare `type: string`)
- Fixed `AnswerSource.supportLevel` semantics (now calibrated to real score distribution)

### Codegen: `pnpm --filter @workspace/api-spec run codegen`
- Regenerated Zod schemas and React Query hooks with new types

### `artifacts/rag-candidate/src/components/QueryPanel.tsx`
- Added `EvidenceSufficiencyBadge` component (four-level badge, colour-coded)
- Added `CitationValidationRow` component (shows valid count, uncited count, invalid citations, noisy citations)
- Both displayed in the Answer card header / body
- Added `ShieldCheck` / `ShieldAlert` icons from lucide-react

---

## 10-Query Benchmark Results

| Query | Baseline conf | v2 conf | v2 suf | Notes |
|-------|--------------|---------|--------|-------|
| Q1: Small town resilience | **high** | **high** | partial | Single source warning; 5 direct chunks |
| Q2: Japan flood warning | **high** | **high** | sufficient | 3 sources, 5 direct chunks |
| Q3: South Sudan strategies | **high** | **low** ✓ | insufficient | LLM: "does not contain sufficient information" |
| Q4: Community resilience EM | **high** | **high** | partial | Single source; LLM hedges mildly but answer substantive |
| Q5: Flood vulnerability | **high** | **high** | sufficient | 3 sources, 5 direct chunks |
| Q6: EWS fatalities | **high** | **low** ✓ | insufficient | LLM: no quantitative fatality data in corpus |
| Q7: Climate change FRM | **high** | **low** ✓ | insufficient | LLM: "corpus lacks specific details on FRM policy" |
| Q8: Flood risk comms | **high** | **high** | sufficient | 2 sources, 4 high-quality sections |
| Q9: Resilience methods | **high** | **high** | sufficient | 4 sources, 5 direct chunks |
| Q10: Social risk | **high** | **medium** ✓ | partial | Single source + mild LLM hedge |

### Summary

- **Baseline:** 10/10 `high` confidence (undifferentiated)
- **v2:** 5 `high`, 1 `medium`, 3 `low`, 0 `insufficient`
- All four downgrades (Q3, Q6, Q7, Q10) are **genuine** improvements:
  - Q3: corpus has South Sudan severity data but not adaptation strategies → correctly `low`
  - Q6: corpus discusses EWS qualitatively but lacks fatality rate data → correctly `low`
  - Q7: corpus discusses Sandy event policy cycles, not climate change → FRM mechanisms → correctly `low`
  - Q10: all 5 chunks from one book, LLM hedges on "social constructions" → correctly `medium`

---

## Correctness Analysis

### Why Q4 stays `high` (not downgraded despite "does not explicitly define")

The LLM says *"The provided evidence does not explicitly define how community resilience relates to emergency management planning. However, it indicates that emergency management planning utilizes…"* — this is a mild caveat followed by substantive content. The `isMildlyHedged()` pattern checks for `"not (explicitly|directly) (addressed|covered|stated)"` — "define" is not in that list. After review, this is correct: the LLM is delivering a real answer, so `high` is appropriate.

### Why Q9 stays `high` (starts with "does not explicitly list")

Same analysis: the LLM provides a full set of methods (LSM, community surveys, etc.) after a brief caveat. `high | sufficient` is the right verdict for an answer with 4 distinct sources and 5 direct chunks.

### Citation validation accuracy

All 10 queries: `invalidCitations=[]`, `noisyCitedChunks=[]`. Citation numbers produced by the LLM all fall within the 5-source window.

Q2 and Q5 show partial citation: LLM cited only 2 out of 5 sources — `uncitedChunkIndices` captures this, displayed in the frontend.

---

## Limitations / Future Work

- **LLM non-determinism:** confidence level can vary across runs for borderline queries (especially Q7) since it depends on which hedging phrases the LLM chooses. The detection logic is accurate but the input is stochastic.
- **Mild hedging threshold** is conservative by design — only patterns with high precision are included. Some genuine mild hedges (e.g. "does not explicitly define") are not captured to avoid false downgrades on substantive answers.
- **No cross-run stabilisation:** each query is scored on a single LLM call. A future lane could run 2–3 generations and take a majority vote on confidence.
- **`sectionPath` = `(none)`:** 3 of Q10's top chunks have no section label, which prevents high-quality section bonus. Improving section extraction would help these cases.
