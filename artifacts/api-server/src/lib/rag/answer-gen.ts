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
} from "./scoring.js";
import { isReferenceQuery } from "./chunk-classifier.js";
import { buildAnswerSources } from "./source-provenance.js";
import { applyClimatePolicyCaution, climatePolicyInstruction } from "./answer-polish.js";

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
      answer: "The model did not return an answer. Please try again.",
      confidence: "insufficient",
      confidenceReason: "LLM call failed.",
      evidenceSufficiency: "insufficient",
      citationValidation: emptyCitationValidation(),
      sources: [],
      warnings: [`Generation error: ${String(e)}`],
    };
  }

  const answer = applyClimatePolicyCaution(query, rawAnswer);
  const sources = buildAnswerSources(query, topChunks);
  const citationVal = validateCitations(answer, topChunks, isReferenceQuery(query));
  const sufficiency = assessEvidenceSufficiency(topChunks, answer, query);
  const confidence = assessConfidence(query, topChunks, answer, citationVal, sufficiency);

  return {
    answer,
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
- If reference/bibliography evidence appears OCR-extracted, truncated, or garbled, state that the extracted reference list may be incomplete.
- Do not invent facts not supported by the evidence.
- Do not cite page numbers not present in the evidence.
- Keep the answer focused and clear.${climatePolicyInstruction(query)}

ANSWER:`;
}
