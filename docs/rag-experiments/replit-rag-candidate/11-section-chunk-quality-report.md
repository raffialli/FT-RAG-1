# Report 11 — Section Detection + Chunk Quality Improvement Lane

**Date:** 2026-06-02  
**Experiment branch:** `experiment/replit-section-chunk-quality-lane`  
**Baseline:** Report 10 (OCR cleanup lane, qr2 — 710 chunks, 18/683 = 2.6% sectionPath coverage)

---

## Objective

Improve `sectionPath` metadata coverage across all 9 ingested documents to enable section-aware retrieval, suppress noise chunks (references, TOC lines, contributor lists), and prove retrieval impact on 10 benchmark queries.

---

## Changes Made

### 1. `ocr-cleaner.ts` — Step 15a: Line-start inline heading split

Added regex step that fires when a known section keyword appears at the start of a line (with optional leading whitespace after journal-header removal). Root cause discovered: step 6 (journal header removal) left leading spaces before `ABSTRACT`, so `^` failed without `\s*`.

**Fix:** Changed `^(ABSTRACT|...)` → `^\s*(ABSTRACT|...)` to tolerate leading whitespace.

**Before/After example (V6N5):**
```
BEFORE: "  ABSTRACT Resilience refers to the capacity..."  (one long line)
AFTER:  "ABSTRACT"
        "Resilience refers to the capacity..."
```

**Docs affected:** 6 of 9 JEM papers (Kohn, V3N2, V3N3, V6N5, JEMv9n1, Wood).

### 2. `ocr-cleaner.ts` — Step 15b: Mid-line heading split (new)

Added a new step that handles headings deeply embedded mid-line, not at line start. These occur when:
- A sentence ends with `.!?` followed by a heading keyword: `"...management. DISCUSSION The findings..."` 
- Author credential block precedes ABSTRACT: `"...John Smith, PhD ABSTRACT An effective..."`

**Pattern 1 — sentence-end separator:**
```
([.!?])\s{1,3}(HEADING_KEYWORD)(\s*[:.]\s{1,4})(Body text ≥20 chars)
→ punct + "\n" + heading + "\n" + body
```

**Pattern 2 — credential suffix before ABSTRACT:**
```
(?:PhD|MS|MD|...)\s+(HEADING_KEYWORD)\s+(Body ≥20 chars)
→ credential_suffix + "\n" + heading + "\n" + body
```

**Docs affected:** All 9 docs — FRM book, JEM 2024, Huang (0% → ≥92%), and further depth in all JEM papers.

**New flags added:**
- `split-inline-headings` — step 15a fired (line-start pattern)
- `split-midline-headings` — step 15b fired (mid-line pattern)

### 3. `chunker.ts` — `isUsableChunk` suppression rules

Added 5 suppression rules in the previous session (qr3):
- Numbered reference lines (≥4 bracketed refs)
- Dense bibliography lines (≥3 year citations, high number ratio)
- TOC dot-leader lines (≥5 dots)
- Contributor/affiliation list lines
- Number-only lines

These reduced chunk count from 710 → 683 in qr3 (27 noise chunks suppressed).

---

## Results

### Section path coverage

| Document | Baseline (qr2) | After qr3 | After qr4 (this run) |
|---|---|---|---|
| Flood_Risk_Management-OCR | 0/311 (0%) | 0/311 (0%) | 292/319 **(92%)** |
| JEM_2024_Special_Issue | 0/225 (0%) | 0/225 (0%) | 220/227 **(97%)** |
| JEM-12-1-04-Kohn | 8/35 (23%) | 8/35 (23%) | 35/35 **(100%)** |
| JEM-Wood-South-Sudan | 0/38 (0%) | 8/38 (21%) | 38/38 **(100%)** |
| JEM-Huang-Japan | 0/24 (0%) | 0/24 (0%) | 22/24 **(92%)** |
| JEM_V3N2 | 10/10 (100%) | 10/10 (100%) | 9/9 **(100%)** |
| JEM_V3N3 | 0/5 (0%) | 5/5 (100%) | 6/6 **(100%)** |
| JEM_V6N5 | 0/19 (0%) | 19/19 (100%) | 19/19 **(100%)** |
| JEMv9n1 | 0/16 (0%) | 16/16 (100%) | 16/16 **(100%)** |
| **TOTAL** | **18/683 (2.6%)** | **93/683 (13.6%)** | **657/693 (94.8%)** |

