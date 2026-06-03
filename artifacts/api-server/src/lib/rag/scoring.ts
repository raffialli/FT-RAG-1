/**
 * Pure confidence/citation/sufficiency scoring functions.
 * No external imports — safe to import in test environments.
 *
 * Exported and tested by answer-gen.test.mts.
 * Used by answer-gen.ts for all scoring logic.
 */

import type {
  CitationValidation,
  EvidenceSufficiency,
  RetrievedChunk,
} from "./types.js";

// ── Score thresholds ──────────────────────────────────────────────────────────

/** Calibrated to observed distribution; good hits cluster at 0.27–0.30 */
export const SCORE_DIRECT = 0.22;
export const SCORE_PARTIAL = 0.12;

// ── Section quality sets ──────────────────────────────────────────────────────

export const HIGH_QUALITY_SECTIONS = new Set([
  "Abstract", "Result", "Results", "Discussion", "Conclusion", "Conclusions",
  "Finding", "Findings", "Method", "Methods", "Methodology", "Introduction",
  "Analysis", "Literature Review", "Summary",
]);

export const LOW_QUALITY_SECTIONS = ["Key Words", "Acknowledgment", "Recommendation"];

// ── Confidence level ordering ─────────────────────────────────────────────────

const CONFIDENCE_ORDER = ["high", "medium", "low", "insufficient"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_ORDER)[number];

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  reason: string;
  warnings: string[];
}

/** Return whichever confidence level is weaker (lower priority). */
export function capConfidence(level: ConfidenceLevel, cap: ConfidenceLevel): ConfidenceLevel {
  const li = CONFIDENCE_ORDER.indexOf(level);
  const ci = CONFIDENCE_ORDER.indexOf(cap);
  return CONFIDENCE_ORDER[Math.max(li, ci)];
}

/**
 * Policy (Report 14): max confidence allowed per evidence sufficiency level.
 *
 *   sufficient   → high allowed
 *   partial      → max medium
 *   weak         → max low
 *   insufficient → max low
 */
export function maxConfidenceForSufficiency(s: EvidenceSufficiency): ConfidenceLevel {
  switch (s) {
    case "sufficient":   return "high";
    case "partial":      return "medium";
    case "weak":         return "low";
    case "insufficient": return "low";
  }
}

// ── Citation parsing ──────────────────────────────────────────────────────────

/**
 * Parse all citation numbers from an answer string.
 *
 * Handles:
 *   [1]           → {1}
 *   [1,2]         → {1, 2}
 *   [1, 2]        → {1, 2}
 *   [1,2,3]       → {1, 2, 3}
 *   [1] [2]       → {1, 2}   (multiple separate brackets)
 *   [1] ... [1]   → {1}      (deduped, sorted ascending)
 */
export function parseCitationNumbers(answer: string): number[] {
  const bracketMatches = answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g);
  const citedSet = new Set<number>();
  for (const m of bracketMatches) {
    const parts = m[1].split(/\s*,\s*/);
    for (const p of parts) {
      const n = parseInt(p.trim(), 10);
      if (!isNaN(n)) citedSet.add(n);
    }
  }
  return [...citedSet].sort((a, b) => a - b);
}

// ── Citation validation ───────────────────────────────────────────────────────

export function validateCitations(
  answer: string,
  chunks: RetrievedChunk[],
  allowReferenceCitations = false
): CitationValidation {
  const warnings: string[] = [];
  const citedNumbers = parseCitationNumbers(answer);

  const validCitations: number[] = [];
  const invalidCitations: number[] = [];
  const noisyCitedChunks: number[] = [];

  for (const n of citedNumbers) {
    if (n < 1 || n > chunks.length) {
      invalidCitations.push(n);
      warnings.push(
        `Citation [${n}] references a non-existent source (only ${chunks.length} sources provided).`
      );
    } else {
      const chunk = chunks[n - 1];
      const allowedReferenceCitation =
        allowReferenceCitations &&
        ["reference-list", "bibliography", "citation-heavy"].includes(chunk.noiseCategory);

      if (chunk.noiseScore >= 0.5 && !allowedReferenceCitation) {
        noisyCitedChunks.push(n);
        warnings.push(
          `Citation [${n}] references a noisy chunk (noiseScore=${chunk.noiseScore.toFixed(2)}, category=${chunk.noiseCategory}).`
        );
      } else {
        validCitations.push(n);
      }
    }
  }

  const citedSet = new Set(citedNumbers);
  const uncitedChunkIndices: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!citedSet.has(i + 1)) uncitedChunkIndices.push(i + 1);
  }

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

