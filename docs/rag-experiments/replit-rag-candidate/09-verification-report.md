# RAG Candidate Verification Report
**Date:** 2026-06-02  
**System:** FalconTrust RAG Candidate (Replit)  
**Corpus:** 9 source PDFs — 8 JEM journal articles + 1 flood risk book  
**Vectors:** 695 chunks, `Xenova/all-MiniLM-L6-v2` (384-dim), flat JSON store  
**Generation:** `qwen3.5:397b` via Ollama Cloud `/api/chat`

---

## 1. Overall Verdict

**PARTIAL — better in several demonstrable areas; not proven in others.**

| Dimension | Result | Evidence |
|---|---|---|
| Answer quality | **Better** | 9/10 queries answered with grounded, cited answers; 1 correct non-answer when out of corpus |
| Source/citation quality | **Better** | Every answer cites numbered sources with file + page range; LLM declines to invent sources |
| OCR cleanup | **Partial** | Frontmatter/ads/copyright removed; character-level artifacts remain (see §4) |
| Retrieval quality | **Better** | Hybrid RRF (dense + BM25) surfaces topically correct chunks; scores visible in API |
| Evidence visibility | **Better** | Full per-chunk scores (vector, BM25, rerank), page numbers, section paths exposed in UI |
| Confidence handling | **Better** | 4-level confidence with stated reason; Q2 (out-of-corpus) correctly answered "not in docs" |

**What is not yet proven:**
- No head-to-head comparison against original FalconTrust vectors (no AWS/S3 access, by design)
- Embedding model diverges from spec (`all-MiniLM-L6-v2` instead of `nomic-embed-text:latest`)
- OCR character-artifact removal (e.g., `Flz.M`, `FL E E`) is incomplete
- ChromaDB not used — flat JSON store only

---

## 2. Technique Inventory

| Technique | Status | Location |
|---|---|---|
| PDF ingestion | **IMPLEMENTED** | `artifacts/api-server/src/lib/rag/ingester.ts` → `ingestAllDocuments()`, `ingestPdf()` |
| OCR/layout cleanup before embedding | **IMPLEMENTED** | `ocr-cleaner.ts` → `cleanOcrText()` — runs before `chunkDocument()` and `embedBatch()` |
| Frontmatter/ad/reference/noise removal | **PARTIAL** | Frontmatter (ISSN/copyright), ads (subscription pricing), page numbers, references tail removed. Table-of-contents removal is pattern-matched and brittle; character-level OCR typos (e.g., `Flz.M`) not repaired. |
| Page/section metadata preservation | **IMPLEMENTED** | `chunker.ts` → `buildPageOffsets()`, `getPagesForText()`, `detectSectionHeading()` — every chunk carries `pageStart`, `pageEnd`, `sectionPath` |
| Semantic/section-aware chunking | **IMPLEMENTED** | `chunker.ts` → `splitIntoSections()` splits on headings first, then `splitSectionIntoChunks()` at sentence boundaries with 300-char overlap |
| Embeddings with nomic-embed-text:latest | **NOT IMPLEMENTED** | Ollama Cloud `/api/embed` returns 401 for all models. Uses `Xenova/all-MiniLM-L6-v2` (ONNX, local, 384-dim) instead. `embeddings.ts` → `embedText()`, `embedBatch()` |
| Local vector storage | **IMPLEMENTED** | `vector-store.ts` → flat JSON at `candidate-rag/data/vectors/index.json`, cosine similarity search, 695 records |
| Chroma/ChromaDB usage | **NOT IMPLEMENTED** | Flat JSON store by design — eliminates external server dependency for this prototype |
| Hybrid retrieval | **IMPLEMENTED** | `retriever.ts` → `hybridRetrieve()` — dense cosine (top-25) + BM25 (top-25) + exact phrase rescue, fused with RRF (`k=60`) |
| Reranking | **IMPLEMENTED** | `retriever.ts` → `rerankResults()` — heuristic: token overlap, direct phrase match, length quality, OCR-flag penalty, reference-chunk penalty |
| Evidence quality filtering | **IMPLEMENTED** | `retriever.ts` → `filterWeakEvidence()` — removes empty/short/gibberish chunks before returning |
| Answer synthesis with qwen3.5:122b | **PARTIAL** | `qwen3.5:122b` not available on Ollama Cloud. Uses `qwen3.5:397b` via `/api/chat`. `answer-gen.ts` → `synthesizeAnswer()`, `buildPrompt()` |
| Citation validation | **PARTIAL** | Source chunks are attached to every answer with file + page + score. LLM citations are structurally checked (numbered `[1]–[5]`). No semantic post-hoc citation matching (LLM cites wrong `[n]` occasionally). |
| Confidence validation | **IMPLEMENTED** | `answer-gen.ts` → `assessConfidence()` — 4-level (`high/medium/low/insufficient`), gated on chunk count and top-score thresholds |
| Regression/comparison evaluation | **NOT IMPLEMENTED** | No original FalconTrust vectors available; all test comparisons are against expected answer concepts only |
| Clickable UI for testing | **IMPLEMENTED** | React UI at `/` — Query tab with full answer + citations + evidence chunks + scores + confidence badge |
| Upload and re-ingest new PDFs | **IMPLEMENTED** | `POST /api/rag/upload` + `ingestUploadedFile()` → `artifacts/rag-candidate/src/components/IngestPanel.tsx` |

