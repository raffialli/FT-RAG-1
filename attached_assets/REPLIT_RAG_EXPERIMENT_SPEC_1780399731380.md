# FalconTrust Replit Experimental RAG Candidate Spec

## Mission

Build a clickable, Replit-hosted experimental FalconTrust RAG candidate app that produces significantly better retrieval, answer generation, source citations, and OCR-clean ingestion than the current FalconTrust RAG pipeline.

This is a parallel experimental candidate, not a production replacement.

You are being given:

* a zipped copy of the current FalconTrust `main` branch
* the nine real source PDF/documents
* Ollama Cloud model access through environment variables/secrets
* this spec

Primary objective:

> Build a better RAG app that can ingest messy OCR PDFs, clean/flatten them before embedding, retrieve better evidence, synthesize better answers, and show cleaner citations/sources in a UI we can test directly inside Replit.

## Required models

Use Ollama Cloud.

Embedding model:

```text
nomic-embed-text:latest
```

Answer generation model:

```text
qwen3.5:122b
```

Expected environment variables:

```text
OLLAMA_API_KEY=...
OLLAMA_BASE_URL=...
EMBEDDING_MODEL=nomic-embed-text:latest
GENERATION_MODEL=qwen3.5:122b
```

Do not commit API keys, secrets, `.env` files, or credentials.

If the API key is provided in the Replit prompt temporarily, immediately move it into environment variables/secrets and remove it from code, logs, and committed files.

## Important AWS boundary

You do not have AWS access.

Do not use AWS.

Do not use S3.

Do not inspect S3.

Do not request AWS credentials.

Do not use existing FalconTrust vectors.

Do not use Dev, Staging, or Demo data.

Do not deploy to Dev, Staging, or Demo.

Do not reindex any existing FalconTrust environment.

The current production embeddings/vector files are out of scope unless separately provided as read-only local files. For this experiment, assume you only have the repo code and the nine source documents.

You may inspect the codebase to understand how the current FalconTrust app appears to do ingestion, embeddings, retrieval, and citation display, but do not claim to have verified the live AWS/S3 state.

## Desired final output

Produce a working Replit app we can click and test.

The app should support:

* ingesting the provided nine PDFs
* uploading and ingesting new PDFs from the UI
* asking questions against the ingested corpus
* showing the generated answer
* showing source citations
* showing source snippets
* showing page/source metadata
* showing confidence or evidence quality
* showing retrieved chunks/evidence for review
* rebuilding/re-ingesting the corpus when needed

Preferred UI approach:

1. First preference: fork/adapt the FalconTrust UI so the candidate feels close to the existing app.
2. Acceptable fallback: build a simpler testing UI if that is faster or better for proving RAG quality.

The RAG quality matters more than matching the existing UI exactly.

## Freedom to redesign

You may rewrite the RAG pipeline if needed.

You may use a framework such as LangChain, LlamaIndex, Chroma integrations, or custom code if it helps.

However:

* keep the existing FalconTrust code available
* do not remove current working behavior unnecessarily
* keep the candidate pipeline isolated and understandable
* document what you changed and why
* prefer working, testable quality improvements over broad rewrites with no proof

## Local vector store

Use local Chroma/ChromaDB for the candidate vector store unless you find a strong reason not to.

The vector store must be:

* local to the Replit project/environment
* rebuildable from uploaded PDFs
* separate from any production data
* inspectable enough for debugging
* documented in the final report

Suggested local structure:

```text
candidate-rag/
  data/
    uploads/
    clean-documents/
    chunks/
    chroma/
    reports/
    manifests/
```

Do not mix AWS-generated vectors with Nomic-generated vectors.

Do not compare raw vector scores across different embedding models.

## Candidate RAG pipeline requirements

Build this pipeline:

```text
PDF ingestion
→ OCR/layout cleanup
→ remove frontmatter/index/ads/references/noise
→ preserve page/section metadata
→ semantic/section-aware chunking
→ embedding with nomic-embed-text:latest
→ local Chroma vector storage
→ hybrid retrieval
→ reranking
→ evidence quality filtering
→ answer synthesis with qwen3.5:122b
→ citation/confidence validation
→ regression/comparison reporting
```

## PDF ingestion and OCR/layout cleanup

The ingestion pipeline must clean and flatten messy OCR/layout PDFs before embedding.

Handle:

* OCR artifacts
* multi-column ordering issues where possible
* broken line wrapping
* broken hyphenation
* repeated headers
* repeated footers
* page numbers
* duplicated text
* frontmatter
* table of contents
* index pages
* ads
* references/bibliographies where they pollute retrieval
* boilerplate repeated across pages
* weird citation artifacts

Preserve:

* source filename
* document ID
* page number
* page span
* section heading
* subsection heading
* cleaned text
* original extracted text or enough reference to audit
* cleanup warnings when uncertain

Produce clean intermediate files before embedding:

```text
clean-document.md
clean-document.json
chunks.jsonl
manifest.json
```

## Chunking

Use semantic or section-aware chunking.

Requirements:

* prefer natural section/subsection boundaries
* avoid cutting sentences in half
* preserve page spans
* preserve source file
* preserve section path
* avoid chunks that are mostly noise
* avoid chunks that are only references/index/ads
* create stable chunk IDs
* store chunk metadata with each vector

Each chunk should include:

```json
{
  "chunk_id": "...",
  "document_id": "...",
  "source_file": "...",
  "page_start": 1,
  "page_end": 2,
  "section_path": "...",
  "text": "...",
  "cleaning_flags": [],
  "quality_notes": []
}
```

## Retrieval

