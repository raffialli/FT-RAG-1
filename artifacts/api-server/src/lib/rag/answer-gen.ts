/**
 * Answer generation using Ollama Cloud.
 * Builds grounded prompts from retrieved evidence and returns
 * structured answers with citations, confidence scoring,
 * citation validation, and evidence sufficiency assessment.
 *
 * Confidence scoring improvements (v2):
 * - Expanded hedging detection (catches "no specific information",
 *   "limited direct information", "not covered", etc.)
 * - Score thresholds calibrated to actual distribution:
 *     direct   = score > 0.22   (not > 0.025 which was always true)
 *     partial  = score > 0.12
 *     weak     = score ≤ 0.12
 * - Source diversity penalty for single-source concentration
 * - Section quality awareness (Abstract/Result/Discussion boost)
 * - Citation validation: cited numbers must exist and not be noisy
 * - Evidence sufficiency field added to API response
 */

import { generateAnswer } from "./embeddings.js";
import type {
  AnswerSource,
  CitationValidation,
  EvidenceSufficiency,
  QueryResult,
  RetrievedChunk,
} from "./types.js";

// Score thresholds calibrated to observed distribution (good hits: 0.27–0.30)
const SCORE_DIRECT = 0.22;
const SCORE_PARTIAL = 0.12;

// Section types that contribute high-quality evidence for answer generation
const HIGH_QUALITY_SECTIONS = new Set([
  "Abstract", "Result", "Results", "Discussion", "Conclusion", "Conclusions",
  "Finding", "Findings", "Method", "Methods", "Methodology", "Introduction",
  "Analysis", "Literature Review", "Summary",
]);

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

  const sources = buildSources(topChunks);
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
- If evidence is weak or partial, say so clearly.
- If the evidence does not contain enough information to answer the question, say explicitly: "The corpus does not contain sufficient information to answer this question."
- Do not invent facts not supported by the evidence.
- Do not cite page numbers not present in the evidence.
- Keep the answer focused and clear.