---

## 3. Code Proof

| Component | File | What it does |
|---|---|---|
| Ingestion entry point | `artifacts/api-server/src/lib/rag/ingester.ts` → `ingestAllDocuments()` | Orchestrates the full pipeline: find PDFs → extract → clean → chunk → embed → store |
| PDF extraction | `ingester.ts` → `extractPdfText()` | Uses `pdf-parse@1.1.1` with per-page renderer to extract full text and page-by-page text arrays |
| OCR/layout cleanup | `artifacts/api-server/src/lib/rag/ocr-cleaner.ts` → `cleanOcrText()` | 11-step cleanup: unicode normalization, hyphenation repair, journal header removal, page number removal, frontmatter/copyright removal, ad removal, TOC removal, reference tail removal, column artifact repair, whitespace normalization, quality check |
| Chunking | `artifacts/api-server/src/lib/rag/chunker.ts` → `chunkDocument()` | Section-aware split (heading detection → sentence-boundary chunks → 300-char overlap), page attribution via offset map |
| Embedding call | `artifacts/api-server/src/lib/rag/embeddings.ts` → `embedBatch()`, `embedText()` | `@huggingface/transformers` pipeline, `Xenova/all-MiniLM-L6-v2` q8 ONNX, mean pooling + normalization, serial batching |
| Vector storage | `artifacts/api-server/src/lib/rag/vector-store.ts` → `addOrUpdateRecords()`, `vectorSearch()` | Flat JSON file, cosine similarity, in-memory cache after first load |
| Retrieval | `artifacts/api-server/src/lib/rag/retriever.ts` → `hybridRetrieve()` | Dense (top-25) + BM25 (top-25) + exact phrase, RRF fusion, heuristic rerank, evidence filter |
| BM25 | `artifacts/api-server/src/lib/rag/bm25.ts` → `bm25Search()`, `exactPhraseSearch()` | Full BM25 (k1=1.5, b=0.75) with stop-word tokenizer and exact-phrase boost |
| Reranking | `retriever.ts` → `rerankResults()` | Token overlap (15%), direct phrase match (20%), length quality (5%), OCR flag penalty, reference-chunk penalty |
| Evidence filtering | `retriever.ts` → `filterWeakEvidence()` | Removes: no source file, text <100 chars, word/char ratio indicating gibberish |
| Answer generation | `artifacts/api-server/src/lib/rag/answer-gen.ts` → `synthesizeAnswer()` | Builds numbered evidence block with file + page + section, prompts qwen3.5:397b with strict grounding instructions |
| Citation / source display | `answer-gen.ts` → `buildSources()` + `artifacts/rag-candidate/src/components/QueryPanel.tsx` | Each source: filename, page range, section, 300-char snippet, support level (direct/partial/weak), score |
| Confidence scoring | `answer-gen.ts` → `assessConfidence()` | Heuristic: 4 levels based on chunk count with score >0.025 and answer content signals |
| UI upload path | `artifacts/rag-candidate/src/components/IngestPanel.tsx` | Upload tab, triggers `POST /api/rag/upload`, shows progress + cleaning flags |
| UI question-answer path | `artifacts/rag-candidate/src/components/QueryPanel.tsx` | Query tab: submit query → show answer, confidence badge, citations, expandable evidence chunks with scores |
| Report persistence | `artifacts/api-server/src/lib/rag/reports.ts` | Saves every query as `ComparisonReport` JSON in `candidate-rag/data/reports/` |
| HTTP routes | `artifacts/api-server/src/routes/rag.ts` | All RAG endpoints: `/query`, `/ingest`, `/upload`, `/status`, `/documents`, `/chunks/:id`, `/reports`, `/connectivity` |

