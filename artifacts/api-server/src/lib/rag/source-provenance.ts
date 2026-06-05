import type { AnswerSource, RetrievedChunk } from "./types.js";
import { querySupportLevel } from "./scoring.js";
import { getDisplayTitle } from "./source-titles.js";
import { buildSourceProvenanceAliases } from "./source-provenance-core.js";

export function buildAnswerSource(query: string, chunk: RetrievedChunk): AnswerSource {
  const displayTitle = getDisplayTitle(chunk.sourceFile);
  const supportLevel = querySupportLevel(query, chunk.score, chunk.text, chunk.sectionPath);
  const provenance = buildSourceProvenanceAliases({
    documentId: chunk.documentId,
    sourceFile: chunk.sourceFile,
    displayTitle,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
  });

  return {
    ...provenance,
    sourceFile: chunk.sourceFile,
    displayTitle,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    sectionPath: chunk.sectionPath,
    snippet: chunk.text.substring(0, 300) + (chunk.text.length > 300 ? "..." : ""),
    supportLevel,
    supportLabel: supportLevel,
    score: chunk.score,
  };
}

export function buildAnswerSources(query: string, chunks: RetrievedChunk[]): AnswerSource[] {
  return chunks.map((chunk) => buildAnswerSource(query, chunk));
}
