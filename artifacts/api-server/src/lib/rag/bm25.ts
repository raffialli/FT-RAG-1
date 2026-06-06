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

const IMPORTANT_SHORT_TOKENS = new Set(["mw", "m", "km"]);

export interface BM25Result {
  record: VectorRecord;
  score: number;
}

export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");
}

export function tokenize(text: string): string[] {
  const normalized = normalizeForSearch(text);
  const rawTokens = normalized.match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? [];
  const tokens: string[] = [];

  for (const rawToken of rawTokens) {
    for (const token of expandToken(rawToken)) {
      if (STOP_WORDS.has(token)) continue;
      if (token.length > 2 || IMPORTANT_SHORT_TOKENS.has(token) || /\d/.test(token)) {
        tokens.push(token);
      }
    }
  }

  return tokens;
}

function expandToken(rawToken: string): string[] {
  const expanded = new Set<string>();
  const add = (token: string) => {
    const clean = token.trim();
    if (!clean) return;
    expanded.add(clean);
    expanded.add(stemToken(clean));
  };

  add(rawToken);
  for (const part of rawToken.split(/[.-]/)) add(part);

  if (rawToken === "mw") {
    add("magnitude");
    add("moment-magnitude");
  }
  if (rawToken === "magnitude" || rawToken === "magnitudes") add("mw");
  if (rawToken === "earthquake" || rawToken === "earthquakes") add("quake");
  if (rawToken === "quake" || rawToken === "quakes") add("earthquake");
  if (rawToken === "location" || rawToken === "locations") {
    add("place");
    add("city");
    add("district");
    add("zone");
  }

  return [...expanded];
}

function stemToken(token: string): string {
  if (/\d/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && /(ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
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
    const queryLower = normalizeForSearch(query);
    if (normalizeForSearch(record.text).includes(queryLower)) {
      score *= 1.5;
    }

    return { record, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((r) => r.score > 0).slice(0, topK);
}

export function exactPhraseSearch(query: string, records: VectorRecord[]): BM25Result[] {
  // Rescue exact phrases, proper nouns, quoted terms
  const lower = normalizeForSearch(query);
  const queryTokens = tokenize(query);
  const results: BM25Result[] = [];

  for (const record of records) {
    const textLower = normalizeForSearch(record.text);
    if (textLower.includes(lower)) {
      results.push({ record, score: 1.0 });
    } else {
      // Check for key entities from query
      const words = queryTokens.filter((w) => w.length > 3 || /\d/.test(w));
      const matchCount = words.filter((w) => textLower.includes(w)).length;
      const requiredMatches = Math.max(2, Math.min(4, Math.ceil(words.length * 0.5)));
      if (matchCount >= requiredMatches) {
        results.push({ record, score: matchCount / words.length });
      }
    }
  }

  return results;
}

export function matchesNormalizedSearch(search: string, values: Array<string | null | undefined>): boolean {
  const normalizedSearch = normalizeForSearch(search).trim();
  if (!normalizedSearch) return true;

  const haystack = normalizeForSearch(values.filter(Boolean).join(" "));
  if (haystack.includes(normalizedSearch)) return true;

  const asksForEvent = /\bearthquakes?|quakes?|floods?|storms?|hurricanes?|wildfires?|disasters?\b/.test(normalizedSearch);
  const asksForMagnitude = /\bmagnitudes?|mw|richter\b/.test(normalizedSearch);
  const hasEvent = /\bearthquakes?|quakes?|floods?|storms?|hurricanes?|wildfires?|disasters?\b/.test(haystack);
  const hasMagnitudeEvidence = /\bmw\b|\bmagnitude\b|\b\d+(?:\.\d+)?\b/.test(haystack);
  if (asksForEvent && asksForMagnitude && hasEvent && hasMagnitudeEvidence) {
    return true;
  }

  const queryTokens = [...new Set(tokenize(search).filter((token) => token.length > 2 || /\d/.test(token)))];
  if (queryTokens.length === 0) return false;

  const haystackTokens = new Set(tokenize(haystack));
  const matchCount = queryTokens.filter((token) =>
    haystackTokens.has(token) || haystack.includes(token)
  ).length;
  const requiredMatches = Math.max(2, Math.min(4, Math.ceil(queryTokens.length * 0.5)));
  return matchCount >= requiredMatches;
}