export function emptyCitationValidation(): CitationValidation {
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

export function assessEvidenceSufficiency(
  chunks: RetrievedChunk[],
  answer: string
): EvidenceSufficiency {
  if (chunks.length === 0) return "insufficient";
  if (isSeverelyHedged(answer)) return "insufficient";

  const directChunks = chunks.filter((c) => c.score > SCORE_DIRECT && c.noiseScore < 0.5);
  const hqSectionChunks = chunks.filter(
    (c) => c.sectionPath && HIGH_QUALITY_SECTIONS.has(c.sectionPath) && c.score > SCORE_PARTIAL
  );
  const uniqueSources = new Set(chunks.map((c) => c.sourceFile)).size;

  if (directChunks.length >= 3 && uniqueSources >= 2) return "sufficient";
  if (directChunks.length >= 3 && uniqueSources === 1 && hqSectionChunks.length >= 2) return "partial";
  if (directChunks.length >= 2) return "partial";
  if (directChunks.length >= 1 || chunks.some((c) => c.score > SCORE_PARTIAL)) return "weak";
  return "insufficient";
}

// ── Confidence assessment ─────────────────────────────────────────────────────

/**
 * Confidence policy (v2, Report 14):
 *
 * Hard cap by evidence sufficiency (applied at end):
 *   sufficient   → high allowed
 *   partial      → max medium
 *   weak         → max low
 *   insufficient → max low
 *
 * Within the cap, confidence is further reduced by:
 *   - Severe hedging in answer text → low
 *   - Mild hedging in answer text   → cap at medium
 *   - Fewer than 2 direct chunks    → medium or low
 *   - Invalid/missing citations     → medium or low
 *   - Single-source with few HQ sections → medium
 */
export function assessConfidence(
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

  // 1. Severe hedging → cannot be high or medium
  if (isSeverelyHedged(answer)) {
    return {
      level: "low",
      reason: "LLM indicated the corpus does not contain sufficient information to answer.",
      warnings: ["Answer text signals insufficient evidence despite chunks being retrieved."],
    };
  }

  // 2. Sufficiency-based hard cap
  const sufficiencyCap = maxConfidenceForSufficiency(sufficiency);

  if (sufficiency === "insufficient") {
    return {
      level: "low",
      reason: "Evidence sufficiency is insufficient; answer may not be well grounded.",
      warnings,
    };
  }
  if (sufficiency === "weak") {
    return {
      level: "low",
      reason: "Evidence sufficiency is weak (too few direct-score chunks); confidence capped at low.",
      warnings,
    };
  }

  // 3. Score quality
  const directChunks = chunks.filter((c) => c.score > SCORE_DIRECT);
  const partialChunks = chunks.filter(
    (c) => c.score > SCORE_PARTIAL && c.score <= SCORE_DIRECT
  );
  const topScore = chunks[0].score;

  // 4. Source diversity
  const uniqueSources = new Set(chunks.map((c) => c.sourceFile)).size;
  const singleSourceConcentrated = uniqueSources === 1 && chunks.length >= 3;
  if (singleSourceConcentrated) {
    warnings.push(
      `All retrieved chunks are from a single source (${chunks[0].sourceFile.substring(0, 50)}). Answer is based on one document only.`
    );
  }

  // 5. Section quality
  const hqChunks = chunks.filter(
    (c) => c.sectionPath && HIGH_QUALITY_SECTIONS.has(c.sectionPath)
  );
  const lowQualityChunks = chunks.filter(
    (c) => c.sectionPath && LOW_QUALITY_SECTIONS.includes(c.sectionPath)
  );
  if (lowQualityChunks.length > 2) {
    warnings.push(
      `${lowQualityChunks.length} of ${chunks.length} chunks are from low-evidence-value sections (Key Words, Acknowledgment).`
    );
  }
  const lowQualityDominant = lowQualityChunks.length >= 3;

  // 6. Citation validity
  const hasInvalidCitations =
    citationVal.invalidCitations.length > 0 || citationVal.noisyCitedChunks.length > 0;
  const noCitations = citationVal.citedNumbers.length === 0;

  if (chunks.some((c) => c.pageStart === 0)) {
    warnings.push("Some sources are missing page number metadata.");
  }

  // 7. Mild hedging
  const mildHedge = isMildlyHedged(answer);

  // 8. Compute tentative confidence level
  let tentative: ConfidenceLevel;
  let reason: string;

  if (hasInvalidCitations || noCitations) {
    const r = hasInvalidCitations
      ? `Citation validation failed: ${citationVal.invalidCitations.length} invalid citation(s).`
      : "Answer contains no source citations — claims cannot be verified.";
    tentative = directChunks.length >= 2 ? "medium" : "low";
    reason = r;
  } else if (mildHedge) {
    tentative = "medium";
    reason = `Answer hedges on evidence quality. ${directChunks.length} chunk(s) with direct scores, ${uniqueSources} source(s).`;
  } else if (directChunks.length < 2) {
    if (directChunks.length === 1 && topScore > SCORE_PARTIAL) {
      tentative = "medium";
      reason = `Only ${directChunks.length} directly relevant chunk (score > ${SCORE_DIRECT}); ${partialChunks.length} partial.`;
    } else {
      tentative = "low";
      reason = `Insufficient directly relevant evidence (${directChunks.length} chunks with score > ${SCORE_DIRECT}).`;
    }
  } else if (lowQualityDominant) {
    tentative = "medium";
    reason = `${lowQualityChunks.length} of ${chunks.length} chunks are from low-evidence-value sections; confidence capped at medium.`;
  } else if (singleSourceConcentrated && hqChunks.length < 2) {
    tentative = "medium";
    reason = `${directChunks.length} relevant chunks but all from single source with limited high-quality sections.`;
  } else {
    const reasonParts: string[] = [
      `${directChunks.length} directly relevant chunk(s) (score > ${SCORE_DIRECT})`,
    ];
    if (uniqueSources > 1) reasonParts.push(`${uniqueSources} distinct sources`);
    if (hqChunks.length > 0) reasonParts.push(`${hqChunks.length} high-quality section(s)`);
    reasonParts.push(`${citationVal.validCitations.length} valid citation(s)`);
    tentative = "high";
    reason = reasonParts.join("; ") + ".";
  }

  // 9. Apply sufficiency cap
  const finalLevel = capConfidence(tentative, sufficiencyCap);
  if (finalLevel !== tentative) {
    reason = `${reason} Confidence capped at ${finalLevel} because evidence sufficiency is ${sufficiency}.`;
  }

  return { level: finalLevel, reason, warnings };
}

// ── Hedging detection ─────────────────────────────────────────────────────────

/**
 * Severe hedging: LLM explicitly says the corpus lacks information.
 * → Confidence must be low or insufficient.
 */
export function isSeverelyHedged(answer: string): boolean {
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
    /\bnot (enough|sufficient) (information|evidence)\b/.test(lower) ||
    /\bdoes not contain sufficient information\b/.test(lower)
  );
}