**Net gain: 2.6% → 94.8% sectionPath coverage across the corpus.**

### Section label distribution (top 15 of 657 labeled chunks)

| Section Label | Count |
|---|---|
| Result | 102 |
| Conclusion | 97 |
| Reference | 94 |
| Introduction | 52 |
| Method | 50 |
| Discussion | 46 |
| Approach | 34 |
| Methodology | 29 |
| Abstract | 29 |
| Literature Review | 26 |
| Key Words | 22 |
| Summary | 18 |
| Analysis | 17 |
| Finding | 10 |
| Acknowledgment | 7 |

### Chunk count evolution

| Round | Chunks | Change | Notes |
|---|---|---|---|
| qr1 (pre-OCR) | ~730 | — | Pre-experiment baseline |
| qr2 (OCR lane) | 710 | −20 | OCR cleanup improvements |
| qr3 (section v1) | 683 | −27 | Noise suppression rules added |
| **qr4 (section v2)** | **693** | +10 | More headings → more chunks (expected: section headings now split as own chunks) |

### Retrieval score improvements (qr3 → qr4)

| Query | qr2 conf | qr3 conf | qr4 conf | qr2 score | qr3 score | qr4 score | Delta |
|---|---|---|---|---|---|---|---|
| Q1: Small town resilience strategies | high | high | high | 0.106 | 0.113 | 0.281 | **+149%** |
| Q2: Japan flood warning limitations | high | high | high | 0.267 | 0.267 | 0.283 | +6% |
| Q3: South Sudan flood strategies | high | high | high | 0.282 | 0.287 | 0.296 | +3% |
| Q4: Community resilience + EM | high | high | high | 0.268 | 0.268 | 0.281 | +5% |
| Q5: Flood vulnerability causes | insufficient | high | high | 0.283 | 0.283 | 0.282 | −0% |
| Q6: EWS performance + fatalities | insufficient | high | high | 0.279 | 0.279 | 0.282 | +1% |
| Q7: Climate change + FRM policy | high | high | high | 0.276 | 0.276 | 0.294 | +7% |
| Q8: Flood risk communication | high | high | high | 0.277 | 0.277 | 0.292 | +5% |
| Q9: Community resilience methods | high | high | high | 0.118 | 0.118 | 0.275 | **+133%** |
| Q10: Social constructions of risk | N/A | N/A | high | — | — | 0.292 | new |

**Average score delta (Q1–Q9): +0.044 (+21% relative)**  
**Peak improvement: Q1 +0.168 (+149%), Q9 +0.157 (+133%)**  
**Regressions: none** (Q5 −0.001 is noise; all confidence ratings maintained or improved)

**No confidence regressions across all 10 queries.** Q1 had one transient LLM failure (empty generation) on first run; confirmed high on retry.

---

## Key Findings

### Root cause of the `^\s*` bug

The original step 15a used `^(ABSTRACT|...)` to match section keywords at the start of a line. Step 6 (journal header removal) replaced the journal header prefix with a single space, leaving lines like `"  ABSTRACT Resilience..."`. The `^` anchor matched at true line start but not after leading whitespace — Python simulation confirmed a match at pos=0 on the cleaned text because Python's `re.MULTILINE` `^` also matches after `\n`, and the clean text already had ABSTRACT at character 0 of the line. However the compiled JS bundle was also tested and confirmed the same behaviour — the issue was that the raw doc processing produces `"  ABSTRACT"` with 2 leading spaces from the space left by journal header replacement before whitespace normalization runs. Fix: `^\s*(ABSTRACT|...)`.

### Why step 15b was necessary

Seven of nine documents had section headings at positions 140–2400 within 3,000–5,000 character lines. These headings always follow sentence-ending punctuation (`.`) with 1–3 spaces. The mid-line split pattern fired on all nine documents and is the primary driver of the jump from 13.6% → 94.8% coverage.

### Q1 and Q9 score jumps

