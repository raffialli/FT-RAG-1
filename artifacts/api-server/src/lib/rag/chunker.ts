import { detectSectionHeading } from "./ocr-cleaner.js";
import type { RagChunk } from "./types.js";

const TARGET_CHUNK_CHARS = 2400; // ~600 tokens
const MIN_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 4000;
const OVERLAP_CHARS = 300;

export interface ChunkInput {
  documentId: string;
  sourceFile: string;
  cleanedText: string;
  pageTexts: string[]; // per-page text for page attribution
  cleaningFlags: string[];
}

export function chunkDocument(input: ChunkInput): RagChunk[] {
  const { documentId, sourceFile, cleanedText, pageTexts, cleaningFlags } = input;
  const chunks: RagChunk[] = [];

  // Build page offset map
  const pageOffsets = buildPageOffsets(pageTexts, cleanedText);

  // Split into sections first
  const sections = splitIntoSections(cleanedText);

  let chunkIndex = 0;

  for (const section of sections) {
    const sectionChunks = splitSectionIntoChunks(
      section.text,
      section.heading,
      documentId,
      sourceFile,
      pageOffsets,
      cleaningFlags,
      chunkIndex
    );
    chunks.push(...sectionChunks);
    chunkIndex += sectionChunks.length;
  }

  return chunks.filter((c) => isUsableChunk(c.text));
}

interface Section {
  heading: string | null;
  text: string;
}

function splitIntoSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const heading = detectSectionHeading(line);
    if (heading && currentLines.join("").trim().length > 100) {
      sections.push({ heading: currentHeading, text: currentLines.join("\n").trim() });
      currentHeading = heading;
      currentLines = [];
    } else {
      currentLines.push(line);
      if (heading && !currentHeading) {
        currentHeading = heading;
      }
    }
  }

  if (currentLines.join("").trim().length > 0) {
    sections.push({ heading: currentHeading, text: currentLines.join("\n").trim() });
  }

  return sections.filter((s) => s.text.trim().length > MIN_CHUNK_CHARS);
}

function splitSectionIntoChunks(
  text: string,
  sectionHeading: string | null,
  documentId: string,
  sourceFile: string,
  pageOffsets: PageOffset[],
  cleaningFlags: string[],
  startIndex: number
): RagChunk[] {
  const chunks: RagChunk[] = [];

  if (text.length <= MAX_CHUNK_CHARS) {
    // Fits in a single chunk
    const pages = getPagesForText(text, 0, pageOffsets);
    chunks.push({
      chunkId: makeChunkId(documentId, startIndex),
      documentId,
      sourceFile,
      pageStart: pages.start,
      pageEnd: pages.end,
      sectionPath: sectionHeading,
      text: text.trim(),
      cleaningFlags,
      qualityNotes: [],
    });
    return chunks;
  }

  // Split into overlapping chunks at sentence boundaries
  const sentences = splitIntoSentences(text);
  let buffer = "";
  let bufferStart = 0;
  let chunkIdx = startIndex;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (buffer.length + sentence.length > TARGET_CHUNK_CHARS && buffer.length > MIN_CHUNK_CHARS) {
      const pages = getPagesForText(buffer, bufferStart, pageOffsets);
      chunks.push({
        chunkId: makeChunkId(documentId, chunkIdx++),
        documentId,
        sourceFile,
        pageStart: pages.start,
        pageEnd: pages.end,
        sectionPath: sectionHeading,
        text: buffer.trim(),
        cleaningFlags,
        qualityNotes: [],
      });

      // Overlap: go back a few sentences
      const overlapSentences = getOverlapSentences(sentences, i, OVERLAP_CHARS);
      buffer = overlapSentences + sentence;
      bufferStart = text.indexOf(overlapSentences) >= 0 ? text.indexOf(overlapSentences) : bufferStart;
    } else {
      buffer += (buffer ? " " : "") + sentence;
    }
  }

  if (buffer.trim().length > MIN_CHUNK_CHARS) {
    const pages = getPagesForText(buffer, bufferStart, pageOffsets);
    chunks.push({
      chunkId: makeChunkId(documentId, chunkIdx++),
      documentId,
      sourceFile,
      pageStart: pages.start,
      pageEnd: pages.end,
      sectionPath: sectionHeading,
      text: buffer.trim(),
      cleaningFlags,
      qualityNotes: [],
    });
  }

  return chunks;
}

function splitIntoSentences(text: string): string[] {
  // Split on sentence boundaries while preserving structure
  const raw = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return raw.filter((s) => s.trim().length > 0);
}

function getOverlapSentences(sentences: string[], currentIdx: number, targetChars: number): string {
  let result = "";
  let i = currentIdx - 1;
  while (i >= 0 && result.length < targetChars) {
    result = sentences[i] + " " + result;
    i--;
  }
  return result.trim() ? result.trim() + " " : "";
}

function makeChunkId(documentId: string, index: number): string {
  return `${documentId}__chunk_${String(index).padStart(4, "0")}`;
}

interface PageOffset {
  page: number;
  startOffset: number;
  endOffset: number;
}

function buildPageOffsets(pageTexts: string[], fullText: string): PageOffset[] {
  const offsets: PageOffset[] = [];
  let cursor = 0;
  for (let i = 0; i < pageTexts.length; i++) {
    const pageLen = pageTexts[i].length;
    offsets.push({
      page: i + 1,
      startOffset: cursor,
      endOffset: cursor + pageLen,
    });
    cursor += pageLen;
  }
  return offsets;
}

function getPagesForText(
  text: string,
  textStartOffset: number,
  pageOffsets: PageOffset[]
): { start: number; end: number } {
  if (pageOffsets.length === 0) return { start: 1, end: 1 };

  const textEnd = textStartOffset + text.length;
  let startPage = 1;
  let endPage = pageOffsets[pageOffsets.length - 1].page;

  for (const po of pageOffsets) {
    if (po.startOffset <= textStartOffset && textStartOffset < po.endOffset) {
      startPage = po.page;
    }
    if (po.startOffset <= textEnd && textEnd <= po.endOffset) {
      endPage = po.page;
      break;
    }
  }

  return { start: startPage, end: endPage };
}

function isUsableChunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHUNK_CHARS) return false;

  // Reject chunks that are mostly references / bibliography
  const referenceLineRatio =
    (trimmed.match(/^\s*\d+\.\s+[A-Z]/gm) || []).length / (trimmed.split("\n").length || 1);
  if (referenceLineRatio > 0.5) return false;

  // Reject chunks that are mostly page numbers and headers
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 20) return false;

  return true;
}
