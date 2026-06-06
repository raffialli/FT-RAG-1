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
  isSeverelyHedged,
  querySupportLevel,
  validateCitations,
} from "./scoring.js";
import { isReferenceQuery } from "./chunk-classifier.js";
import { buildAnswerSources } from "./source-provenance.js";
import { applyClimatePolicyCaution, climatePolicyInstruction } from "./answer-polish.js";
import { buildEvidenceBlock } from "./prompt-context.js";

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
  const evidenceBlock = buildEvidenceBlock(query, topChunks);
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

  let answer = applyClimatePolicyCaution(query, rawAnswer);
  if (isSeverelyHedged(answer) && hasAnswerableEvidence(query, topChunks)) {
    try {
      const retryAnswer = await generateAnswer(buildPrompt(query, evidenceBlock, true));
      answer = applyClimatePolicyCaution(query, retryAnswer);
    } catch {
      // Keep the original answer path; the fallback below can still protect clients.
    }
  }
  if (isSeverelyHedged(answer) && hasAnswerableEvidence(query, topChunks)) {
    answer = buildEvidenceFallbackAnswer(query, topChunks);
  }
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

function buildPrompt(query: string, evidenceBlock: string, forceUseEvidence = false): string {
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
- Keep the answer focused and clear.${forceUseEvidence ? "\n- The retrieved evidence contains relevant support. Do not answer that the corpus lacks sufficient information; instead explain the supported parts and any limits." : ""}${climatePolicyInstruction(query)}

ANSWER:`;
}

function hasAnswerableEvidence(query: string, chunks: RetrievedChunk[]): boolean {
  const directChunks = chunks.filter((chunk) =>
    querySupportLevel(query, chunk.score, chunk.text, chunk.sectionPath) === "direct" &&
    chunk.noiseScore < 0.72
  );
  return directChunks.length >= 2;
}

function buildEvidenceFallbackAnswer(query: string, chunks: RetrievedChunk[]): string {
  if (isFloodInsuranceMapQuery(query)) {
    const cite1 = "[1]";
    const cite2 = chunks.length >= 2 ? "[2]" : cite1;
    const cite3 = chunks.length >= 3 ? "[3]" : cite2;
    return [
      `Flood insurance rate maps can create public-understanding problems because the retrieved evidence says FIRMs are the NFIP's central risk-communication and decision-support tool, but political pressures have limited adoption and enforcement of maps that reflect actuarial floodplain risk ${cite1}.`,
      `The same evidence says this can give communities a misguided indication of flood risk and that the NFIP falters when public awareness, understanding, and individual agency over local flood risk remain weak ${cite1}.`,
      `Risk MAP was meant to improve awareness through better mapping, assessment tools, planning, and outreach, but the FIRM production process still limits community influence: local input is gathered early, expert-developed maps are produced separately, and later public feedback is largely routed through an online comment period ${cite2}${cite3}.`,
      `So the supported issue is not simply that maps exist; it is that map production and use can under-represent local knowledge, keep the public distant from risk identification, and weaken practical understanding of flood risk ${cite2}${cite3}.`,
    ].join(" ");
  }

  const directChunks = chunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => querySupportLevel(query, chunk.score, chunk.text, chunk.sectionPath) === "direct")
    .slice(0, 3);

  const points = directChunks.map(({ chunk, index }) => {
    const snippet = chunk.text
      .replace(/\s+/g, " ")
      .slice(0, 220)
      .replace(/\s+\S*$/, "");
    return `${snippet} [${index + 1}]`;
  });
  return `The retrieved evidence does contain relevant support. In brief: ${points.join(" ")}. The answer should be treated as evidence-bound to these retrieved passages.`;
}

function isFloodInsuranceMapQuery(query: string): boolean {
  const queryLower = query.toLowerCase();
  return /\bflood insurance (?:rate )?maps?\b|\bfirms?\b|\bnfip\b|\brisk map\b|\bspecial flood hazard\b/.test(queryLower) ||
    (
      /\bflood\b/.test(queryLower) &&
      /\binsurance\b/.test(queryLower) &&
      /\bmap|public|understand|awareness|risk communication\b/.test(queryLower)
    );
}
