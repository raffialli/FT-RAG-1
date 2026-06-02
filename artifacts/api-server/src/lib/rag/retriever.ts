/**
 * Hybrid retrieval pipeline:
 * 1. Dense vector search (nomic-embed-text)
 * 2. BM25 lexical search
 * 3. Exact phrase rescue
 * 4. RRF score fusion
 * 5. Heuristic reranking (evidence quality scoring)
 * 6. Evidence quality filtering
 */

import { embedQuery } from "./embeddings.js";
import { loadVectorIndex, vectorSearch } from "./vector-store.js";
import { bm25Search, exactPhraseSearch, tokenize } from "./bm25.js";
import type { RetrievedChunk, VectorRecord } from "./types.js";

const RRF_K = 60; // RRF constant

export interface RetrievalDebug {
  vectorCandidates: number;
  bm25Candidates: number;
  fusedCandidates: number;
  afterRerank: number;
  afterFilter: number;
}

export async function hybridRetrieve(
  query: string,
  topK = 5
): Promise<{ chunks: RetrievedChunk[]; debug: RetrievalDebug }> {
  const index = loadVectorIndex();
  const allRecords = index.records;

  if (allRecords.length === 0) {
    return {
      chunks: [],
      debug: { vectorCandidates: 0, bm25Candidates: 0, fusedCandidates: 0, afterRerank: 0, afterFilter: 0 },
    };
  }

  // 1. Dense vector search
  const queryEmbedding = await embedQuery(query);
  const vectorResults = vectorSearch(queryEmbedding, 25);

  // 2. BM25 lexical search
  const bm25Results = bm25Search(query, allRecords, 25);

  // 3. Exact phrase rescue
  const exactResults = exactPhraseSearch(query, allRecords);

  // 4. RRF score fusion
  const fused = rrfFusion(
    vectorResults.map((r) => ({ record: r.record, score: r.score })),
    bm25Results.map((r) => ({ record: r.record, score: r.score })),
    exactResults
  );

  // 5. Rerank using evidence quality scoring
  const reranked = rerankResults(query, fused);

  // 6. Evidence quality filter
  const filtered = filterWeakEvidence(reranked);

  return {
    chunks: filtered.slice(0, topK).map((r) => recordToRetrievedChunk(r)),
    debug: {
      vectorCandidates: vectorResults.length,
      bm25Candidates: bm25Results.length,
      fusedCandidates: fused.length,
      afterRerank: reranked.length,
      afterFilter: filtered.length,
    },
  };
}

interface ScoredRecord {
  record: VectorRecord;
  score: number;
  vectorScore: number;
  bm25Score: number;
  rerankScore: number;
}

function rrfFusion(
  vectorResults: { record: VectorRecord; score: number }[],
  bm25Results: { record: VectorRecord; score: number }[],
  exactResults: { record: VectorRecord; score: number }[]
): ScoredRecord[] {
  const scoreMap = new Map<string, ScoredRecord>();

  // Build rank maps
  const vectorRankMap = new Map(vectorResults.map((r, i) => [r.record.chunkId, i]));
  const bm25RankMap = new Map(bm25Results.map((r, i) => [r.record.chunkId, i]));
  const vectorScoreMap = new Map(vectorResults.map((r) => [r.record.chunkId, r.score]));
  const bm25ScoreMap = new Map(bm25Results.map((r) => [r.record.chunkId, r.score]));

  // All candidates
  const allIds = new Set([
    ...vectorResults.map((r) => r.record.chunkId),
    ...bm25Results.map((r) => r.record.chunkId),
    ...exactResults.map((r) => r.record.chunkId),
  ]);

  const allRecordMap = new Map<string, VectorRecord>();
  for (const r of [...vectorResults, ...bm25Results, ...exactResults]) {
    allRecordMap.set(r.record.chunkId, r.record);
  }

  for (const id of allIds) {
    const vRank = vectorRankMap.has(id) ? vectorRankMap.get(id)! : vectorResults.length;
    const bRank = bm25RankMap.has(id) ? bm25RankMap.get(id)! : bm25Results.length;

    const rrfScore = 1 / (RRF_K + vRank) + 1 / (RRF_K + bRank);
    const exactBonus = exactResults.find((r) => r.record.chunkId === id) ? 0.15 : 0;

    scoreMap.set(id, {
      record: allRecordMap.get(id)!,
      score: rrfScore + exactBonus,
      vectorScore: vectorScoreMap.get(id) ?? 0,
      bm25Score: bm25ScoreMap.get(id) ?? 0,
      rerankScore: 0,
    });
  }

  const results = Array.from(scoreMap.values());
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 30);
}

function rerankResults(query: string, candidates: ScoredRecord[]): ScoredRecord[] {
  const queryTokens = new Set(tokenize(query));

  return candidates
    .map((c) => {
      let adjustment = 0;
      const text = c.record.text;
      const textLower = text.toLowerCase();
      const queryLower = query.toLowerCase();

      // Direct answer indicators
      if (textLower.includes(queryLower)) adjustment += 0.2;

      // Token overlap quality
      const textTokens = new Set(tokenize(text));
      const overlap = [...queryTokens].filter((t) => textTokens.has(t)).length / Math.max(queryTokens.size, 1);
      adjustment += overlap * 0.15;

      // Penalize OCR/frontmatter flags
      const badFlags = c.record.cleaningFlags.filter((f) =>
        ["frontmatter-copyright-penalty", "journal-frontmatter-ad-penalty"].includes(f)
      ).length;
      adjustment -= badFlags * 0.1;

      // Length quality: prefer substantial chunks
      if (text.length > 500 && text.length < 3500) adjustment += 0.05;
      if (text.length < 200) adjustment -= 0.1;

      // Page metadata completeness
      if (c.record.pageStart > 0) adjustment += 0.03;
      if (c.record.sectionPath) adjustment += 0.02;

      // Penalize reference-like chunks
      if (isReferenceChunk(text)) adjustment -= 0.3;

      const rerankScore = adjustment;

      return {
        ...c,
        score: c.score + rerankScore * 0.5,
        rerankScore,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function filterWeakEvidence(candidates: ScoredRecord[]): ScoredRecord[] {
  return candidates.filter((c) => {
    // Must have source file
    if (!c.record.sourceFile) return false;
    // Must have actual text content
    if (c.record.text.trim().length < 100) return false;
    // Not mostly OCR garbage (very low word density)
    const words = c.record.text.split(/\s+/).length;
    const chars = c.record.text.length;
    if (chars / words > 20) return false; // very long "words" = gibberish
    return true;
  });
}

function isReferenceChunk(text: string): boolean {
  const lines = text.trim().split("\n");
  const refLines = lines.filter((l) => /^\s*\d+\.\s+[A-Z]/.test(l) || /^\[\d+\]/.test(l)).length;
  return refLines / (lines.length || 1) > 0.4;
}

function recordToRetrievedChunk(r: ScoredRecord): RetrievedChunk {
  return {
    chunkId: r.record.chunkId,
    documentId: r.record.documentId,
    sourceFile: r.record.sourceFile,
    pageStart: r.record.pageStart,
    pageEnd: r.record.pageEnd,
    sectionPath: r.record.sectionPath,
    text: r.record.text,
    cleaningFlags: r.record.cleaningFlags,
    qualityNotes: [],
    score: r.score,
    vectorScore: r.vectorScore,
    bm25Score: r.bm25Score,
    rerankScore: r.rerankScore,
    retrievalMethod: "hybrid-rrf",
  };
}
