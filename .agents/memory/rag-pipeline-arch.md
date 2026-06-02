---
name: FalconTrust RAG candidate pipeline architecture
description: Key architectural decisions for the hybrid RAG pipeline — flat JSON store, RRF fusion, pdf-parse v1, Ollama Cloud endpoints.
---

## Architecture overview

Built in `artifacts/api-server/src/lib/rag/` as a pure Node.js pipeline (no Python, no ChromaDB server).

## Key decisions

**Flat JSON vector store instead of ChromaDB**
- Why: ChromaDB requires a Python server process. Flat JSON with cosine similarity is fast enough for ~1000 chunks from 9 PDFs (<50ms search).
- File: `candidate-rag/data/vectors/index.json` — cached in memory after first load.

**Hybrid retrieval (dense + BM25) with RRF fusion**
- Dense: `POST {OLLAMA_BASE_URL}/api/embed` → cosine similarity top-25
- Lexical: BM25 scoring (`bm25.ts`) → top-25 + exact phrase rescue
- Fusion: Reciprocal Rank Fusion with k=60 constant
- Reranking: heuristic score adjustments (token overlap, length, OCR penalties, page completeness)

**Ollama Cloud endpoints**
- Base URL: `OLLAMA_BASE_URL` (default `https://ollama.com`)
- Embeddings: `POST {base}/api/embed` with `{ model, input: text }` → `{ embeddings: [[...]] }`
- Generation: `POST {base}/api/generate` with `{ model, prompt, stream: false }` → `{ response: "..." }`
- Auth: `Authorization: Bearer {OLLAMA_API_KEY}` header

**pdf-parse v1.1.1** — see `pdf-parse-nodejs.md`

**Data layout**
- `candidate-rag/data/uploads/` — user-uploaded PDFs
- `candidate-rag/data/clean-documents/` — OCR-cleaned text
- `candidate-rag/data/chunks/` — JSONL chunk files per document
- `candidate-rag/data/vectors/index.json` — vector index
- `candidate-rag/data/reports/` — saved query reports
- `attached_assets/*.pdf` — 9 source PDFs (auto-discovered at ingest time)
