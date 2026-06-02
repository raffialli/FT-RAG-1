export interface RagChunk {
  chunkId: string;
  documentId: string;
  sourceFile: string;
  pageStart: number;
  pageEnd: number;
  sectionPath: string | null;
  text: string;
  cleaningFlags: string[];
  qualityNotes: string[];
}

export interface RagDocument {
  id: string;
  filename: string;
  filePath: string;
  pageCount: number;
  chunkCount: number;
  ingestedAt: string;
  status: "ingested" | "error" | "pending";
  cleaningFlags: string[];
}

export interface VectorRecord {
  chunkId: string;
  documentId: string;
  sourceFile: string;
  pageStart: number;
  pageEnd: number;
  sectionPath: string | null;
  text: string;
  cleaningFlags: string[];
  embedding: number[];
}

export interface VectorIndex {
  version: number;
  embeddingModel: string;
  updatedAt: string;
  records: VectorRecord[];
}

export interface RetrievedChunk extends RagChunk {
  score: number;
  vectorScore: number;
  bm25Score: number;
  rerankScore: number;
  retrievalMethod: string;
}

export interface AnswerSource {
  sourceFile: string;
  pageStart: number;
  pageEnd: number;
  sectionPath: string | null;
  snippet: string;
  supportLevel: "direct" | "partial" | "weak";
  score: number;
}

export interface QueryResult {
  answer: string;
  confidence: "high" | "medium" | "low" | "insufficient";
  confidenceReason: string;
  sources: AnswerSource[];
  retrievedChunks: RetrievedChunk[];
  warnings: string[];
  durationMs: number;
  debugTrace?: Record<string, unknown>;
}

export interface ComparisonReport {
  id: string;
  question: string;
  candidateAnswer: string;
  candidateConfidence: string;
  candidateSources: AnswerSource[];
  evidenceQuality: string;
  classification: string;
  notes: string | null;
  createdAt: string;
}