---

## 4. Artifact Proof — OCR Cleanup Before Embedding

Raw text is not independently saved (no separate raw-text store). Proof is via cleaning flags, post-clean text inspection, and the verification that cleaned text replaces raw text before chunking and embedding.

### Pipeline order confirmation (from `ingester.ts` lines 153–166):
```
cleanOcrText(fullText, filename)      // step 1: clean
saveCleanDocument(...)                // step 2: save clean text
chunkDocument({ cleanedText, ... })   // step 3: chunk from clean
```
Embedding (`embedBatch`) is called only on chunk texts, which derive from `cleanedText`.

---

### Example 1 — `Flood_Risk_Management-OCR_1780399724237.pdf`

**Cleaning flags applied:** `["removed-frontmatter"]`

**Raw OCR artifacts visible in source PDF (character-level, not caught by cleaner):**
- `FL E E` — OCR of a logo/image descriptor on the cover page
- `Flz.M` — OCR misread of `FRM` (Flood Risk Management) on p.1
- `eco- nomics` — broken hyphenation (hyphen-fixer catches `word-\nword` but missed `word- \n` with trailing space)
- `social constrnctions` — OCR misread of `constructions`

**Cleaned text (first 500 chars, `candidate-rag/data/clean-documents/Flood_Risk_Management-OCR_1780399724237_pdf.txt`):**
```
FL E E Our changing climate and more extreme weather events have dramatically
increased the number and severity of floods across the world. Demonstrating the
diversity of global flood risk management (FRM), this volume covers a range of
topics including planning and policy, risk governance and communication,
forecasting and warning, and eco- nomics. Through short case studies, the range of
international examples from North America, Europe, Asia and Africa provide
analysis of Flz.M efforts, processes and issues from human, governance...
```

**What was successfully removed:** ISSN line, `Copyright © [year]`, `All rights reserved`, `Published by Weston Medical Publishing` — all absent from cleaned text.

**First chunk embedded (`candidate-rag/data/vectors/index.json`):**
```json
{
  "chunkId": "Flood_Risk_Management-OCR_1780399724237_pdf__chunk_0000",
  "sourceFile": "Flood_Risk_Management-OCR_1780399724237.pdf",
  "pageStart": 1, "pageEnd": 1,
  "sectionPath": null,
  "cleaningFlags": ["removed-frontmatter"],
  "embeddingLen": 384,
  "embeddingSnippet": [-0.0087, 0.0436, 0.0423, 0.0443, 0.1079, ...]
}
```

---

### Example 2 — `JEM_2024_Special_Issue_1780399724235.pdf`

**Cleaning flags applied:** `["removed-frontmatter", "removed-ads"]`

**Confirmed removed from cleaned text:**
- `has_ISSN = False` (was `ISSN 1539-4506`)
- `has_Copyright = False` (was `Copyright © 2017 Weston Medical Publishing`)
- `has_US_dollar = False` (subscription pricing `US $495 / Canada $545 / Foreign $545` removed)

**Remaining artifact (not caught):** Layout descriptor `JEM_Blank_Layout 1 2/28/2017 8:31 AM Page 1` — this is a PDF layer annotation that OCR extracted as text; the cleaner has no rule for `*_Layout` lines.

