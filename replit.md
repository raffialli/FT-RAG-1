# FalconTrust RAG Candidate

Experimental RAG pipeline for FalconTrust — hybrid dense+BM25 retrieval, reranking, and Ollama Cloud LLM with grounded citations.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080 → proxied at `/api`)
- `pnpm --filter @workspace/rag-candidate run dev` — run the React frontend (port 18371 → proxied at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `GENERATION_MODEL`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (`artifacts/api-server`)
- Frontend: React + Vite + Tailwind + shadcn/ui (`artifacts/rag-candidate`)
- DB: PostgreSQL + Drizzle ORM (available but not used by RAG — RAG uses flat JSON files)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- PDF parsing: `pdf-parse@1.1.1` (Node.js native, no browser deps)
- Embeddings: Ollama Cloud `/api/embed` (nomic-embed-text:latest)
- Generation: Ollama Cloud `/api/generate` (qwen3.5:122b)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI source of truth for all RAG endpoints
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/api-zod/src/generated/` — generated Zod schemas
- `artifacts/api-server/src/lib/rag/` — full RAG pipeline:
  - `types.ts` — shared types
  - `ocr-cleaner.ts` — PDF/OCR text cleanup
  - `chunker.ts` — section-aware chunking
  - `embeddings.ts` — Ollama embed + generate HTTP calls
  - `vector-store.ts` — flat JSON cosine similarity vector store
  - `bm25.ts` — BM25 lexical search
  - `retriever.ts` — hybrid RRF fusion + reranking
  - `answer-gen.ts` — grounded answer synthesis
  - `ingester.ts` — full ingest pipeline (PDF → clean → chunk → embed → store)
  - `reports.ts` — query report persistence
- `artifacts/api-server/src/routes/rag.ts` — all RAG HTTP routes
- `artifacts/rag-candidate/src/` — React UI (5 tabs: Query, Ingest, Documents, Reports, Models)
- `candidate-rag/data/` — runtime data (uploads, clean-documents, chunks, vectors, reports)
- `attached_assets/` — source PDFs (9 JEM journal articles + flood risk book)

## Architecture decisions

- **Flat JSON vector store instead of ChromaDB**: eliminates server dependency; fast enough for ~1000 chunks from 9 PDFs (sub-100ms cosine similarity search).
- **pdf-parse@1.1.1** (not v2): v2 imports pdfjs-dist browser APIs (`DOMMatrix`) that crash in Node.js; v1 is pure Node.js.
- **RRF (Reciprocal Rank Fusion)** for hybrid score fusion: more robust than weighted sum since it normalizes ranks from different scoring systems.
- **Heuristic reranking** (token overlap + length + OCR penalty) before sending to LLM: avoids expensive per-chunk LLM scoring while still improving result order.
- **All Orval `query` options require `queryKey`** in TanStack Query v5: always pass `queryKey: get*QueryKey()` when providing `query` options to generated hooks.

## Product

A full RAG research pipeline for flood-risk and emergency-management PDFs:
1. **Ingest tab** — ingest source PDFs from `attached_assets/` or upload new ones; shows OCR cleaning flags, chunk/vector counts
2. **Query tab** — hybrid retrieval query with grounded answer, confidence rating, per-source citations with page numbers, and expandable evidence chunks showing RRF/vector/BM25 scores
3. **Documents tab** — browse all ingested docs, inspect chunks with page + section metadata
4. **Reports tab** — all past queries auto-saved with confidence stats and classification
5. **Models tab** — connectivity test for embedding and generation models

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **pdf-parse v2 crashes on startup**: uses pdfjs-dist with browser Canvas APIs. Always use `pdf-parse@1.1.1`.
- **Ollama Cloud base URL**: set to `https://ollama.com`; API calls go to `{base}/api/embed` and `{base}/api/generate`. If embeddings fail, try `https://api.ollama.com`.
- **TanStack Query v5 + Orval**: generated hooks' `query` parameter takes full `UseQueryOptions` which requires `queryKey`. Always include `queryKey: get*QueryKey()` when passing custom query options.
- **Ingestion is slow for large PDFs**: embeddings are batched in groups of 8 with sequential Ollama calls. For 9 PDFs ~200+ chunks, expect 5–15 minutes if Ollama is remote.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
