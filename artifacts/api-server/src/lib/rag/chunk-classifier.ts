/**
 * Chunk noise classifier for retrieval-time filtering.
 *
 * Classifies each chunk into a noise category and assigns a noiseScore (0–1).
 * Runs at retrieval time — no re-ingest required.
 *
 * Categories (ordered from noisiest to cleanest):
 *   reference-list        — numbered/bracketed reference entries
 *   bibliography          — author-year bibliography style
 *   ad-subscription       — pricing, subscription, ISSN blocks
 *   editorial-frontmatter — editorial board, copyright, publisher metadata
 *   toc                   — table of contents dot-leader lines
 *   citation-heavy        — dense in-text year citations
 *   contributor-affiliation — name + institution lists
 *   key-words-only        — very short keyword-list chunks
 *   useful-content        — substantive answer-bearing content
 */

export type ChunkCategory =
  | "reference-list"
  | "bibliography"
  | "ad-subscription"
  | "editorial-frontmatter"
  | "toc"
  | "citation-heavy"
  | "contributor-affiliation"
  | "key-words-only"
  | "useful-content";

export interface ChunkClassification {
  category: ChunkCategory;
  noiseScore: number;
  signals: string[];
}

/**
 * Rerank penalty subtracted from a chunk's score when this category is detected.
 * Applied as: score - penalty * 0.5 (matching existing rerank weight).
 * Set high enough to push noise chunks below useful content.
 */
export const NOISE_RERANK_PENALTY: Record<ChunkCategory, number> = {
  "reference-list":          1.10,
  "bibliography":            1.00,
  "ad-subscription":         1.10,
  "editorial-frontmatter":   0.90,
  "toc":                     1.00,
  "citation-heavy":          0.70,
  "contributor-affiliation": 0.70,
  "key-words-only":          0.50,
  "useful-content":          0.00,
};

/**
 * noiseScore threshold for hard exclusion from answer evidence.
 * Chunks at or above this score are removed from the answer generation
 * context unless the query explicitly requests references.
 */
export const NOISE_HARD_EXCLUSION_THRESHOLD = 0.72;

/**
 * Detect whether a query explicitly requests a reference list, bibliography,
 * or citation list — in which case Reference-labeled chunks are allowed through
 * and actively boosted in ranking.
 *
 * Patterns covered:
 *   "references" / "bibliography" / "citations" (direct keyword)
 *   "what references are cited in the FRM book?"
 *   "list of sources" / "source list"
 *   "what sources does X cite?"
 *   "footnotes" in the document
 */
export function isReferenceQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\b(references?|bibliography|bibliograph|citations?|cite|cited|works cited|source list|footnotes?)\b/.test(lower) ||
    /\blist of (sources?|references?|citations?)\b/.test(lower) ||
    /\bwhat (sources?|references?|citations?) (are )?(cited|used|included|referenced|in)\b/.test(lower) ||
    /\b(sources?|references?) cited in\b/.test(lower)
  );
}

/**
 * Classify a chunk's noise category and compute its noiseScore.
 *
 * @param text       - the chunk's text content
 * @param sectionPath - the chunk's detected section label (may be null)
 */