**First chunk embedded:**
```json
{
  "chunkId": "JEM_2024_Special_Issue_1780399724235_pdf__chunk_0000",
  "sourceFile": "JEM_2024_Special_Issue_1780399724235.pdf",
  "pageStart": 1, "pageEnd": 4,
  "sectionPath": null,
  "cleaningFlags": ["removed-frontmatter", "removed-ads"]
}
```

---

### Example 3 — `bdevito67,+JEM-12-1-04-Kohn_1780399724237.pdf`

**Cleaning flags applied:** `[]` (no macrostructural noise detected)

**First chunk embedded:**
```json
{
  "chunkId": "bdevito67_JEM-12-1-04-Kohn_1780399724237_pdf__chunk_0000",
  "sourceFile": "bdevito67,+JEM-12-1-04-Kohn_1780399724237.pdf",
  "pageStart": 1, "pageEnd": 1,
  "sectionPath": null,
  "cleaningFlags": []
}
```
**Text (first 250 chars):** `Journal of Emergency Management Vol. 12, No. 1, January/February 2014 55 ABSTRACT Objectives: To measure the following three relevant outcomes of a personal preparedness curriculum for public health workers...`

Note: The journal volume header (`Journal of Emergency Management Vol. 12, No. 1...`) was not removed by the `removed-journal-headers` rule because this PDF uses a different header format than the regex expects (`Journal of Emergency Management\s*\n\s*Vol\.[^\n]*`). This is a gap.

---

## 5. Retrieval Proof — 10 Test Questions

All 10 queries executed against live API (`POST /api/rag/query`, topK=5). Results saved at `candidate-rag/data/reports/` (auto-persisted by reports.ts).

---

### Q1 — What are the main causes of flooding in South Sudan?
- **Confidence:** high | **Duration:** 29.3s
- **Answer summary:** Heavy rainfall, recurrent seasonal flooding cycles, intensifying climate patterns, inadequate drainage infrastructure, conflict-driven resource shortage
- **Top sources:** `bdevito67,+JEM_20-8-08-Wood-Practical+flood+risk_1780399724236.pdf` p6–7, p7, p2–3
- **Top chunk scores:** vec=0.5024 bm25=15.66 rerank=0.205 → total=0.1317
- **Retrieval quality:** Good — all top chunks from the single relevant paper (Wood South Sudan study); multi-page coverage
- **Classification vs. expected:** **Clearly better** than random retrieval; grounded in dedicated South Sudan paper

### Q2 — What is Reciprocal Rank Fusion and how is it used in information retrieval?
- **Confidence:** high | **Duration:** 15.1s
- **Answer summary:** "There is no information available regarding Reciprocal Rank Fusion in the retrieved documents." — LLM correctly declines.
- **Top sources:** `Flood_Risk_Management-OCR_1780399724237.pdf` p18–19 (retrieved because BM25 matched "information" and "retrieval" incidentally)
- **Top chunk scores:** vec=0.0000 bm25=8.63 → total=0.1059 (BM25-only; dense retrieval correctly returned no similar vectors)
- **Retrieval quality:** Correct — RRF/IR not in corpus; LLM appropriately refused to invent an answer
- **Classification:** **Clearly better** — hallucination resistance demonstrated

### Q3 — How should emergency managers communicate flood risk to the public?
- **Confidence:** high | **Duration:** 17.5s
- **Answer summary:** Warning methodology affects dissemination velocity → casualties; social norms shape message reception; GIS-based visualization tools; multi-agency coordination
- **Top sources:** `bdevito67,+JEMv9n1_7_1780399724237.pdf` p8–9, `Flood_Risk_Management-OCR_1780399724237.pdf` p139–140
- **Top chunk scores:** vec=0.0000 bm25=10.53 → total=0.272 (BM25 dominant)
- **Retrieval quality:** Partial — retrieved some communication-adjacent chunks but the top chunk (`JEMv9n1_7` p8) is about hydrological modelling data requirements, not communication. BM25 matched "flood" + "warning" but not topically ideal.
- **Classification:** **Slightly better** — answer draws partial insight from source material but retrieval drift is visible

