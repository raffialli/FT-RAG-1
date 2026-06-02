/**
 * OCR/layout cleanup for messy PDFs.
 *
 * Cleanup order (safe → aggressive):
 *  1.  Normalize unicode / line endings
 *  2.  Fix broken hyphenation — both `word-\nword` AND `word- word` (trailing space)
 *  3.  Remove layout annotation lines  (*_Layout N, Page N at line end)
 *  4.  Remove cover/logo image-descriptor artifacts  (FL E E, "F L O O D S")
 *  5.  Repair known OCR character substitutions  (Flz.M → FRM, constrnctions → constructions)
 *  6.  Remove repeated journal headers/footers — inline AND newline-separated
 *  7.  Remove DOI / SA-Weston publisher junk lines
 *  8.  Remove standalone page numbers
 *  9.  Remove frontmatter / copyright blocks
 * 10.  Remove advertisement / subscription blocks
 * 11.  Remove table-of-contents dot-leader lines
 * 12.  Remove reference section tail (when it starts after 50% of document)
 * 13.  Fix multi-column OCR artifacts
 * 14.  Remove bare URL lines that add no semantic value
 * 15.  Normalize whitespace
 * 16.  Quality check
 */

export interface CleanResult {
  cleanedText: string;
  cleaningFlags: string[];
  qualityNotes: string[];
}

