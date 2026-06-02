/**
 * OCR/layout cleanup for messy PDFs.
 * Handles: broken hyphenation, repeated headers/footers, page numbers,
 * column artifacts, copyright/frontmatter, ads, index/reference noise.
 */

export interface CleanResult {
  cleanedText: string;
  cleaningFlags: string[];
  qualityNotes: string[];
}

export function cleanOcrText(rawText: string, filename: string): CleanResult {
  const flags: string[] = [];
  const notes: string[] = [];
  let text = rawText;

  // 1. Normalize unicode and line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u00ad/g, ""); // soft hyphens
  text = text.replace(/\ufffd/g, " "); // replacement chars

  // 2. Fix broken hyphenation across lines (word- \n continuation)
  const beforeHyphen = text.length;
  text = text.replace(/(\w)-\s*\n\s*([a-z])/g, "$1$2");
  if (text.length !== beforeHyphen) {
    flags.push("fixed-hyphenation");
  }

  // 3. Remove repeated journal headers/footers
  // Patterns like "Journal of Emergency Management" appearing on every page
  const journalHeaderPattern = /Journal of Emergency Management\s*\n\s*Vol\.[^\n]*/gi;
  if (journalHeaderPattern.test(text)) {
    text = text.replace(/Journal of Emergency Management\s*\n\s*Vol\.[^\n]*/gi, "");
    flags.push("removed-journal-headers");
  }

  // Remove DOI lines and SA-Weston artifact lines
  text = text.replace(/DOI:[^\n]*\n/gi, "");
  text = text.replace(/SA-Weston[^\n]*\n/gi, "");

  // 4. Remove page numbers (standalone numbers on their own line)
  const pageNumPattern = /^\s*\d{1,4}\s*$/gm;
  if (pageNumPattern.test(text)) {
    text = text.replace(/^\s*\d{1,4}\s*$/gm, "");
    flags.push("removed-page-numbers");
  }

  // 5. Detect and remove frontmatter / copyright blocks
  if (
    /ISSN \d{4}-\d{4}/.test(text) ||
    /Copyright.*\d{4}/.test(text) ||
    /All rights reserved/.test(text)
  ) {
    text = removeFrontmatterBlock(text);
    flags.push("removed-frontmatter");
  }

  // 6. Remove advertisement blocks (subscription info, price lists)
  if (/US \$\d+/.test(text) || /subscription/i.test(text)) {
    text = removeAdBlocks(text);
    flags.push("removed-ads");
  }

  // 7. Remove table of contents patterns
  if (/^\s*\d+\s*\.\s*[A-Z][^\n]{5,50}\s*\.{3,}\s*\d+\s*$/m.test(text)) {
    text = removeTocBlocks(text);
    flags.push("removed-toc");
  }

  // 8. Remove reference sections at end
  const refMatch = text.search(/\n\s*(References?|Bibliography|REFERENCES?)\s*\n/);
  if (refMatch !== -1 && refMatch > text.length * 0.5) {
    text = text.substring(0, refMatch);
    flags.push("removed-references");
  }

  // 9. Fix multi-column OCR artifacts (lines that are too short and alternating)
  text = fixColumnArtifacts(text, flags);

  // 10. Normalize whitespace
  text = text.replace(/\n{3,}/g, "\n\n"); // max 2 blank lines
  text = text.replace(/[ \t]{2,}/g, " "); // multiple spaces → single
  text = text.trim();

  // 11. Quality check
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 50) {
    notes.push("very-short-document");
  }
  const avgLineLen = text.split("\n").reduce((s, l) => s + l.length, 0) / (text.split("\n").length || 1);
  if (avgLineLen < 20) {
    notes.push("short-avg-line-length-possible-column-artifact");
  }

  return { cleanedText: text, cleaningFlags: flags, qualityNotes: notes };
}

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
      /Disclaimer:/.test(line);

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
      /Single issues/.test(line);

    if (isAdLine) {
      skipCount = 2;
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}

function removeTocBlocks(text: string): string {
  // Remove lines that look like "Chapter Title ............. 12"
  return text.replace(/^[^\n]{10,60}\.{4,}\s*\d+\s*$/gm, "");
}

function fixColumnArtifacts(text: string, flags: string[]): string {
  const lines = text.split("\n");
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / (lines.length || 1);

  // If a lot of lines are very short, try to join them
  const shortLines = lines.filter((l) => l.trim().length > 0 && l.trim().length < 40).length;
  const ratio = shortLines / (lines.filter((l) => l.trim().length > 0).length || 1);

  if (ratio > 0.6 && avgLen < 50) {
    // Attempt column joining: join consecutive short lines that don't start with capital
    const joined: string[] = [];
    let buffer = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") {
        if (buffer) {
          joined.push(buffer);
          buffer = "";
        }
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

export function detectSectionHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 120) return null;

  // ALL CAPS heading
  if (/^[A-Z][A-Z\s\-:]{4,}$/.test(trimmed)) return trimmed;

  // Numbered heading like "1. Introduction" or "1.2 Methods"
  if (/^\d+(\.\d+)?\s+[A-Z][a-zA-Z\s]{3,}$/.test(trimmed)) return trimmed;

  // Title case heading that doesn't end with period
  if (
    /^[A-Z][a-zA-Z\s\-:,]{4,}$/.test(trimmed) &&
    !trimmed.endsWith(".") &&
    trimmed.split(" ").length <= 8
  ) {
    return trimmed;
  }

  return null;
}