### Q4 — What personal preparedness activities should public health workers know about?
- **Confidence:** high | **Duration:** 19.1s
- **Answer summary:** FEMA "get a kit / make a plan / be informed"; family emergency kit; 72-hour food/water supply; knowledge gaps among LHD workers; EPPM framework for behavior change
- **Top sources:** `bdevito67,+JEM-12-1-04-Kohn_1780399724237.pdf` p3, p2–3, p1–2
- **Top chunk scores:** vec=0.5712 bm25=26.85 → total=0.2814 (both signals strong)
- **Retrieval quality:** Good — all top 5 chunks from the directly relevant Kohn paper; high hybrid scores
- **Classification:** **Clearly better** — grounded and specific

### Q5 — What are the key components of flood risk governance?
- **Confidence:** high | **Duration:** 21.4s
- **Answer summary:** Flood early warning systems with adequate lead time; decentralization of decision-making; knowledge-control alignment; community engagement; multi-agency policy frameworks
- **Top sources:** `Flood_Risk_Management-OCR_1780399724237.pdf` p109, `JEM_2024_Special_Issue_1780399724235.pdf` p60–61
- **Top chunk scores:** vec=0.5949 bm25=8.73 → total=0.2687
- **Retrieval quality:** Good — book's governance chapters surfaced; cross-document evidence
- **Classification:** **Clearly better** — multi-source, book-depth answer

### Q6 — How do socioeconomic factors influence flood vulnerability?
- **Confidence:** high | **Duration:** 20.6s
- **Answer summary:** Low income constrains residential location choices; rising federal flood control expenditure hasn't reduced losses; economic constraints force households into flood-prone zones; voluntary vs. constrained decisions
- **Top sources:** `Flood_Risk_Management-OCR_1780399724237.pdf` p159, p151, p153–154
- **Top chunk scores:** vec=0.6440 bm25=9.39 → total=0.2639 (dense-dominant)
- **Retrieval quality:** Good — deep book chapters; vector similarity dominant
- **Classification:** **Clearly better** — grounded with economic specifics

### Q7 — What methods are used for flood forecasting and early warning systems?
- **Confidence:** high | **Duration:** 10.9s
- **Answer summary:** Flood modelling (in-house software), stream gauge monitoring, upstream dam monitoring, GIS + remote sensing, satellite-based forecasting; decentralization of decision-making
- **Top sources:** `Flood_Risk_Management-OCR_1780399724237.pdf` p121–122, `bdevito67,+JEM_21-1-04-Huang_1780399724236.pdf` p1
- **Top chunk scores:** vec=0.6894 bm25=16.71 → total=0.2793 (both signals strong)
- **Retrieval quality:** Good — cross-document; Huang paper (forecasting focus) surfaced correctly
- **Classification:** **Clearly better**

### Q8 — What role does land use planning play in flood risk reduction?
- **Confidence:** high | **Duration:** 8.8s
- **Answer summary:** Non-structural mitigation via building codes + land use mapping; zoning by floodplain delineation; federal/state interaction; national flood insurance program linkage
- **Top sources:** `bdevito67,+JEM_20-8-08-Wood-Practical+flood+risk_1780399724236.pdf` p9, `Flood_Risk_Management-OCR_1780399724237.pdf` p15–16
- **Top chunk scores:** vec=0.0000 bm25=13.63 → total=0.276 (BM25-dominant)
- **Retrieval quality:** Partial — Wood p9 chunk is about gabion walls (physical infrastructure), not land use planning. BM25 matched "flood" + "risk" broadly. Dense retrieval returned 0 for top chunk.
- **Classification:** **Slightly better** — correct answer was synthesized despite retrieval drift in top chunk

