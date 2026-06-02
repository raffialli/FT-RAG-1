/**
 * Answer generation using qwen3.5:122b via Ollama Cloud.
 * Builds grounded prompts from retrieved evidence and returns
 * structured answers with citations and confidence scoring.
 */

import { generateAnswer } from "./embeddings.js";
import type { AnswerSource, QueryResult, RetrievedChunk } from "./types.js";

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
      sources: [],
      warnings: [`Generation error: ${String(e)}`],
    };
  }

  const sources = buildSources(topChunks);
  const confidence = assessConfidence(query, topChunks, rawAnswer);

  return {
    answer: rawAnswer,
    confidence: confidence.level,
    confidenceReason: confidence.reason,
    sources,
    warnings: confidence.warnings,
  };
}

function buildEvidenceBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const pageRange = c.pageStart === c.pageEnd ? `p. ${c.pageStart}` : `pp. ${c.pageStart}–${c.pageEnd}`;
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
- If evidence is weak or partial, say so clearly.
- Do not invent facts not supported by the evidence.
- Do not cite page numbers not present in the evidence.
- Keep the answer focused and clear.

ANSWER:`;
}

function buildSources(chunks: RetrievedChunk[]): AnswerSource[] {
  return chunks.map((c) => ({
    sourceFile: c.sourceFile,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    sectionPath: c.sectionPath,
    snippet: c.text.substring(0, 300) + (c.text.length > 300 ? "…" : ""),
    supportLevel: c.score > 0.025 ? "direct" : c.score > 0.015 ? "partial" : "weak",
    score: c.score,
  }));
}

interface ConfidenceAssessment {
  level: "high" | "medium" | "low" | "insufficient";
  reason: string;
  warnings: string[];
}

function assessConfidence(
  query: string,
  chunks: RetrievedChunk[],
  answer: string
): ConfidenceAssessment {
  const warnings: string[] = [];

  if (chunks.length === 0) {
    return { level: "insufficient", reason: "No evidence retrieved.", warnings };
  }

  const topScore = chunks[0].score;
  const directChunks = chunks.filter((c) => c.score > 0.025).length;
  const hasPageNumbers = chunks.filter((c) => c.pageStart > 0).length;

  if (hasPageNumbers < chunks.length) {
    warnings.push("Some sources missing page numbers.");
  }

  if (answer.toLowerCase().includes("i do not") || answer.toLowerCase().includes("not found")) {
    return { level: "low", reason: "LLM indicated insufficient evidence.", warnings };
  }

  if (directChunks >= 2 && topScore > 0.025) {
    return { level: "high", reason: `${directChunks} directly relevant chunks found.`, warnings };
  }

  if (directChunks >= 1 || topScore > 0.015) {
    return { level: "medium", reason: "Partial evidence found; some claims may need verification.", warnings };
  }

  warnings.push("Evidence quality is low. Answer may not be fully grounded.");
  return { level: "low", reason: "Weak evidence; answer may not be fully supported.", warnings };
}
