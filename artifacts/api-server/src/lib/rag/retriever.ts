/**
 * Hybrid retrieval pipeline:
 * 1. Dense vector search (all-MiniLM-L6-v2)
 * 2. BM25 lexical search
 * 3. Exact phrase rescue
 * 4. RRF score fusion
 * 5. Heuristic reranking — evidence quality scoring + noise penalty
 * 6. Evidence quality filter — hard exclusion of high-noise chunks
 *    (unless query explicitly requests references/bibliography)
 * 7. Diversity-aware final selection — MMR-style greedy selection with
 *    soft penalties for source/section concentration within a score window
 */

import { embedQuery } from "./embeddings.js";
import { loadVectorIndex, vectorSearch } from "./vector-store.js";
import { bm25Search, exactPhraseSearch, tokenize } from "./bm25.js";
import {
  classifyChunkNoise,
  isReferenceQuery,
  NOISE_RERANK_PENALTY,
  NOISE_HARD_EXCLUSION_THRESHOLD,
  type ChunkCategory,
} from "./chunk-classifier.js";
import type { RetrievedChunk, VectorRecord } from "./types.js";

const RRF_K = 60;

// ── Diversity constants ────────────────────────────────────────────────────────

/**
 * Maximum chunks from a single source file before a penalty is applied.
 * Soft cap: the penalty may be overridden if no competitive alternative exists.
 */
const DIVERSITY_SOURCE_CAP = 3;

/**
 * Maximum chunks from the same (sourceFile × sectionPath) pair before a penalty.
 * Prevents four adjacent Literature Review chunks from the same article.
 */
const DIVERSITY_SECTION_CAP = 2;

/**
 * Diversity penalties are applied only when the candidate's score is at least
 * this fraction of the top candidate's score. Below this threshold the chunk
 * is already weak — don't force diversity by penalising weak evidence further.
 */
const DIVERSITY_FLOOR_FACTOR = 0.65;

/**
 * Score subtracted when a candidate would exceed DIVERSITY_SOURCE_CAP.
 * Large enough to prefer a competitive alternative, small enough not to
 * discard clearly superior evidence.
 */
const DIVERSITY_SOURCE_PENALTY = 0.05;

/**
 * Score subtracted when a candidate would exceed DIVERSITY_SECTION_CAP
 * (same source, same sectionPath). Applied in addition to source penalty.
 */
const DIVERSITY_SECTION_PENALTY = 0.03;

export interface RetrievalDebug {
  vectorCandidates: number;
  bm25Candidates: number;
  fusedCandidates: number;
  afterRerank: number;
  afterFilter: number;
  noiseExcluded: number;
  referenceQuery: boolean;
  diversityApplied: boolean;
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
      debug: {
        vectorCandidates: 0, bm25Candidates: 0, fusedCandidates: 0,
        afterRerank: 0, afterFilter: 0, noiseExcluded: 0,
        referenceQuery: false, diversityApplied: false,
      },
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

  // 5. Rerank with noise-aware scoring
  const refQuery = isReferenceQuery(query);
  const reranked = rerankResults(query, fused, refQuery);

  // 6. Evidence quality filter — hard exclusion of noise chunks
  const { kept, excluded } = filterWeakEvidence(reranked, refQuery);

  // 7. Diversity-aware final selection
  const diversified = diverseSelect(kept, topK, refQuery);
  const diversityApplied = diversified.some(
    (c, i) => i < kept.length && c.record.chunkId !== kept[i].record.chunkId
  );

  return {
    chunks: diversified.map((r) => recordToRetrievedChunk(r)),
    debug: {
      vectorCandidates: vectorResults.length,
      bm25Candidates: bm25Results.length,
      fusedCandidates: fused.length,
      afterRerank: reranked.length,
      afterFilter: kept.length,
      noiseExcluded: excluded,
      referenceQuery: refQuery,
      diversityApplied,
    },
  };
}

interface ScoredRecord {
  record: VectorRecord;
  score: number;
  vectorScore: number;
  bm25Score: number;
  rerankScore: number;
  noiseScore: number;
  noiseCategory: ChunkCategory;
}

function rrfFusion(
  vectorResults: { record: VectorRecord; score: number }[],
  bm25Results: { record: VectorRecord; score: number }[],
  exactResults: { record: VectorRecord; score: number }[]
): ScoredRecord[] {
  const scoreMap = new Map<string, ScoredRecord>();

  const vectorRankMap = new Map(vectorResults.map((r, i) => [r.record.chunkId, i]));
  const bm25RankMap = new Map(bm25Results.map((r, i) => [r.record.chunkId, i]));
  const vectorScoreMap = new Map(vectorResults.map((r) => [r.record.chunkId, r.score]));
  const bm25ScoreMap = new Map(bm25Results.map((r) => [r.record.chunkId, r.score]));

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
    const record = allRecordMap.get(id)!;

    scoreMap.set(id, {
      record,
      score: rrfScore + exactBonus,
      vectorScore: vectorScoreMap.get(id) ?? 0,
      bm25Score: bm25ScoreMap.get(id) ?? 0,
      rerankScore: 0,
      noiseScore: 0,
      noiseCategory: "useful-content",
    });
  }

  const results = Array.from(scoreMap.values());
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 30);
}