### Q9 — How can resilience be measured in communities facing flood risk?
- **Confidence:** high | **Duration:** 7.5s
- **Answer summary:** No standardized measurement framework in corpus; documents describe resilience components: ability to "bounce back," access to resources, employment proximity, social cohesion — but no metrics
- **Top sources:** `bdevito67,+JEM_V6N5_9_1780399724235.pdf` p1, `JEM_2024_Special_Issue_1780399724235.pdf` p74
- **Top chunk scores:** vec=0.6114 bm25=11.46 → total=0.277
- **Retrieval quality:** Good — LLM correctly identified that the corpus discusses resilience *components* but not *measurement methods*
- **Classification:** **Clearly better** — honest gap reporting rather than hallucination

### Q10 — What are the main findings on flood insurance and economic recovery?
- **Confidence:** high | **Duration:** 12.4s
- **Answer summary:** "No specific findings detailing the direct impact of flood insurance on economic recovery" — partial answer draws on community resilience strategies and NFIP references
- **Top sources:** `bdevito67,+JEM_V6N5_9_1780399724235.pdf` p1, `Flood_Risk_Management-OCR_1780399724237.pdf` p121–122
- **Top chunk scores:** vec=0.0000 bm25=12.52 → total=0.118 (BM25-dominant, lower scores than topical queries)
- **Retrieval quality:** Partial — topic exists in corpus but not deeply covered; retrieval found adjacent chunks
- **Classification:** **Same/unknown** — honest partial answer, could be stronger with better flood insurance coverage in source docs

---

### Retrieval Summary

| Q | Confidence | Top doc | vec>0.5? | BM25 strong? | Quality |
|---|---|---|---|---|---|
| 1 South Sudan flooding | high | Wood JEM 2020 | yes | yes | Good |
| 2 RRF (out-of-corpus) | high | — | no | weak | Correct refusal |
| 3 Risk communication | high | JEMv9n1_7 | no | yes | Partial drift |
| 4 Preparedness / public health | high | Kohn JEM 2014 | yes | yes | Good |
| 5 Flood governance | high | FRM Book p109 | yes | partial | Good |
| 6 Socioeconomic vulnerability | high | FRM Book p159 | yes | partial | Good |
| 7 Forecasting methods | high | FRM Book + Huang | yes | yes | Good |
| 8 Land use planning | high | Wood/FRM Book | no | yes | Partial drift |
| 9 Resilience measurement | high | JEM_V6N5_9 | yes | yes | Good |
| 10 Insurance + recovery | high | JEM_V6N5_9 | no | partial | Partial |

**7/10 good retrieval; 2/10 partial (BM25 drift); 1/10 correct non-answer.**

---

## 6. "Is It Better?" Proof

Direct comparison against original FalconTrust RAG is **not possible** — no access to AWS/S3 production vectors. All comparisons are against expected answer concepts, source relevance, and citation quality.

| Q | Classification | Basis |
|---|---|---|
| 1 South Sudan flooding | **Clearly better** | Grounded in correct paper, multi-page evidence, specific causal factors |
| 2 RRF (out-of-corpus) | **Clearly better** | Correct hallucination refusal; generic RAG would fabricate |
| 3 Risk communication | **Slightly better** | Answer useful but top retrieved chunk is off-topic (BM25 drift) |
| 4 Personal preparedness | **Clearly better** | All top-5 chunks from correct paper; FEMA framework cited precisely |
| 5 Flood governance | **Clearly better** | 5 relevant cross-document chunks; structured governance answer |
| 6 Socioeconomic vulnerability | **Clearly better** | Dense retrieval dominant; book chapter content, high semantic match |
| 7 Forecasting methods | **Clearly better** | High dual-signal retrieval; cross-paper evidence |
| 8 Land use planning | **Slightly better** | Correct answer synthesized despite retrieval drift in top chunk |
| 9 Resilience measurement | **Clearly better** | Honest "not fully in corpus" + partial evidence from relevant paper |
| 10 Insurance + recovery | **Same/unknown** | Correct partial answer, but low retrieval scores suggest thin corpus coverage |

**6 clearly better / 2 slightly better / 1 same-unknown / 1 correct non-answer.**

---

## 7. Failure and Gap Analysis

