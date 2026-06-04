export interface SourceProvenanceAliases {
  documentId: string;
  document_id: string;
  document: string;
  source: string;
  page: string | null;
  rawFilename: string;
}

export function formatPageRange(pageStart: number, pageEnd: number): string | null {
  if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd) || pageStart <= 0 || pageEnd <= 0) {
    return null;
  }
  return pageStart === pageEnd ? `p. ${pageStart}` : `pp. ${pageStart}-${pageEnd}`;
}

export function buildSourceProvenanceAliases(input: {
  documentId: string;
  sourceFile: string;
  displayTitle?: string | null;
  pageStart: number;
  pageEnd: number;
}): SourceProvenanceAliases {
  const title = input.displayTitle || input.sourceFile;
  return {
    documentId: input.documentId,
    document_id: input.documentId,
    document: title,
    source: title,
    page: formatPageRange(input.pageStart, input.pageEnd),
    rawFilename: input.sourceFile,
  };
}
