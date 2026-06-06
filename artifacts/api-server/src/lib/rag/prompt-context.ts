import crypto from "node:crypto";
import type { RetrievedChunk } from "./types.js";
import type { PromptExcerptTrace } from "./rag-trace.js";

export const EXCERPT_CHARS = 1400;
const WINDOW_STEP_CHARS = 350;

export function buildEvidenceBlock(query: string, chunks: RetrievedChunk[]): string {
  return buildEvidenceBlockWithMetadata(query, chunks).evidenceBlock;
}

export function buildEvidenceBlockWithMetadata(
  query: string,
  chunks: RetrievedChunk[],
  options: { includeFullText?: boolean } = {}
): { evidenceBlock: string; selectedExcerpts: PromptExcerptTrace[] } {
  const selectedExcerpts: PromptExcerptTrace[] = [];
  const evidenceBlock = chunks
    .map((c, i) => {
      const pageRange =
        c.pageStart === c.pageEnd ? `p. ${c.pageStart}` : `pp. ${c.pageStart}-${c.pageEnd}`;
      const section = c.sectionPath ? ` § ${c.sectionPath}` : "";
      const excerpt = selectRelevantExcerpt(query, c.text, EXCERPT_CHARS);
      selectedExcerpts.push({
        citationIndex: i + 1,
        chunkId: c.chunkId,
        sourceFile: c.sourceFile,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        sectionPath: c.sectionPath,
        excerptChars: excerpt.length,
        excerptHash: hashText(excerpt),
        excerptPreview: preview(excerpt),
        excerpt: options.includeFullText ? excerpt : undefined,
      });
      return `[${i + 1}] Source: ${c.sourceFile} (${pageRange}${section})\n${excerpt}`;
    })
    .join("\n\n---\n\n");
  return { evidenceBlock, selectedExcerpts };
}

export function selectRelevantExcerpt(
  query: string,
  text: string,
  maxChars = EXCERPT_CHARS
): string {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (cleanText.length <= maxChars) return cleanText;

  const queryTokens = new Set(tokenize(query));
  const attributeTerms = buildAttributeTerms(query);
  let bestStart = 0;
  let bestScore = -Infinity;

  for (let start = 0; start < cleanText.length; start += WINDOW_STEP_CHARS) {
    const window = cleanText.slice(start, start + maxChars);
    const score = scoreWindow(window, queryTokens, attributeTerms, start);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
    if (start + maxChars >= cleanText.length) break;
  }

  const adjustedStart = clampToWordBoundary(cleanText, bestStart);
  let excerpt = cleanText.slice(adjustedStart, adjustedStart + maxChars).trim();
  excerpt = excerpt.replace(/\s+\S*$/, "").trim();
  if (adjustedStart > 0) excerpt = `... ${excerpt}`;
  if (adjustedStart + maxChars < cleanText.length) excerpt = `${excerpt} ...`;
  return excerpt;
}

function buildAttributeTerms(query: string): Set<string> {
  const normalized = normalizeForSearch(query);
  const terms = new Set<string>();

  if (/\bmagnitude|mw|richter\b/.test(normalized)) {
    for (const term of ["mw", "magnitude", "moment magnitude"]) terms.add(term);
  }
  if (/\blocation|place|where|city|district|region|zone\b/.test(normalized)) {
    for (const term of ["location", "city", "district", "region", "zone", "province"]) {
      terms.add(term);
    }
  }
  if (/\btwo|main|primary|principal|discussed\b/.test(normalized)) {
    for (const term of ["two", "main", "primary", "discussed"]) terms.add(term);
  }

  return terms;
}

function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");
}

function tokenize(text: string): string[] {
  const stopWords = new Set([
    "the", "and", "or", "but", "what", "were", "was", "are", "including",
    "their", "with", "from", "that", "this", "main", "two", "discussed",
  ]);
  return (normalizeForSearch(text).match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? [])
    .flatMap((token) => {
      const tokens = new Set([token, stemToken(token)]);
      if (token === "magnitudes" || token === "magnitude") tokens.add("mw");
      if (token === "mw") tokens.add("magnitude");
      if (token === "earthquakes" || token === "earthquake") tokens.add("quake");
      if (token === "locations" || token === "location") {
        for (const term of ["place", "city", "district", "zone"]) tokens.add(term);
      }
      return [...tokens];
    })
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function stemToken(token: string): string {
  if (/\d/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && /(ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function scoreWindow(
  window: string,
  queryTokens: Set<string>,
  attributeTerms: Set<string>,
  start: number
): number {
  const normalizedWindow = normalizeForSearch(window);
  const windowTokens = new Set(tokenize(window));
  const tokenHits = [...queryTokens].filter((token) => windowTokens.has(token)).length;
  const attributeHits = [...attributeTerms].filter((term) => normalizedWindow.includes(term)).length;
  const decimalHits = (normalizedWindow.match(/\b\d+(?:\.\d+)?\b/g) ?? []).length;
  const magnitudeHits = (normalizedWindow.match(/\bmw\b|\bmagnitude\b/g) ?? []).length;
  const titleAbstractCue = /\babstract\b|\bintroduction\b|\btitle\b/.test(normalizedWindow) ? 1 : 0;

  return (
    tokenHits * 6 +
    attributeHits * 5 +
    Math.min(decimalHits, 8) * 1.5 +
    magnitudeHits * 8 +
    titleAbstractCue * 3 -
    start / 5000
  );
}

function clampToWordBoundary(text: string, start: number): number {
  if (start <= 0) return 0;
  const priorBreak = text.lastIndexOf(" ", start);
  if (priorBreak < 0 || start - priorBreak > 80) return start;
  return priorBreak + 1;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function preview(text: string, chars = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, chars);
}