Both queries showed >130% score improvement because their answer content lives in the `ABSTRACT` and `Discussion`/`Method` sections of V6N5 (Q1) and in the `Discussion`/`Method` sections of V6N5 and FRM book (Q9). Before section splitting, these chunks were large (3,000–5,000 chars) and semantically dilute. After splitting into section-bounded chunks, embedding similarity concentrated on topic-specific text.

### FRM Book and JEM 2024 — section detection achieved via step 15b only

Neither the FRM book nor JEM 2024 had section headings that appeared at line start — all headings were sentence-interior. Step 15b achieved 92% and 97% coverage respectively, revealing chapter-level structure in the FRM book (`Introduction`, `Conclusions`, `Methodology`, `Discussion`) and article-level structure in JEM 2024 (`Abstract`, `Methods`, `Findings`, `Discussion`, `Conclusion`).

### Remaining 5.2% unlabeled chunks

The 36 unlabeled chunks fall into two categories:
1. **Preamble text** (title + author lines before the first heading) — by definition section-less; correctly left unlabeled.
2. **Continuation blocks** in the FRM book where chapter text spans many pages without any embedded heading signal — correctly left unlabeled.

---

## Sample Query Answers (qr4)

### Q2: Japan flood warning system mobilization and limitations
> **Confidence: high** | 5 sources (Huang paper: Result, Conclusion, Analysis sections)
>
> Japan's flood warning system mobilizes evacuation through a five-stage protocol that transitions responsibility from national to local authorities and specifies actions for different population groups. Levels 1 & 2 issue early warnings; Levels 3–5 escalate to mandatory evacuation for vulnerable populations then all residents. Limitations identified: (1) insufficient lead time at non-gauged sites, (2) under-utilization of evacuation instructions by elderly populations, (3) the 2020 Kuma River tragedy showed a functioning warning system can fail when emergency response implementation breaks down.

### Q9: Methods to assess flood resilience at community level
> **Confidence: high** | 5 sources (V6N5 Discussion, FRM Method sections)  
> **Score: 0.118 → 0.275 (+133%)** — largest beneficiary of section splitting
>
> Retrieved qualitative strategy frameworks from the V6N5 Discussion section and quantitative methodological approaches from the FRM book Method section, combining both into a grounded answer. Before section splitting, these chunks were diluted by 3,000+ char context windows that buried the methodological content.

### Q10: Social constructions of risk in flood risk management (new query)
> **Confidence: high** | 5 sources (FRM book Approach, Conclusion sections)
>
> Draws directly from the FRM book chapter on "Realities and social constructions in flood risk management" — specifically from the Approach section. Without section detection, these chunks from the 311-chunk FRM corpus would not have been reliably surfaced. Score: 0.292.

---

## Conclusions

1. **Section detection via text splitting is highly effective** for OCR-extracted PDFs where section headings are embedded inline rather than on their own lines. Two regex steps (line-start + mid-line) achieved 94.8% coverage across a corpus that started at 2.6%.

2. **The `^\s*` fix was non-obvious** — the bug required a Node.js vs Python comparison to isolate. In both runtimes the logic was identical, but the intermediate pipeline state (leading whitespace from header removal) was not apparent from static code inspection.

3. **Score improvements are concentrated where sections matter most** — queries targeting single-document content (Q1 V6N5, Q9 FRM+V6N5) saw the largest gains because section splitting broke 5,000-char monolithic chunks into 300–600 char section-bounded units with much higher embedding specificity.

4. **No regressions** across all 10 queries. Confidence maintained at "high" for 9/10 queries; Q5 and Q6 which previously required the OCR cleanup lane to recover from "insufficient" remain stable at "high".

5. **Chunk count is slightly higher** (693 vs 683 before) because section headings now form their own short chunks — acceptable and expected.

---

## Next Steps

- Push this branch to `experiment/replit-section-chunk-quality-lane` on GitHub
- Consider filtering `Reference` section chunks from top-K results (94 chunks labeled Reference — these appear in Q5 sources but add noise)
- Consider adjusting reranker to up-weight `Abstract` and `Discussion` sections for question-answering queries
- Evaluate whether section-weighted scoring (e.g. `sectionPath == 'Result'` gets a small boost for result-seeking questions) further improves Q4/Q10
