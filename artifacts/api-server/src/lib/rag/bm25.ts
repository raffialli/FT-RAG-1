/**
 * BM25 lexical search implementation.
 * Used for hybrid retrieval alongside dense vector search.
 */

import type { VectorRecord } from "./types.js";

const K1 = 1.5;
const B = 0.75;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its",
  "they", "them", "their", "we", "our", "you", "your", "not", "no",
]);

export interface BM25Result {
  record: VectorRecord;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export function bm25Search(query: string, records: VectorRecord[], topK = 20): BM25Result[] {
  if (records.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Build corpus stats
  const corpusTokens = records.map((r) => tokenize(r.text));
  const avgDocLen = corpusTokens.reduce((s, t) => s + t.length, 0) / records.length;

  // IDF for each query token
  const idf = new Map<string, number>();
  for (const qt of queryTokens) {
    const docsWithTerm = corpusTokens.filter((tokens) => tokens.includes(qt)).length;
    if (docsWithTerm > 0) {
      idf.set(qt, Math.log((records.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1));
    }
  }

  // Score each document
  const scored = records.map((record, idx) => {
    const docTokens = corpusTokens[idx];
    const docLen = docTokens.length;
    let score = 0;

    for (const qt of queryTokens) {
      const tf = docTokens.filter((t) => t === qt).length;
      if (tf === 0) continue;

      const idfVal = idf.get(qt) ?? 0;
      const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / avgDocLen)));
      score += idfVal * tfNorm;
    }

    // Boost for exact phrase match
    const queryLower = query.toLowerCase();
    if (record.text.toLowerCase().includes(queryLower)) {
      score *= 1.5;
    }

    return { record, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((r) => r.score > 0).slice(0, topK);
}

export function exactPhraseSearch(query: string, records: VectorRecord[]): BM25Result[] {
  // Rescue exact phrases, proper nouns, quoted terms
  const lower = query.toLowerCase();
  const results: BM25Result[] = [];

  for (const record of records) {
    const textLower = record.text.toLowerCase();
    if (textLower.includes(lower)) {
      results.push({ record, score: 1.0 });
    } else {
      // Check for key entities from query
      const words = lower.split(/\s+/).filter((w) => w.length > 4);
      const matchCount = words.filter((w) => textLower.includes(w)).length;
      if (matchCount >= Math.ceil(words.length * 0.6)) {
        results.push({ record, score: matchCount / words.length });
      }
    }
  }

  return results;
}