ANSWER:`;
}

// ── Sources ───────────────────────────────────────────────────────────────────

function buildSources(chunks: RetrievedChunk[]): AnswerSource[] {
  return chunks.map((c) => ({
    sourceFile: c.sourceFile,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    sectionPath: c.sectionPath,
    snippet: c.text.substring(0, 300) + (c.text.length > 300 ? "…" : ""),
    // supportLevel thresholds calibrated to actual score distribution
    supportLevel: c.score > SCORE_DIRECT ? "direct" : c.score > SCORE_PARTIAL ? "partial" : "weak",
    score: c.score,
  }));
}

// ── Citation validation ───────────────────────────────────────────────────────

function validateCitations(answer: string, chunks: RetrievedChunk[]): CitationValidation {
  const warnings: string[] = [];

  // Extract all citation numbers used in the answer, e.g. [1], [2], [1,2]
  const rawMatches = answer.matchAll(/\[(\d+)\]/g);
  const citedSet = new Set<number>();
  for (const m of rawMatches) citedSet.add(parseInt(m[1], 10));
  const citedNumbers = [...citedSet].sort((a, b) => a - b);

  // Validate each cited number
  const validCitations: number[] = [];
  const invalidCitations: number[] = [];
  const noisyCitedChunks: number[] = [];

  for (const n of citedNumbers) {
    if (n < 1 || n > chunks.length) {
      invalidCitations.push(n);
      warnings.push(`Citation [${n}] references a non-existent source (only ${chunks.length} sources provided).`);
    } else {
      const chunk = chunks[n - 1];
      if (chunk.noiseScore >= 0.5) {
        noisyCitedChunks.push(n);
        warnings.push(`Citation [${n}] references a noisy chunk (noiseScore=${chunk.noiseScore.toFixed(2)}, category=${chunk.noiseCategory}).`);
      } else {
        validCitations.push(n);
      }
    }
  }

  // Flag uncited chunks (chunks present but not referenced in answer)
  const uncitedChunkIndices: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!citedSet.has(i + 1)) uncitedChunkIndices.push(i + 1);
  }

  // No citations at all but answer has content
  if (citedNumbers.length === 0 && answer.trim().length > 50) {
    warnings.push("Answer contains no source citations — claims are ungrounded.");
  }

  const allValid =
    invalidCitations.length === 0 &&
    noisyCitedChunks.length === 0 &&
    citedNumbers.length > 0;

  return {
    citedNumbers,
    validCitations,
    invalidCitations,
    uncitedChunkIndices,
    noisyCitedChunks,
    allValid,
    warnings,
  };
}

function emptyCitationValidation(): CitationValidation {
  return {
    citedNumbers: [],
    validCitations: [],
    invalidCitations: [],
    uncitedChunkIndices: [],
    noisyCitedChunks: [],
    allValid: false,
    warnings: [],
  };
}

// ── Evidence sufficiency ──────────────────────────────────────────────────────

function assessEvidenceSufficiency(
  chunks: RetrievedChunk[],
  answer: string
): EvidenceSufficiency {
  if (chunks.length === 0) return "insufficient";
  if (isSeverelyHedged(answer)) return "insufficient";

  // Chunks with strong scores and low noise
  const directChunks = chunks.filter((c) => c.score > SCORE_DIRECT && c.noiseScore < 0.5);
  // Chunks from high-quality sections
  const hqSectionChunks = chunks.filter(
    (c) => c.sectionPath && HIGH_QUALITY_SECTIONS.has(c.sectionPath) && c.score > SCORE_PARTIAL
  );
  // Number of distinct source files
  const uniqueSources = new Set(chunks.map((c) => c.sourceFile)).size;

  if (directChunks.length >= 3 && uniqueSources >= 2) return "sufficient";
  if (directChunks.length >= 3 && uniqueSources === 1 && hqSectionChunks.length >= 2) return "partial";
  if (directChunks.length >= 2) return "partial";
  if (directChunks.length >= 1 || chunks.some((c) => c.score > SCORE_PARTIAL)) return "weak";
  return "insufficient";
}

// ── Confidence assessment ─────────────────────────────────────────────────────

interface ConfidenceAssessment {
  level: "high" | "medium" | "low" | "insufficient";
  reason: string;
  warnings: string[];
}

function assessConfidence(
  _query: string,
  chunks: RetrievedChunk[],
  answer: string,
  citationVal: CitationValidation,
  sufficiency: EvidenceSufficiency
): ConfidenceAssessment {
  const warnings: string[] = [];

  if (chunks.length === 0) {
    return { level: "insufficient", reason: "No evidence retrieved.", warnings };
  }

  // ── 1. Severe hedging → cannot be high or medium ───────────────────────────
  if (isSeverelyHedged(answer)) {
    return {
      level: "low",
      reason: "LLM indicated the corpus does not contain sufficient information to answer.",
      warnings: ["Answer text signals insufficient evidence despite chunks being retrieved."],
    };
  }

  // ── 2. Mild hedging → cap at medium ───────────────────────────────────────
  const mildHedge = isMildlyHedged(answer);

  // ── 3. Score quality ───────────────────────────────────────────────────────
  const directChunks = chunks.filter((c) => c.score > SCORE_DIRECT);
  const partialChunks = chunks.filter(
    (c) => c.score > SCORE_PARTIAL && c.score <= SCORE_DIRECT
  );
  const topScore = chunks[0].score;

  // ── 4. Source diversity ────────────────────────────────────────────────────
  const uniqueSources = new Set(chunks.map((c) => c.sourceFile)).size;
  const singleSourceConcentrated = uniqueSources === 1 && chunks.length >= 3;
  if (singleSourceConcentrated) {
    warnings.push(
      `All retrieved chunks are from a single source (${chunks[0].sourceFile.substring(0, 50)}). Answer is based on one document only.`
    );
  }

  // ── 5. Section quality ─────────────────────────────────────────────────────
  const hqChunks = chunks.filter(
    (c) => c.sectionPath && HIGH_QUALITY_SECTIONS.has(c.sectionPath)
  );
  const lowQualitySections = ["Key Words", "Acknowledgment", "Recommendation"];
  const lowQualityChunks = chunks.filter(
    (c) => c.sectionPath && lowQualitySections.includes(c.sectionPath)
  );
  if (lowQualityChunks.length > 2) {
    warnings.push(`${lowQualityChunks.length} of ${chunks.length} chunks are from low-evidence-value sections (Key Words, Acknowledgment).`);
  }

  // ── 6. Citation validity ───────────────────────────────────────────────────
  const hasInvalidCitations =
    citationVal.invalidCitations.length > 0 || citationVal.noisyCitedChunks.length > 0;
  const noCitations = citationVal.citedNumbers.length === 0;

  if (hasPageMissingIssue(chunks)) {
    warnings.push("Some sources are missing page number metadata.");
  }

  // ── 7. Final confidence verdict ────────────────────────────────────────────

  // Hard rules that cap confidence:
  // a) Insufficient evidence sufficiency → never high
  if (sufficiency === "insufficient") {
    return {
      level: "low",
      reason: "Evidence sufficiency is insufficient; answer may not be well grounded.",
      warnings,
    };
  }

  // b) Invalid citations or no citations at all → never high
  if (hasInvalidCitations || noCitations) {
    const reason = hasInvalidCitations
      ? `Citation validation failed: ${citationVal.invalidCitations.length} invalid citation(s).`
      : "Answer contains no source citations — claims cannot be verified.";
    const level = directChunks.length >= 2 ? "medium" : "low";
    return { level, reason, warnings };
  }

  // c) Mild hedging → cap at medium
  if (mildHedge) {
    return {
      level: "medium",
      reason: `Answer hedges on evidence quality. ${directChunks.length} chunk(s) with direct scores, ${uniqueSources} source(s).`,
      warnings,
    };
  }

  // d) Fewer than 2 direct chunks → cannot be high
  if (directChunks.length < 2) {
    if (directChunks.length === 1 && topScore > SCORE_PARTIAL) {
      return {
        level: "medium",
        reason: `Only ${directChunks.length} directly relevant chunk (score > ${SCORE_DIRECT}); ${partialChunks.length} partial.`,
        warnings,
      };
    }
    return {
      level: "low",
      reason: `Insufficient directly relevant evidence (${directChunks.length} chunks with score > ${SCORE_DIRECT}).`,
      warnings,
    };
  }

  // e) Good evidence but single source — high is still warranted if HQ sections
  if (singleSourceConcentrated && hqChunks.length < 2) {
    return {
      level: "medium",
      reason: `${directChunks.length} relevant chunks but all from single source with limited high-quality sections.`,
      warnings,
    };
  }

  // High confidence: ≥2 direct chunks, valid citations, no severe hedging
  const reasonParts: string[] = [`${directChunks.length} directly relevant chunk(s) (score > ${SCORE_DIRECT})`];
  if (uniqueSources > 1) reasonParts.push(`${uniqueSources} distinct sources`);
  if (hqChunks.length > 0) reasonParts.push(`${hqChunks.length} high-quality section(s)`);
  reasonParts.push(`${citationVal.validCitations.length} valid citation(s)`);

  return {
    level: "high",
    reason: reasonParts.join("; ") + ".",
    warnings,
  };
}

// ── Hedging detection helpers ─────────────────────────────────────────────────

/**
 * Severe hedging: LLM explicitly says the corpus lacks information.
 * → Confidence must be low or insufficient.
 */
function isSeverelyHedged(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    /\bno specific information\b/.test(lower) ||
    /\bno information\b/.test(lower) ||
    /\bthe corpus does not contain\b/.test(lower) ||
    /\bnot covered in the (provided |source |ingested )?documents?\b/.test(lower) ||
    /\bnot found in the (provided |source |ingested )?documents?\b/.test(lower) ||
    /\bthe (provided )?evidence does not (contain|include|address)\b/.test(lower) ||
    /\bcannot (find|locate|answer|provide)\b/.test(lower) ||
    /\bi (do not|don't) have (sufficient |enough )?(information|evidence|data)\b/.test(lower) ||
    /\bnot (enough|sufficient) (information|evidence)\b/.test(lower)
  );
}

/**
 * Mild hedging: LLM signals partial or limited evidence.
 * → Confidence capped at medium.
 */
function isMildlyHedged(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    /\blimited (direct )?information\b/.test(lower) ||
    /\blimited (direct )?evidence\b/.test(lower) ||
    /\bpartial(ly)? (supported|evidence|information)\b/.test(lower) ||
    /\bsome information\b.*\bhowever\b/.test(lower) ||
    /\bnot (explicitly|directly) (addressed|covered|stated)\b/.test(lower) ||
    /\bclaims may need (verification|further research)\b/.test(lower)
  );
}

function hasPageMissingIssue(chunks: RetrievedChunk[]): boolean {
  return chunks.some((c) => c.pageStart === 0);
}