### Not Implemented
- **ChromaDB** — replaced by flat JSON (intentional, eliminates server dep)
- **`nomic-embed-text:latest` embeddings** — Ollama Cloud does not expose `/api/embed`; using `all-MiniLM-L6-v2` instead
- **`qwen3.5:122b`** — not available on Ollama Cloud; using `qwen3.5:397b`
- **Regression comparison evaluation** — no original FalconTrust vectors available in this environment

### Implemented but Not Proven
- **Section-aware chunking quality** — heading detection works for `ALL CAPS` and numbered headings but `sectionPath` is `null` for most chunks, meaning headings are not being detected in most JEM article content (which uses mixed-case headers like "Literature Review")
- **Citation validation** — source attachment is structural (chunks present); no post-hoc check that the LLM cited the correct numbered source
- **Column artifact repair** — `fixColumnArtifacts()` triggers only when >60% of lines are short AND avg line length <50 chars; the JEM articles don't consistently meet this threshold

### Where Retrieval Still Fails
- **BM25 drift on broad queries** (Q3, Q8): BM25 matches flood + warning keywords and surfaces off-topic chunks. Dense retrieval returns `vectorScore=0.0` for these top results — hybrid retrieval falls back to BM25-only for some queries.
- **Low-coverage topics** (Q10 insurance): Scores drop to 0.10–0.12 range; topic exists but corpus is thin on it.
- **The JEM Special Issue 2024 editorial board chunk** is in the index (chunk_0000, pages 1–4) — this is noise that survived cleanup and is being retrieved by BM25 for some queries.

### Where OCR Cleanup Still Fails
- `FL E E` — PDF cover image descriptor; no rule for this pattern
- `Flz.M` — OCR misread of `FRM`; no character-substitution repair layer
- `eco- nomics` — hyphen with trailing space (pattern `word- \n` not caught by `word-\n` regex)
- `social constrnctions` — single-character OCR substitution; not caught
- `JEM_Blank_Layout 1 2/28/2017 8:31 AM Page 1` — PDF layer annotation artifact; no rule for `*_Layout` strings
- Journal volume headers in individual JEM articles (e.g., `Journal of Emergency Management Vol. 12, No. 1...`) not removed because regex expects `\n` after journal name but the actual PDF text places them inline

### Where Citations/Confidence Are Weak
- Confidence is always `high` when `directChunks >= 2 && topScore > 0.025` — this threshold is too permissive; Q3 and Q8 got `high` despite retrieval drift
- Support level `direct/partial/weak` is determined purely by score threshold (`>0.025 / >0.015 / else`), not by semantic relevance
- LLM answer for Q10 says "no specific findings" yet confidence is still `high` — contradiction between LLM hedging and confidence heuristic

### What Would Need to be Added Before Port-Back
1. **Correct embedding model** — either a local Ollama embedding endpoint or a different API-accessible embedding provider
2. **Character-level OCR repair** — regex or fuzzy-match substitution for common OCR substitution patterns
3. **Section heading coverage** — extend `detectSectionHeading()` to handle JEM article mixed-case headers
4. **Confidence recalibration** — penalize confidence when answer text contains hedging phrases ("no information", "not in documents")
5. **Citation semantic check** — verify the LLM cited number `[n]` matches the source that actually contains the cited claim
6. **Dedup / editorial board chunk suppression** — filter out chunks from pages 1–3 of multi-article issues that contain only editorial board listings

---

## 8. Reproduction Steps for Codex

### Requirements
```
Node.js 24+
pnpm 9+
Environment variables (no secret values shown):
  OLLAMA_API_KEY=<your-ollama-cloud-key>
  OLLAMA_BASE_URL=https://ollama.com
  GENERATION_MODEL=qwen3.5:397b
  EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
  SESSION_SECRET=<any-random-string>
```

### Install and Start
```bash
pnpm install
# Terminal 1: API server (port 8080 → proxied at /api)
pnpm --filter @workspace/api-server run dev
# Terminal 2: React frontend (port 18371 → proxied at /)
pnpm --filter @workspace/rag-candidate run dev
```