export interface ArtifactReport {
  counts: Record<string, number>;
  examples: Record<string, string[]>;
  noiseRatio: number;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function cleanOcrText(rawText: string, filename: string): CleanResult {
  const flags: string[] = [];
  const notes: string[] = [];
  let text = rawText;

  // 1. Normalize unicode and line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u00ad/g, "");  // soft hyphens
  text = text.replace(/\ufffd/g, " "); // replacement chars

  // 2a. Fix broken hyphenation across lines: word-\nword → word-word (rejoin)
  const before2a = text.length;
  text = text.replace(/(\w)-\s*\n\s*([a-z])/g, "$1$2");
  // 2b. Fix broken hyphenation with trailing space on same line: word- word → wordword
  //     Catches "eco- nomics", "pre- paredness", "flexi- ble", etc.
  //     Only join when the second token is ≥3 chars and lowercase (avoid "U.S.- based" etc.)
  const before2b = text.length;
  text = text.replace(/(\b[a-zA-Z]{2,})-\s{1,3}([a-z]{3,})\b/g, "$1$2");
  if (text.length !== before2a || text.length !== before2b) {
    flags.push("fixed-hyphenation");
  }

  // 3. Remove layout annotation lines  (PDF layer descriptors)
  //    Examples: "JEM_Blank_Layout 1 2/28/2017 8:31 AM Page 1"
  //              "Cover_Layout 2  Page 3"
  const layoutBefore = text.length;
  text = text.replace(/^.*_Layout\s+\d[^\n]*$/gm, "");
  text = text.replace(/^.*_layout\s+\d[^\n]*$/gm, "");
  if (text.length !== layoutBefore) flags.push("removed-layout-annotations");

  // 4. Remove cover/logo image-descriptor artifacts
  //    Catches: "FL E E", "F L O O D S", "J E M", "F R M" (2-7 spaced capital letters)
  const logoPattern = /\b([A-Z] ){2,6}[A-Z]\b/g;
  if (logoPattern.test(text)) {
    text = text.replace(/\b([A-Z] ){2,6}[A-Z]\b/g, "");
    flags.push("removed-logo-artifacts");
  }

  // 5. Repair known OCR character substitutions specific to this corpus
  const before5 = text;
  text = text
    .replace(/\bFlz\.M\b/g, "FRM")          // OCR misread of "FRM"
    .replace(/\bFlz\.W\b/g, "FRM")
    .replace(/\bconstrnctions?\b/g, "constructions")
    .replace(/\binnrmation\b/gi, "information")
    .replace(/\binfonnation\b/gi, "information")
    .replace(/\badequnte\b/gi, "adequate")
    .replace(/\bmanagcment\b/gi, "management");
  if (text !== before5) flags.push("repaired-ocr-substitutions");

  // 6. Remove repeated journal headers/footers — BOUNDED removal only.
  //
  //    PDF extraction often produces ~2000-char "lines" (one per page).
  //    Using [^\n]* on these would eat the entire page of article content.
  //    Instead, match only the header metadata label and stop there.
  //
  //    Real examples from this corpus:
  //      "JEM 123 Journal of Emergency Management  Vol. 20, No. 8 Georgetown University Special Issue"
  //      "124 Journal of Emergency Management  Vol. 20, No. 8 Georgetown University Special Issue"
  //      "Journal of Emergency Management Vol. 6, No. 5, September/October 2008 71"
  //      "Journal of Emergency Management  Vol. 3, No. 2, Spring 2005"

  // 6a. Strip "JEM NNN" or bare "NNN" page-number prefix directly before the header label
  text = text.replace(/(^|\s)(?:JEM\s+)?\d{1,4}\s+(?=Journal of Emergency Management)/gm, "$1");

  // 6b. Remove bounded header: Vol/No/date/page# and known special-issue suffixes only
  const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Spring|Summer|Fall|Winter";
  const JEM_HDR_PATTERN = new RegExp(
    `Journal of Emergency Management\\s+Vol\\.\\s*\\d+` +
    `(?:,?\\s*No\\.\\s*\\d+)?` +
    `(?:,?\\s*(?:${MONTHS})(?:\\/(?:${MONTHS}))?\\s+\\d{4})?` +
    `(?:\\s+\\d{1,4})?` +
    `(?:\\s+Georgetown University Special Issue)?` +
    `(?:\\s+Special Issue on\\s+[^.!?()\\n]{0,80})?`,
    "gi"
  );
  // Also catch newline-separated variant: "Journal of Emergency Management\nVol. X"
  const JEM_HDR_NEWLINE = /Journal of Emergency Management\s*\n\s*Vol\.[^,\n]{0,40}/gi;

  if (JEM_HDR_PATTERN.test(text) || JEM_HDR_NEWLINE.test(text)) {
    text = text.replace(JEM_HDR_PATTERN, " ");
    text = text.replace(JEM_HDR_NEWLINE, " ");
    flags.push("removed-journal-headers");
  }

  // Remove DOI lines, SA-Weston publisher lines (full-line only, not inline)
  text = text.replace(/^DOI:[^\n]*$/gim, "");
  text = text.replace(/^SA-Weston[^\n]*$/gim, "");

  // 7. Remove leftover "JEM NNN" standalone boilerplate lines
  text = text.replace(/^JEM\s+\d+\s*$/gm, "");

  // 8. Remove standalone page numbers
  const pageNumBefore = text.length;
  text = text.replace(/^\s*\d{1,4}\s*$/gm, "");
  if (text.length !== pageNumBefore) flags.push("removed-page-numbers");

  // 9. Detect and remove frontmatter / copyright blocks
  if (
    /ISSN \d{4}-\d{4}/.test(text) ||
    /Copyright.*\d{4}/.test(text) ||
    /All rights reserved/.test(text)
  ) {
    text = removeFrontmatterBlock(text);
    flags.push("removed-frontmatter");
  }

  // 10. Remove advertisement blocks (subscription info, price lists)
  if (/US \$\d+/.test(text) || /subscription/i.test(text)) {
    text = removeAdBlocks(text);
    flags.push("removed-ads");
  }

  // 11. Remove table of contents dot-leader lines
  if (/^\s*\d+\s*\.\s*[A-Z][^\n]{5,50}\s*\.{3,}\s*\d+\s*$/m.test(text)) {
    text = removeTocBlocks(text);
    flags.push("removed-toc");
  }

  // 12. Remove reference sections at end of document
  const refMatch = text.search(/\n\s*(References?|Bibliography|REFERENCES?)\s*\n/);
  if (refMatch !== -1 && refMatch > text.length * 0.5) {
    text = text.substring(0, refMatch);
    flags.push("removed-references");
  }

  // 13. Fix multi-column OCR artifacts (lines that are too short and alternating)
  text = fixColumnArtifacts(text, flags);

  // 14. Remove bare URL lines with no surrounding context
  //     Only removes lines that are ONLY a URL (not inline citations)
  const urlLineBefore = text.length;
  text = text.replace(/^\s*https?:\/\/[^\s]+\s*$/gm, "");
  text = text.replace(/^\s*www\.[^\s]{5,}\s*$/gm, "");
  if (text.length !== urlLineBefore) flags.push("removed-bare-url-lines");

  // 15. Normalize whitespace
  text = text.replace(/\n{3,}/g, "\n\n"); // max 2 blank lines
  text = text.replace(/[ \t]{2,}/g, " ");  // multiple spaces → single
  text = text.trim();

  // 16. Quality check
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 50) notes.push("very-short-document");
  const avgLineLen = text.split("\n").reduce((s, l) => s + l.length, 0) / (text.split("\n").length || 1);
  if (avgLineLen < 20) notes.push("short-avg-line-length-possible-column-artifact");

