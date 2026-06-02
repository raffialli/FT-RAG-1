/**
 * Flat JSON vector store with cosine similarity.
 * For ~1000 chunks (9 PDFs) this is fast enough (<100ms).
 * Each record stores the embedding + chunk metadata.
 */

import fs from "node:fs";
import path from "node:path";
import type { RagChunk, VectorIndex, VectorRecord } from "./types.js";

const DATA_DIR = process.env.RAG_DATA_DIR ?? path.join(process.cwd(), "candidate-rag", "data");
const VECTOR_INDEX_PATH = path.join(DATA_DIR, "vectors", "index.json");
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text:latest";

let _cachedIndex: VectorIndex | null = null;

export function getVectorIndexPath() {
  return VECTOR_INDEX_PATH;
}

export function loadVectorIndex(): VectorIndex {
  if (_cachedIndex) return _cachedIndex;

  if (!fs.existsSync(VECTOR_INDEX_PATH)) {
    return { version: 1, embeddingModel: EMBEDDING_MODEL, updatedAt: "", records: [] };
  }

  try {
    const raw = fs.readFileSync(VECTOR_INDEX_PATH, "utf8");
    _cachedIndex = JSON.parse(raw) as VectorIndex;
    return _cachedIndex;
  } catch {
    return { version: 1, embeddingModel: EMBEDDING_MODEL, updatedAt: "", records: [] };
  }
}

export function saveVectorIndex(index: VectorIndex): void {
  fs.mkdirSync(path.dirname(VECTOR_INDEX_PATH), { recursive: true });
  fs.writeFileSync(VECTOR_INDEX_PATH, JSON.stringify(index, null, 2));
  _cachedIndex = index;
}

export function invalidateCache(): void {
  _cachedIndex = null;
}

export function addOrUpdateRecords(chunks: RagChunk[], embeddings: number[][]): VectorIndex {
  const index = loadVectorIndex();

  const existingIds = new Set(index.records.map((r) => r.chunkId));

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];

    if (existingIds.has(chunk.chunkId)) {
      const idx = index.records.findIndex((r) => r.chunkId === chunk.chunkId);
      if (idx !== -1) {
        index.records[idx] = { ...chunkToRecord(chunk), embedding };
      }
    } else {
      index.records.push({ ...chunkToRecord(chunk), embedding });
    }
  }

  index.updatedAt = new Date().toISOString();
  index.embeddingModel = EMBEDDING_MODEL;
  saveVectorIndex(index);
  return index;
}

export function removeDocumentRecords(documentId: string): void {
  const index = loadVectorIndex();
  index.records = index.records.filter((r) => r.documentId !== documentId);
  index.updatedAt = new Date().toISOString();
  saveVectorIndex(index);
}

export function resetVectorIndex(): void {
  const emptyIndex: VectorIndex = {
    version: 1,
    embeddingModel: EMBEDDING_MODEL,
    updatedAt: new Date().toISOString(),
    records: [],
  };
  saveVectorIndex(emptyIndex);
  invalidateCache();
}

export interface VectorSearchResult {
  record: VectorRecord;
  score: number;
}

export function vectorSearch(queryEmbedding: number[], topK = 20): VectorSearchResult[] {
  const index = loadVectorIndex();
  if (index.records.length === 0) return [];

  const scored = index.records.map((record) => ({
    record,
    score: cosineSimilarity(queryEmbedding, record.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function chunkToRecord(chunk: RagChunk): Omit<VectorRecord, "embedding"> {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    sourceFile: chunk.sourceFile,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    sectionPath: chunk.sectionPath,
    text: chunk.text,
    cleaningFlags: chunk.cleaningFlags,
  };
}