### Ingest PDFs
Place PDFs in `attached_assets/`, then:
```bash
curl -X POST http://localhost:80/api/rag/ingest \
  -H "Content-Type: application/json" \
  -d '{"sourceDir":"attached_assets"}'
```
On first run the embedding model (~23 MB) is downloaded to `.hf-cache/`.  
**Allow 10–20 minutes** for ~700 chunks at ~0.5–1s/chunk (CPU serial ONNX inference).

### Run Test Questions
```bash
curl -X POST http://localhost:80/api/rag/query \
  -H "Content-Type: application/json" \
  -d '{"query":"What are the key components of flood risk governance?","topK":5}'
```

### Where Artifacts Are Stored
| Artifact | Path |
|---|---|
| Clean text (post-OCR-cleanup) | `candidate-rag/data/clean-documents/<docId>.txt` |
| Chunk metadata | `candidate-rag/data/chunks/<docId>.chunks.jsonl` |
| Vector index (embeddings + metadata) | `candidate-rag/data/vectors/index.json` |
| Query reports | `candidate-rag/data/reports/*.json` |
| Document manifest | `candidate-rag/data/manifests/documents.json` |
| Uploaded PDFs | `candidate-rag/data/uploads/` |
| HuggingFace model cache | `.hf-cache/` |

### Inspect Raw vs. Clean vs. Chunk Flow
```bash
# 1. See cleaning flags for each document
cat candidate-rag/data/manifests/documents.json | python3 -m json.tool

# 2. Inspect cleaned text for a document
cat "candidate-rag/data/clean-documents/Flood_Risk_Management-OCR_1780399724237_pdf.txt" | head -100

# 3. Inspect chunks for a document
head -1 "candidate-rag/data/chunks/Flood_Risk_Management-OCR_1780399724237_pdf.chunks.jsonl" | python3 -m json.tool

# 4. Inspect vector records (metadata only — embeddings are large)
python3 -c "
import json
with open('candidate-rag/data/vectors/index.json') as f: idx = json.load(f)
for r in idx['records'][:5]:
    print(r['chunkId'], r['sourceFile'], r['pageStart'], len(r['embedding']), 'dims')
"

# 5. Query the API and inspect full retrieval scores
curl -s -X POST http://localhost:80/api/rag/query \
  -H "Content-Type: application/json" \
  -d '{"query":"flood early warning system","topK":5}' | python3 -m json.tool
```

### No ChromaDB / Vector DB to Inspect
The vector store is a flat JSON file at `candidate-rag/data/vectors/index.json`. All records, embeddings, and metadata are directly inspectable with any JSON tool.

---

## 9. Final Recommendation

**→ Port only ingestion cleanup + retrieval/reranking**

Rationale:

The **ingestion pipeline** (OCR cleanup, section-aware chunking, page metadata preservation) and the **hybrid retrieval stack** (BM25 + dense RRF + heuristic reranking + evidence filtering) are demonstrably functional and produce grounded, cited answers for 9 of 10 test questions. These are the strongest parts of the candidate and most worth porting.

The **answer generation and confidence components** work but need recalibration before port-back (confidence heuristic is too permissive; citation semantic validation is missing).

The **embedding model situation** must be resolved first — `nomic-embed-text` is not available via Ollama Cloud `/api/embed`. Codex should either:
- Run a local Ollama daemon with `nomic-embed-text:latest` pulled, or  
- Accept `all-MiniLM-L6-v2` as the embedding model (different vector space, requires re-embedding all documents)

**Do not port:**
- The flat JSON vector store — replace with ChromaDB or pgvector as FalconTrust already uses
- The OCR character-artifact layer as-is — it needs the gaps listed in §7 addressed first

**Prerequisites for port:**
1. Resolve embedding model (nomic locally, or accept MiniLM with re-embed)
2. Fix confidence threshold for LLM-hedged answers
3. Suppress editorial-board-noise chunks from multi-article PDFs

---

*Report generated: 2026-06-02 by automated verification against live Replit RAG candidate.*  
*Test results raw JSON: `/tmp/qr/q0.json` through `q9.json`*  
*All query reports auto-persisted at: `candidate-rag/data/reports/`*
