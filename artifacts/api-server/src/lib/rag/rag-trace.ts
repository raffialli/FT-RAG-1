import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CitationValidation, RetrievedChunk } from "./types.js";

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..");
const DATA_DIR = process.env.RAG_DATA_DIR ?? path.join(WORKSPACE_ROOT, "candidate-rag", "data");

export type RagFailureLayer =
  | "upload/save"
  | "extraction/ocr"
  | "cleaning/normalization"
  | "chunking"
  | "embedding/vector"
  | "bm25/search"
  | "fusion/rerank"
  | "prompt/context"
  | "generation"
  | "citation/confidence"
  | "ui/api"
  | "none"
  | "unknown";

export interface TraceChunkSummary {
  rank?: number;
  chunkId: string;
  documentId: string;
  sourceFile: string;
  pageStart: number;
  pageEnd: number;
  sectionPath: string | null;
  score?: number;
  vectorScore?: number;
  bm25Score?: number;
  rerankScore?: number;
  noiseScore?: number;
  noiseCategory?: string;
  textHash?: string;
  textPreview?: string;
  text?: string;
  reason?: string;
}

export interface PromptExcerptTrace {
  citationIndex: number;
  chunkId: string;
  sourceFile: string;
  pageStart: number;
  pageEnd: number;
  sectionPath: string | null;
  excerptChars: number;
  excerptHash: string;
  excerptPreview?: string;
  excerpt?: string;
}

export interface AnswerTrace {
  modelProvider: string;
  model: string;
  promptChars: number;
  evidenceBlockChars: number;
  selectedExcerpts: PromptExcerptTrace[];
  answerChars: number;
  answerPreview: string;
  refusal: boolean;
  confidence: string;
  confidenceReason: string;
  evidenceSufficiency: string;
  citationValidation: CitationValidation;
  warnings: string[];
}

export interface RagTrace {
  traceId: string;
  timestamp: string;
  app: {
    version: string | null;
    branch: string | null;
    commit: string | null;
    nodeEnv: string | null;
  };
  request: {
    requestId: string | null;
    query: string;
    normalizedQuery: string;
    expandedTerms: string[];
    topK: number;
    includeEvidence: boolean;
    includeDebug: boolean;
  };
  corpus: {
    documentCount: number;
    manifestChunkCount: number;
    vectorCount: number;
    embeddingModel: string;
    scope: string;
  };
  config: {
    retrieval: Record<string, unknown>;
    generation: {
      provider: string;
      model: string;
      promptMaxExcerptChars: number;
    };
    tracing: {
      enabled: boolean;
      persisted: boolean;
      fullText: boolean;
    };
  };
  retrieval: Record<string, unknown>;
  answer: AnswerTrace | null;
  latencyMs: Record<string, number>;
  failure: {
    layer: RagFailureLayer;
    reasons: string[];
  };
  errors: string[];
  warnings: string[];
}

export interface TraceRuntimeConfig {
  traceEnabled: boolean;
  includeFullText: boolean;
  persistTrace: boolean;
  traceDir: string;
}

export function getTraceRuntimeConfig(): TraceRuntimeConfig {
  const traceEnabled = envFlag("RAG_TRACE_ENABLED");
  return {
    traceEnabled,
    includeFullText: envFlag("RAG_TRACE_FULL_TEXT"),
    persistTrace: traceEnabled && envFlag("RAG_TRACE_PERSIST"),
    traceDir: process.env.RAG_TRACE_DIR ?? path.join(DATA_DIR, "traces"),
  };
}

export function makeTraceId(): string {
  return `rag_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function summarizeChunk(
  chunk: RetrievedChunk,
  options: { rank?: number; includeFullText?: boolean; reason?: string } = {}
): TraceChunkSummary {
  const summary: TraceChunkSummary = {
    rank: options.rank,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    sourceFile: chunk.sourceFile,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    sectionPath: chunk.sectionPath,
    score: round(chunk.score),
    vectorScore: round(chunk.vectorScore),
    bm25Score: round(chunk.bm25Score),
    rerankScore: round(chunk.rerankScore),
    noiseScore: round(chunk.noiseScore),
    noiseCategory: chunk.noiseCategory,
    textHash: hashText(chunk.text),
    textPreview: preview(chunk.text),
    reason: options.reason,
  };
  if (options.includeFullText) summary.text = chunk.text;
  return summary;
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function preview(text: string, chars = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, chars);
}

export function round(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function buildQueryTrace(query: string): { normalizedQuery: string; expandedTerms: string[] } {
  return {
    normalizedQuery: normalizeForSearch(query),
    expandedTerms: [...new Set(tokenize(query))].sort(),
  };
}

export function classifyTraceFailure(input: {
  retrievedChunks: RetrievedChunk[];
  answer: AnswerTrace | null;
  retrievalDebug?: Record<string, unknown> | null;
  errors?: string[];
}): { layer: RagFailureLayer; reasons: string[] } {
  const reasons: string[] = [];
  if (input.errors?.length) {
    return { layer: "ui/api", reasons: input.errors };
  }
  if (input.retrievedChunks.length === 0) {
    const debug = input.retrievalDebug ?? {};
    const vectorCandidates = Number(debug.vectorCandidates ?? 0);
    const bm25Candidates = Number(debug.bm25Candidates ?? 0);
    if (vectorCandidates === 0 && bm25Candidates === 0) {
      reasons.push("No vector or BM25 candidates were produced.");
      return { layer: "bm25/search", reasons };
    }
    reasons.push("Candidates existed but no final chunks reached answer generation.");
    return { layer: "fusion/rerank", reasons };
  }
  if (!input.answer) {
    return { layer: "generation", reasons: ["No answer trace was produced."] };
  }
  if (input.answer.refusal && input.retrievedChunks.length > 0) {
    return { layer: "generation", reasons: ["Generated answer refused despite retrieved evidence."] };
  }
  if (!input.answer.citationValidation.allValid && input.answer.answerChars > 50) {
    return { layer: "citation/confidence", reasons: input.answer.citationValidation.warnings };
  }
  if (input.answer.evidenceSufficiency === "insufficient" && input.retrievedChunks.length > 0) {
    reasons.push("Evidence was retrieved but scored insufficient.");
    return { layer: "citation/confidence", reasons };
  }
  return { layer: "none", reasons };
}

export function persistTraceIfEnabled(trace: RagTrace, config = getTraceRuntimeConfig()): string | null {
  if (!config.persistTrace) return null;
  fs.mkdirSync(config.traceDir, { recursive: true });
  const safeName = `${trace.timestamp.replace(/[:.]/g, "-")}_${trace.traceId}.json`;
  const tracePath = path.join(config.traceDir, safeName);
  fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
  return tracePath;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");
}

function tokenize(text: string): string[] {
  return (normalizeForSearch(text).match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? [])
    .flatMap((token) => {
      const tokens = new Set([token, stemToken(token)]);
      if (token === "magnitudes" || token === "magnitude") tokens.add("mw");
      if (token === "mw") tokens.add("magnitude");
      if (token === "earthquakes" || token === "earthquake") tokens.add("quake");
      if (token === "locations" || token === "location") {
        for (const term of ["place", "city", "district", "zone"]) tokens.add(term);
      }
      return [...tokens];
    })
    .filter((token) => token.length > 2 || token === "mw");
}

function stemToken(token: string): string {
  if (/\d/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && /(ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}
