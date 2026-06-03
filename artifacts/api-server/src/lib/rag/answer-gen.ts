/**
 * Answer generation using Ollama Cloud.
 * Builds grounded prompts from retrieved evidence and returns
 * structured answers with citations, confidence scoring,
 * citation validation, and evidence sufficiency assessment.
 *
 * Pure scoring logic lives in scoring.ts (zero external deps, tested separately).
 */

import { generateAnswer } from "./embeddings.js";
import type { QueryResult, RetrievedChunk } from "./types.js";
import {
  assessConfidence,
  assessEvidenceSufficiency,
  emptyCitationValidation,
  validateCitations,
  SCORE_DIRECT,
  SCORE_PARTIAL,
} from "./scoring.js";
import { getDisplayTitle } from "./source-titles.js";

// ── Main entry point ──────────────────────────────────────────────────────────

export async function synthesizeAnswer(
  query: string,
  chunks: RetrievedChunk[]
): Promise<Omit<QueryResult, "retrievedChunks" | "durationMs" | "debugTrace">> {
  if (chunks.length === 0) {
    return {
      answer:
        "I do not have sufficient evidence in the ingested documents to answer this question. Please ingest relevant documents or refine your query.",
      confidence: "insufficient",
      confidenceReason: "No relevant chunks were retrieved.",
      evidenceSufficiency: "insufficient",
      citationValidation: emptyCitationValidation(),
      sources: [],
      warnings: ["No evidence found in the document corpus for this query."],
    };
  }

  const topChunks = chunks.slice(0, 5);
  const evidenceBlock = buildEvidenceBlock(topChunks);
  const prompt = buildPrompt(query, evidenceBlock);

  let rawAnswer: string;
  try {
    rawAnswer = await generateAnswer(prompt);
  } catch (e) {
    return {
      answer: `Answer generation failed: ${String(e)}`,
      confidence: "insufficient",
      confidenceReason: "LLM call failed.",
      evidenceSufficiency: "insufficient",
      citationValidation: emptyCitationValidation(),
      sources: [],
      warnings: [`Generation error: ${String(e)}`],
    };
  }

  const sources = buildSources(query, topChunks);
  const citationVal = validateCitations(rawAnswer, topChunks);
  const sufficiency = assessEvidenceSufficiency(topChunks, rawAnswer);
  const confidence = assessConfidence(query, topChunks, rawAnswer, citationVal, sufficiency);

  return {
    answer: rawAnswer,
    confidence: confidence.level,
    confidenceReason: confidence.reason,
    evidenceSufficiency: sufficiency,
    citationValidation: citationVal,
    sources,
    warnings: [...confidence.warnings, ...citationVal.warnings],
  };
}

// ── Evidence block & prompt ───────────────────────────────────────────────────

function buildEvidenceBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const pageRange =
        c.pageStart === c.pageEnd ? `p. ${c.pageStart}` : `pp. ${c.pageStart}–${c.pageEnd}`;
      const section = c.sectionPath ? ` § ${c.sectionPath}` : "";
      return `[${i + 1}] Source: ${c.sourceFile} (${pageRange}${section})\n${c.text.substring(0, 1000)}`;
    })
    .join("\n\n---\n\n");
}

function buildPrompt(query: string, evidenceBlock: string): string {
  return `You are a research assistant answering questions based strictly on provided source documents.

QUESTION: ${query}

RETRIEVED EVIDENCE:
${evidenceBlock}

INSTRUCTIONS:
- Answer based ONLY on the evidence above.
- Start with the direct answer.
- Cite sources using [1], [2], etc. matching the evidence block numbers.
- If the evidence partially addresses the question, synthesize what the evidence shows and explicitly note which aspects have stronger vs. weaker support (e.g., "The evidence addresses X [1][2] but does not directly cover Y").
- Only say "The corpus does not contain sufficient information to answer this question" if NO relevant evidence is found at all — not when evidence is partial or indirect.
- If evidence is from reference or bibliography sections, list or describe those references as found in the evidence.
- Do not invent facts not supported by the evidence.
- Do not cite page numbers not present in the evidence.
- Keep the answer focused and clear.

ANSWER:`;
}

// ── Sources ───────────────────────────────────────────────────────────────────

/**
 * Build the source list for a query result.
 *
 * Support level is determined by both score and query-term overlap:
 * - "direct"  : score > SCORE_DIRECT AND meaningful term overlap
 * - "partial" : score > SCORE_PARTIAL (or direct score but low overlap)
 * - "weak"    : score ≤ SCORE_PARTIAL
 */
function buildSources(query: string, chunks: RetrievedChunk[]) {
  return chunks.map((c) => ({
    sourceFile: c.sourceFile,
    displayTitle: getDisplayTitle(c.sourceFile),
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    sectionPath: c.sectionPath,
    snippet: c.text.substring(0, 300) + (c.text.length > 300 ? "…" : ""),
    supportLevel: querySupportLevel(query, c),
    score: c.score,
  }));
}

/**
 * Query-aware support level for a chunk.
 *
 * A chunk whose RRF score exceeds SCORE_DIRECT is still only "partial" if
 * fewer than 25% of query content words appear in the chunk text (threshold:
 * at least 2 terms must match). This prevents high-rank but tangential chunks
 * from being labelled "direct".
 */
function querySupportLevel(
  query: string,
  chunk: RetrievedChunk
): "direct" | "partial" | "weak" {
  if (chunk.score <= SCORE_PARTIAL) return "weak";
  if (chunk.score <= SCORE_DIRECT) return "partial";

  // Score qualifies as direct — verify with query-term overlap
  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);

  if (queryWords.length === 0) return "direct";

  const chunkLower = chunk.text.toLowerCase();
  const matchCount = queryWords.filter((w) => chunkLower.includes(w)).length;
  const overlapRatio = matchCount / queryWords.length;

  // Require at least 2 matching content words OR 25% overlap to keep "direct"
  if (matchCount >= 2 || overlapRatio >= 0.25) return "direct";
  return "partial";
}