  return { cleanedText: text, cleaningFlags: flags, qualityNotes: notes };
}

// ── OCR artifact detector ────────────────────────────────────────────────────

/**
 * Scan raw (or cleaned) text and return a structured artifact report.
 * Used for before/after comparison and per-chunk noise scoring.
 */
export function detectArtifacts(text: string): ArtifactReport {
  const counts: Record<string, number> = {};
  const examples: Record<string, string[]> = {};

  function scan(name: string, pattern: RegExp): void {
    const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))];
    counts[name] = matches.length;
    examples[name] = matches.slice(0, 3).map((m) => m[0].trim().substring(0, 80));
  }

  scan("hyphen_trailing_space",  /\b[a-zA-Z]{2,}-\s{1,3}[a-z]{3,}\b/);
  scan("hyphen_newline",         /\w-\s*\n\s*[a-z]/);
  scan("layout_annotation",      /\S+_[Ll]ayout\s+\d[^\n]*/);
  scan("spaced_logo_letters",    /\b([A-Z] ){2,6}[A-Z]\b/);
  scan("ocr_substitution_FRM",   /Flz\.[MW]/);
  scan("ocr_constrnction",       /constrnction/i);
  scan("journal_header_inline",  /Journal of Emergency Management\s+Vol\.\s*\d+/i);
  scan("journal_header_newline", /Journal of Emergency Management\s*\n\s*Vol\./i);
  scan("issn_line",              /ISSN \d{4}-\d{4}/);
  scan("copyright_line",         /Copyright.*\d{4}/);
  scan("bare_url_line",          /^\s*https?:\/\/[^\s]+\s*$/m);
  scan("www_url_line",           /^\s*www\.[^\s]{5,}\s*$/m);
  scan("standalone_page_number", /^\s*\d{1,4}\s*$/m);
  scan("subscription_price",     /US \$\d+|Canada \$\d+/);
  scan("doi_line",               /^DOI:[^\n]*/m);
  scan("jem_junk_number",        /^JEM\s+\d+\s*$/m);

  const words = text.split(/\s+/).length;
  const totalArtifacts = Object.values(counts).reduce((a, b) => a + b, 0);
  const noiseRatio = words > 0 ? totalArtifacts / words : 0;

  return { counts, examples, noiseRatio };
}

/**
 * Score a single chunk's noise level (0 = clean, 1 = very noisy).
 * Used for evidence quality filtering.
 */
export function chunkNoiseScore(text: string): number {
  const report = detectArtifacts(text);
  return Math.min(1, report.noiseRatio * 10);
}

// ── Private helpers ──────────────────────────────────────────────────────────