Implement better retrieval than naive vector search.

Use:

* vector retrieval from Chroma
* keyword/lexical matching
* exact phrase rescue for names, campaigns, agencies, titles, and proper nouns
* metadata-aware boosts
* reranking

Hybrid retrieval should improve the chance that the right evidence appears in the top results.

## Reranking

After initial retrieval, rerank results based on evidence quality.

Favor chunks that:

* directly answer the question
* contain key terms/entities from the question
* have good page/source metadata
* are clean and readable
* are not OCR garbage
* are not references/index/ads
* support citation display

Penalize chunks that:

* are boilerplate
* are OCR noise
* are unrelated neighboring text
* have missing metadata
* are too short or too fragmented
* are only references or index text

## Evidence quality filtering

Before answer generation, filter weak evidence.

Do not present a confident grounded answer if evidence is weak.

Reject or downgrade evidence when:

* source metadata is missing
* page number is unknown
* snippet does not support the answer
* chunk is mostly OCR noise
* chunk is mostly references/index/ads
* chunk barely overlaps with the question
* source is too weak to cite

If there is not enough evidence, the app should say so clearly.

## Answer generation

Use `qwen3.5:122b`.

Answer requirements:

* clear answer first
* grounded only in retrieved evidence
* no unsupported claims
* no fake citations
* no invented page numbers
* no 0-source grounded answers
* clean citations
* clean source snippets
* confidence based on evidence quality

Use low temperature for repeatability.

Recommended answer object:

```json
{
  "answer": "...",
  "confidence": "high|medium|low|insufficient",
  "confidence_reason": "...",
  "sources": [
    {
      "source_file": "...",
      "page_start": 1,
      "page_end": 2,
      "section_path": "...",
      "snippet": "...",
      "support_level": "direct|partial|weak"
    }
  ],
  "warnings": []
}
```

## UI requirements

The Replit app should let us:

* upload PDFs
* trigger ingestion/rebuild
* see ingestion status
* ask questions
* see answer
* see confidence
* see citations/sources
* see source snippets
* see page numbers
* see retrieved chunks/evidence
* see warnings when evidence is weak
* test the nine provided PDFs
* test newly uploaded PDFs

Useful UI sections:

* Documents/Ingestion
* Ask a Question
* Answer
* Sources
* Retrieved Evidence
* Cleanup/Index Status
* Comparison/Report

## Evaluation and comparison

Produce a side-by-side report showing whether the candidate improved.

Since you do not have AWS access or existing production vectors, comparison should be based on:

* current code behavior where runnable locally
* known baseline behavior from existing app/code if available
* manually captured baseline outputs if provided
* candidate outputs from the new Replit app
* before/after chunk cleanliness
* before/after source quality
* before/after citation quality
* answer quality on test questions

Do not claim a global improvement unless the report proves it.

The comparison report must include:

* question
* candidate answer
* candidate sources
* candidate confidence
* retrieved chunks
* evidence quality notes
* exact files/code paths involved
* why the result is better/worse/inconclusive
* screenshots or saved JSON outputs where helpful

Classify each test:

```text
candidate clearly better
candidate slightly better
no material change
candidate worse
inconclusive
```

## Proof requirement

Every improvement claim must point to proof.

For each major claim, include at least one of:

* exact code file path
* exact function/module changed
* generated report path
* saved output JSON
* screenshot
* before/after cleaned text example
* before/after retrieved chunk example
* test question result
* source/citation example

The final report should be strong enough for Codex to review and verify whether the improvement is real.

## Required reports

Create reports under:

```text
docs/rag-experiments/replit-rag-candidate/
```

Required files:

```text
00-current-code-observations.md
01-candidate-architecture.md
02-ingestion-cleanup-report.md
03-vector-store-and-models.md
04-retrieval-reranking-report.md
05-answer-citation-confidence-report.md
06-side-by-side-comparison.md
07-runbook.md
08-known-gaps-and-next-steps.md
```

Each report should clearly separate:

* proven
* inferred
* not tested
* known gap
* recommended next step

## Stop and ask before

Stop and ask before:

* requesting AWS access
* using S3
* deploying anywhere
* touching Dev/Staging/Demo
* changing production defaults
* removing current app behavior
* committing secrets
* adding paid services beyond provided Ollama Cloud use
* using a non-local external vector database
* making irreversible data changes
* making changes that would be hard to reverse
* skipping the clickable app requirement

## Acceptance criteria

This lane is successful when:

* Replit app runs and is clickable
* provided nine PDFs can be ingested
* new PDFs can be uploaded and ingested
* text is cleaned before embedding
* chunks preserve page/source/section metadata
* embeddings are generated with `nomic-embed-text:latest`
* vectors are stored locally in Chroma
* questions can be asked through the UI
* answers are generated with `qwen3.5:122b`
* answers include clean citations/sources
* retrieved chunks are visible for review
* weak evidence is handled honestly
* side-by-side comparison report exists
* improvement claims include proof
* no AWS/S3/Dev/Staging/Demo access was used
* no secrets were committed
* final handoff includes commands, changed files, reports, and known gaps

## Final handoff

At completion, provide:

* app URL / Replit run instructions
* branch name
* commit list
* changed files summary
* exact commands run
* exact env vars required, without secret values
* model smoke test result
* ingestion test result
* question-answer test result
* report file paths
* known gaps
* recommendation on whether this candidate is worth Codex reviewing/porting back

Final recommendation should be one of:

```text
continue candidate
Codex should review for port-back
merge selected ingestion pieces only
merge selected retrieval pieces only
needs more testing
abandon candidate
```