export function classifyChunkNoise(
  text: string,
  sectionPath: string | null
): ChunkClassification {
  const trimmed = text.trim();
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  const lineCount = Math.max(lines.length, 1);
  const words = trimmed.split(/\s+/).length;
  const signals: string[] = [];

  // ── 1. Ad / subscription detection (highest priority — language is unmistakable) ──
  if (
    /US \$\d+|Canada \$\d+|Foreign \$\d+|\$\d+.*annual|annual subscription|subscription rate|single issue/i.test(trimmed) ||
    /ISSN \d{4}-\d{4}/.test(trimmed)
  ) {
    signals.push("ad-subscription-language");
    return { category: "ad-subscription", noiseScore: 0.90, signals };
  }

  // ── 2. Editorial / frontmatter detection ──────────────────────────────────
  // SA-Weston only matched when it appears at the START of a line (publisher header),
  // not when it's an inline print artifact like "...research. SA-Weston-JEM#N.indd 27..."
  const saWestonStandalone = /^\s*SA-Weston/m.test(trimmed);
  if (
    /Copyright.*\d{4}|All rights reserved|Weston Medical Publishing/i.test(trimmed) ||
    saWestonStandalone ||
    /\bEditor(?:ial)?\s+(?:Board|in\s+Chief|Advisory)/i.test(trimmed) ||
    /\b(research centres?|research interests?|previously worked|worked as a research assistant|graduated from|holds an? (?:MSc|PhD|MA|BA))\b/i.test(trimmed)
  ) {
    signals.push("editorial-frontmatter-language");
    return { category: "editorial-frontmatter", noiseScore: 0.88, signals };
  }

  // ── 2b. Acknowledgment section detection ──────────────────────────────────
  // Acknowledgment/funding chunks have no answer value for content queries.
  if (
    sectionPath === "Acknowledgment" ||
    sectionPath === "Acknowledgements" ||
    (
      /^\s*(acknowledgments?|acknowledgements?)\s*$/im.test(trimmed) &&
      /\b(thank|supported by|funded|grant|gratitude|grateful|appreciate)\b/i.test(trimmed)
    ) ||
    (
      /\b(the authors? (wish(es)?|would like) to (thank|acknowledge)|this (work|study|research) was (supported|funded)|funding (was )?provided by)\b/i.test(trimmed)
    )
  ) {
    signals.push("acknowledgment-section");
    return { category: "editorial-frontmatter", noiseScore: 0.84, signals };
  }

  // ── 2c. Subject index / back-of-book index detection ─────────────────────
  // Subject index chunks: alphabetical entries with page numbers (A...18, B...22).
  // Pattern: word(s) followed by whitespace/dots and a page number, many such lines.
  const indexEntries = (
    trimmed.match(/^[A-Za-z][\w\s,;()-]{1,40}[\s.]{1,5}\d{1,4}$/gm) || []
  ).length;
  const inlineIndexLike =
    /^\s*(?:INDEX|Index)\b/.test(trimmed) &&
    (
      (trimmed.match(/\b[a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,}){0,4}\s+\d{1,4}(?:-\d{1,4})?/g) || []).length >= 8 ||
      /\baccountability\s+\d|actor mapping\s+\d|adaptation\s+\d|advocacy coalition framework\b/i.test(trimmed)
    );
  if (indexEntries / lineCount > 0.30 || sectionPath === "Index" || inlineIndexLike) {
    signals.push(`index-entries:${indexEntries}`);
    return { category: "toc", noiseScore: 0.86, signals };
  }

  // ── 3. TOC dot-leader detection ────────────────────────────────────────────
  const tocLines = (trimmed.match(/[.]{3,}\s*\d+\s*$/gm) || []).length;
  const inlineTocLike =
    (
      /^\s*(?:contents|table of contents|policy and implementation|list of illustrations)\b/i.test(trimmed) ||
      /\blist of illustrations\b/i.test(trimmed.slice(0, 800))
    ) &&
    (
      (trimmed.match(/\b\d{1,3}\s+[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,4}/g) || []).length >= 5 ||
      (trimmed.match(/\b[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,8}\s+\d{1,3}\b/g) || []).length >= 5 ||
      ((trimmed.match(/\b\d{1,3}\b/g) || []).length >= 6 && trimmed.length < 1800)
    );
  if (tocLines / lineCount > 0.25 || inlineTocLike) {
    signals.push(`toc-dotleader-lines:${tocLines}`);
    return { category: "toc", noiseScore: 0.85, signals };
  }

  // ── 4. Numbered / bracketed reference list ─────────────────────────────────
  // "1. Author Title..." or "[1] Author Title..."
  const numberedRefLines = (trimmed.match(/^\s*\d{1,3}[\.\)]\s+[A-Z]/gm) || []).length;
  const bracketedRefLines = (trimmed.match(/^\s*\[\d+\]\s+[A-Z]/gm) || []).length;
  const numberedRefRatio = (numberedRefLines + bracketedRefLines) / lineCount;

  if (
    numberedRefRatio > 0.35 ||
    (sectionPath === "Reference" && numberedRefLines + bracketedRefLines > 2)
  ) {
    signals.push(`numbered-ref-lines:${numberedRefLines + bracketedRefLines}`);
    const score = Math.min(0.99, 0.85 + numberedRefRatio * 0.14);
    return { category: "reference-list", noiseScore: score, signals };
  }

  // ── 5. Bibliography (author-year) style ───────────────────────────────────
  // "Author, A. (YYYY)..." or "Author, A., & Author B. (YYYY)..."
  const bibStyleLines = (
    trimmed.match(/^\s*[A-Z][a-záéíóúñ]+,\s+[A-Z][\w.]*[,.]?\s*(?:&\s*[A-Z][\w.]+)?[,.]?\s+\(\d{4}\)/gm) || []
  ).length;
  const etAlLines = (trimmed.match(/\bet al\.\s*\(\d{4}\)/g) || []).length;
  const bibRatio = bibStyleLines / lineCount;

  if (
    bibRatio > 0.20 ||
    (sectionPath === "Reference" && bibStyleLines > 2)
  ) {
    signals.push(`bib-style-lines:${bibStyleLines}`);
    const score = Math.min(0.99, 0.82 + bibRatio * 0.17);
    return { category: "bibliography", noiseScore: score, signals };
  }

  // ── 6. sectionPath = Reference (catch remaining bibliography chunks) ────────
  if (sectionPath === "Reference") {
    const yearCitations = (trimmed.match(/\(\d{4}[a-z]?\)/g) || []).length;
    const urlCount = (trimmed.match(/https?:\/\/\S+|www\.\S+/g) || []).length;

    if (yearCitations > 3 || urlCount > 2 || etAlLines > 1) {
      signals.push(`reference-section:yearCits=${yearCitations},urls=${urlCount},etAl=${etAlLines}`);
      return { category: "bibliography", noiseScore: 0.83, signals };
    }

    // Moderate signal — still penalize but softly
    signals.push("reference-section-low-density");
    return { category: "citation-heavy", noiseScore: 0.68, signals };
  }

  // ── 7. Citation-heavy (dense in-text year citations) ─────────────────────
  const yearCitations = (trimmed.match(/\(\d{4}[a-z]?\)/g) || []).length;
  const looseYears = (trimmed.match(/\b(?:19|20)\d\s?\d\b/g) || []).length;
  const urlOrAccessCues = (
    trimmed.match(/https?:\/\/\S+|www\.\S+|Available from|Accessed|doi\b/gi) || []
  ).length;
  const publicationCues = (
    trimmed.match(/\b(Journal|Proceedings|Publisher|Press|Risk Analysis|Macmillan|Collier)\b/g) || []
  ).length;
  if (
    (
      urlOrAccessCues >= 2 &&
      (yearCitations >= 1 || publicationCues >= 1)
    ) ||
    (publicationCues >= 2 && looseYears >= 2)
  ) {
    signals.push(`bibliography-fragment:urls=${urlOrAccessCues},years=${yearCitations},looseYears=${looseYears},pubs=${publicationCues}`);
    return { category: "bibliography", noiseScore: 0.82, signals };
  }

  const yearCitRatio = yearCitations / Math.max(words, 1);

  if (yearCitations > 6 && yearCitRatio > 0.042) {
    signals.push(`year-citations:${yearCitations},ratio:${yearCitRatio.toFixed(3)}`);
    const score = Math.min(0.90, 0.60 + yearCitRatio * 7);
    return { category: "citation-heavy", noiseScore: score, signals };
  }

  // ── 8. Contributor / affiliation detection ────────────────────────────────
  const affiliationMatches = (
    trimmed.match(/\b(University|College|Institute|Department|Professor|Director|PhD|MD|MPH|DrPH|EdD)\b/gm) || []
  ).length;
  const affiliationRatio = affiliationMatches / lineCount;

  if (affiliationMatches > 3 && affiliationRatio > 0.40) {
    signals.push(`affiliation-density:${affiliationMatches}/${lineCount}`);
    return { category: "contributor-affiliation", noiseScore: 0.76, signals };
  }

  // ── 9. Key-words-only (short keyword list, low information density) ────────
  if (sectionPath === "Key Words" && words < 60) {
    signals.push(`key-words-only:words=${words}`);
    return { category: "key-words-only", noiseScore: 0.55, signals };
  }

  // ── Clean ──────────────────────────────────────────────────────────────────
  return { category: "useful-content", noiseScore: 0, signals: [] };
}