function removeFrontmatterBlock(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFrontmatter = false;
  let frontmatterLineCount = 0;

  for (const line of lines) {
    const isFrontmatterLine =
      /ISSN \d{4}-\d{4}/.test(line) ||
      /Copyright.*\d{4}/.test(line) ||
      /All rights reserved/.test(line) ||
      /Published by/.test(line) ||
      /Weston Medical Publishing/.test(line) ||
      /Subscription/.test(line) ||
      /E-mail:.*@/.test(line) ||
      /Web site:.*www/.test(line) ||
      /Postmaster:/.test(line) ||
      /Disclaimer:/.test(line) ||
      // Additional editorial-board patterns
      /^[A-Z][a-z]+,\s+(PhD|MD|MPH|EdD|DPA|JD|MS|MA|BA)\b/.test(line) ||
      /\b(Associate|Assistant|Adjunct)\s+(Professor|Director|Chair)\b/.test(line);

    if (isFrontmatterLine) {
      inFrontmatter = true;
      frontmatterLineCount++;
    } else if (inFrontmatter && line.trim() === "") {
      frontmatterLineCount++;
      if (frontmatterLineCount > 3) {
        inFrontmatter = false;
        frontmatterLineCount = 0;
      }
    } else {
      inFrontmatter = false;
      frontmatterLineCount = 0;
      result.push(line);
    }
  }
  return result.join("\n");
}

function removeAdBlocks(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let skipCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skipCount > 0) {
      skipCount--;
      continue;
    }
    const isAdLine =
      /US \$\d+/.test(line) ||
      /Canada \$\d+/.test(line) ||
      /Foreign \$\d+/.test(line) ||
      /Individual:.*\$/.test(line) ||
      /Corporate:.*\$/.test(line) ||
      /Student Rate/.test(line) ||
      /Single issues/.test(line) ||
      /Back issues/.test(line) ||
      /annual subscription/i.test(line);

    if (isAdLine) {
      skipCount = 2;
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}

function removeTocBlocks(text: string): string {
  return text.replace(/^[^\n]{10,60}\.{4,}\s*\d+\s*$/gm, "");
}

function fixColumnArtifacts(text: string, flags: string[]): string {
  const lines = text.split("\n");
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / (lines.length || 1);

  const shortLines = lines.filter((l) => l.trim().length > 0 && l.trim().length < 40).length;
  const ratio = shortLines / (lines.filter((l) => l.trim().length > 0).length || 1);

  if (ratio > 0.6 && avgLen < 50) {
    const joined: string[] = [];
    let buffer = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") {
        if (buffer) { joined.push(buffer); buffer = ""; }
        joined.push("");
        continue;
      }
      if (buffer && /^[a-z,;:)]/.test(trimmed)) {
        buffer += " " + trimmed;
      } else {
        if (buffer) joined.push(buffer);
        buffer = trimmed;
      }
    }
    if (buffer) joined.push(buffer);
    flags.push("column-join-attempted");
    return joined.join("\n");
  }

  return text;
}

// ── Section heading detection (used by chunker) ──────────────────────────────

export function detectSectionHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 120) return null;

  // ALL CAPS heading
  if (/^[A-Z][A-Z\s\-:]{4,}$/.test(trimmed)) return trimmed;

  // Numbered heading like "1. Introduction" or "1.2 Methods"
  if (/^\d+(\.\d+)?\s+[A-Z][a-zA-Z\s]{3,}$/.test(trimmed)) return trimmed;

  // Title case heading (mixed-case, ≤8 words, no trailing period)
  // Extended to catch JEM article headers like "Literature Review", "Study Limitations"
  if (
    /^[A-Z][a-zA-Z\s\-:,]{4,}$/.test(trimmed) &&
    !trimmed.endsWith(".") &&
    !trimmed.endsWith(",") &&
    trimmed.split(" ").length <= 8 &&
    // Must not look like a person's name/affiliation line
    !/\b(PhD|MD|MPH|DPA|EdD|MS|MA|BA|University|College|Institute|Department)\b/.test(trimmed)
  ) {
    return trimmed;
  }

  return null;
}
