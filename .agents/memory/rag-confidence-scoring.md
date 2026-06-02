---
name: RAG confidence scoring calibration
description: Calibrated score thresholds and hedging detection patterns for the FalconTrust RAG pipeline (all-MiniLM-L6-v2 embeddings, qwen3.5 generation).
---

## Score thresholds (all-MiniLM-L6-v2 on flood-risk corpus, 693 chunks)

Good hits cluster at 0.27–0.30; weak hits drop to 0.12–0.18; noise is < 0.10.

- `SCORE_DIRECT = 0.22` — strong evidence
- `SCORE_PARTIAL = 0.12` — partial evidence
- Below 0.12 → `supportLevel = "weak"`

The old threshold of `score > 0.025` was always true and gave every chunk `"direct"` support. Do not revert.

## Hedging detection (two-tier, full-answer scan)

Scan the entire answer string, not just the first N characters — the hedge phrase often appears mid-answer or in the closing sentence.

**Severe hedging → confidence `low` / sufficiency `insufficient`:**
- `"no specific information"`
- `"no information"`
- `"the corpus does not contain"`
- `"the (provided) evidence does not (contain|include|address)"`
- `"not covered in the (provided|source|ingested) documents"`
- `"cannot (find|locate|answer|provide)"`
- `"i (do not|don't) have (sufficient|enough) (information|evidence)"`
- `"not (enough|sufficient) (information|evidence)"`

**Mild hedging → confidence capped at `medium`:**
- `"limited (direct) information"` / `"limited (direct) evidence"`
- `"partially (supported|evidence|information)"`
- `"not (explicitly|directly) (addressed|covered|stated)"`

Note: `"does not explicitly define"` is NOT in the mild list by design — the LLM often pairs this with substantive content, and capturing it caused false downgrades.

## Source diversity

Single-source concentration (all top-K chunks from one file) caps `evidenceSufficiency` at `partial` and emits a warning. `high` confidence is still possible with single-source IF there are ≥2 HQ sections AND no mild hedging.

## Citation validation

The LLM reliably cites [N] numbers within range for this corpus. `invalidCitations` and `noisyCitedChunks` have been consistently empty across all 10 benchmark queries post noise-filtering lane. `uncitedChunkIndices` is the main signal — LLM often cites only 2–3 of the 5 provided sources.

**Why these thresholds and patterns matter:** The v1 scorer used `score > 0.025` (always true for this corpus) and only checked `"i do not"` / `"not found"` for hedging. That made all queries return `high` even when the LLM explicitly acknowledged corpus gaps. The v2 patterns correctly detect real insufficiency without false-downgrading substantive answers that begin with a mild caveat.