/**
 * Mild hedging: LLM signals partial or limited evidence.
 * → Confidence capped at medium.
 */
export function isMildlyHedged(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    /\blimited (direct )?information\b/.test(lower) ||
    /\blimited (direct )?evidence\b/.test(lower) ||
    /\blimited direct evidence\b/.test(lower) ||
    /\bpartial(ly)? (supported|evidence|information)\b/.test(lower) ||
    /\bpartial(ly)? evidence\b/.test(lower) ||
    /\bsome information\b.*\bhowever\b/.test(lower) ||
    /\bnot (explicitly|directly) (addressed|covered|stated)\b/.test(lower) ||
    /\bclaims may need (verification|further research)\b/.test(lower) ||
    /\bonly indirect(ly)?\b/.test(lower) ||
    /\bindirect(ly)? support(ed)?\b/.test(lower) ||
    /\bindirect evidence\b/.test(lower) ||
    /\bdoes not fully (answer|address|cover)\b/.test(lower) ||
    /\bnot fully support(ed)?\b/.test(lower) ||
    /\bnot well support(ed)?\b/.test(lower) ||
    /\bcannot (be )?definitive(ly)?\b/.test(lower) ||
    /\binsufficient to (fully |definitively )?(answer|address)\b/.test(lower) ||
    /\bonly partially (address(ed)?|cover(ed)?|answer(ed)?|support(ed)?)\b/.test(lower) ||
    /\bdoes not (directly|explicitly) (outline|explain|describe|provide)\b/.test(lower) ||
    /\bnot provide (a )?direct\b/.test(lower) ||
    /\bevidence does not directly\b/.test(lower) ||
    /\bonly indirectly (supports?|suggests?|indicates?|addresses?)\b/.test(lower) ||
    /\bindirectly suggests?\b/.test(lower)
  );
}

// ── Query-aware support level ─────────────────────────────────────────────────

/**
 * Determine citation support level from both score and query-term overlap.
 *
 * Thresholds (v2 — stricter than v1):
 *   direct  → score > SCORE_DIRECT AND (≥3 matching content words OR ≥30% overlap)
 *   partial → score > SCORE_PARTIAL  (or direct score with insufficient text match)
 *   weak    → score ≤ SCORE_PARTIAL
 *
 * "Content words" are query tokens longer than 3 characters.
 * This prevents high-RRF-rank but thematically tangential chunks
 * (e.g. gabion walls ranked for a communication query) from being
 * mislabelled "direct".
 *
 * Exported so it can be deterministically tested without the LLM stack.
 */
export function querySupportLevel(
  query: string,
  score: number,
  text: string,
  sectionPath?: string | null
): "direct" | "partial" | "weak" {
  if (score <= SCORE_PARTIAL) return "weak";
  if (score <= SCORE_DIRECT)  return "partial";

  if (sectionPath && LOW_QUALITY_SECTIONS.includes(sectionPath)) return "partial";

  // Score qualifies as direct — verify with query-term text overlap
  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);

  if (queryWords.length === 0) return "direct";

  const textLower = text.toLowerCase();
  const isEwsQuery =
    /\b(early warning|forecast\w*|EWS|warning system|hydrological|hydrology|monitoring system|flood detect|inundation model)\b/i.test(query);
  const physicalMitigationTerms = [
    "gabion", "retaining wall", "levee", "embankment", "dyke", "bund", "physical mitigation",
  ];
  if (isEwsQuery && physicalMitigationTerms.some((t) => textLower.includes(t))) return "partial";

  const matchCount = queryWords.filter((w) => textLower.includes(w)).length;
  const overlapRatio = matchCount / queryWords.length;

  // Require ≥3 matching terms OR ≥30% overlap to keep "direct"
  if (matchCount >= 3 || overlapRatio >= 0.30) return "direct";
  return "partial";
}