function rerankResults(
  query: string,
  candidates: ScoredRecord[],
  refQuery: boolean
): ScoredRecord[] {
  const queryTokens = new Set(tokenize(query));

  return candidates
    .map((c) => {
      let adjustment = 0;
      const text = c.record.text;
      const textLower = text.toLowerCase();
      const queryLower = query.toLowerCase();

      // Direct query match
      if (textLower.includes(queryLower)) adjustment += 0.2;

      // Token overlap
      const textTokens = new Set(tokenize(text));
      const overlap =
        [...queryTokens].filter((t) => textTokens.has(t)).length /
        Math.max(queryTokens.size, 1);
      adjustment += overlap * 0.15;

      // Penalize known bad cleaning flags
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

      // Noise classification — replaces the old isReferenceChunk() check
      const classification = classifyChunkNoise(text, c.record.sectionPath);
      const noisePenalty = refQuery ? 0 : NOISE_RERANK_PENALTY[classification.category];

      adjustment -= noisePenalty;

      // Reference query boost: actively surface bibliography/reference chunks
      // when the user is explicitly asking for references or citations.
      if (refQuery) {
        if (
          classification.category === "reference-list" ||
          classification.category === "bibliography"
        ) {
          adjustment += 0.22;
        } else if (classification.category === "citation-heavy") {
          adjustment += 0.08;
        }
      }

      // Communication query boost (Q3-style: risk communication, public
      // awareness, emergency messaging, flood warnings to the public).
      const isCommQuery =
        /\bcommunicat\w*|public.*risk|risk.*public|public.*warn\w*|public.*aware\w*|outreach|risk.*messag\w*|inform.*public|warn.*communit/i.test(
          query
        );
      if (isCommQuery) {
        const commTerms = [
          "communicat", "public", "awareness", "messaging",
          "outreach", "inform", "alert", "warn", "educat", "disseminat",
        ];
        const commHits = commTerms.filter((t) => textLower.includes(t)).length;
        if (commHits >= 2) adjustment += 0.08;
        if (commHits >= 3) adjustment += 0.05;
      }

      const rerankScore = adjustment;

      return {
        ...c,
        score: c.score + rerankScore * 0.5,
        rerankScore,
        noiseScore: classification.noiseScore,
        noiseCategory: classification.category,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function filterWeakEvidence(
  candidates: ScoredRecord[],
  refQuery: boolean
): { kept: ScoredRecord[]; excluded: number } {
  let excluded = 0;
  const kept = candidates.filter((c) => {
    // Must have source file
    if (!c.record.sourceFile) { excluded++; return false; }
    // Must have actual text content
    if (c.record.text.trim().length < 100) { excluded++; return false; }
    // Not mostly OCR garbage (very long "words" = gibberish)
    const words = c.record.text.split(/\s+/).length;
    const chars = c.record.text.length;
    if (chars / words > 20) { excluded++; return false; }

    // Hard exclusion of high-noise chunks (unless query is asking for references)
    if (!refQuery && c.noiseScore >= NOISE_HARD_EXCLUSION_THRESHOLD) {
      excluded++;
      return false;
    }

    return true;
  });
  return { kept, excluded };
}

/**
 * Diversity-aware greedy selection (step 7).
 *
 * At each step, selects the highest-scoring remaining candidate after applying
 * soft penalties for source and section concentration. Penalties only apply
 * when the candidate is within the score window (>= DIVERSITY_FLOOR_FACTOR of
 * the top score), ensuring weak evidence is never preferred over strong evidence
 * simply to force diversity.
 *
 * For reference queries (refQuery=true) the per-source cap is lifted so that
 * multiple bibliography chunks from the same document are allowed through —
 * this is the correct behaviour when the user explicitly asks "what references
 * are cited in the FRM book?"
 *
 * Safety: noise/reference filtering from step 6 is already applied — this
 * function only reorders within the clean candidate pool.
 */
function diverseSelect(
  candidates: ScoredRecord[],
  topK: number,
  refQuery: boolean
): ScoredRecord[] {
  if (candidates.length === 0 || topK === 0) return [];

  // For reference queries, don't cap any single source — the user wants all
  // references from that document. For content queries, keep the cap.
  const sourceCap = refQuery ? topK : DIVERSITY_SOURCE_CAP;

  const topScore = candidates[0].score;
  const diversityFloor = topScore * DIVERSITY_FLOOR_FACTOR;

  const pool = [...candidates];
  const selected: ScoredRecord[] = [];
  const sourceCounts = new Map<string, number>();
  const sectionCounts = new Map<string, number>();

  while (selected.length < topK && pool.length > 0) {
    let bestIdx = -1;
    let bestAdjusted = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const src = c.record.sourceFile;
      const sec = c.record.sectionPath;
      const secKey = sec ? `${src}\0${sec}` : null;

      const srcCount = sourceCounts.get(src) ?? 0;
      const secCount = secKey ? (sectionCounts.get(secKey) ?? 0) : 0;

      let penalty = 0;

      // Apply diversity penalties only within the score window
      if (c.score >= diversityFloor) {
        if (srcCount >= sourceCap) {
          penalty += DIVERSITY_SOURCE_PENALTY;
        }
        if (secKey !== null && secCount >= DIVERSITY_SECTION_CAP) {
          penalty += DIVERSITY_SECTION_PENALTY;
        }
      }

      const adjusted = c.score - penalty;

      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const best = pool.splice(bestIdx, 1)[0];
    selected.push(best);

    const src = best.record.sourceFile;
    const sec = best.record.sectionPath;
    const secKey = sec ? `${src}\0${sec}` : null;

    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
    if (secKey !== null) sectionCounts.set(secKey, (sectionCounts.get(secKey) ?? 0) + 1);
  }

  return selected;
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
    noiseScore: r.noiseScore,
    noiseCategory: r.noiseCategory,
    retrievalMethod: "hybrid-rrf",
  };
}
