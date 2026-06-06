import crypto from "node:crypto";
import type { RagTrace, TraceChunkSummary } from "./rag-trace.js";

const DEFAULT_ENDPOINT = "https://api.smith.langchain.com";
const DEFAULT_TIMEOUT_MS = 2500;

export interface LangSmithExportConfig {
  enabled: boolean;
  endpoint: string;
  project: string | null;
  includeText: boolean;
  timeoutMs: number;
  missing: string[];
}

export interface LangSmithExportResult {
  attempted: boolean;
  success: boolean;
  runId: string | null;
  error?: string;
}

export function getLangSmithExportConfig(env: NodeJS.ProcessEnv = process.env): LangSmithExportConfig {
  const missing: string[] = [];
  if (!envFlag(env.RAG_TRACE_EXPORT_LANGSMITH)) missing.push("RAG_TRACE_EXPORT_LANGSMITH=true");
  if (!envFlag(env.LANGSMITH_TRACING)) missing.push("LANGSMITH_TRACING=true");
  if (!env.LANGSMITH_API_KEY) missing.push("LANGSMITH_API_KEY");
  if (!env.LANGSMITH_PROJECT) missing.push("LANGSMITH_PROJECT");

  return {
    enabled: missing.length === 0,
    endpoint: (env.LANGSMITH_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/$/, ""),
    project: env.LANGSMITH_PROJECT ?? null,
    includeText: envFlag(env.RAG_TRACE_INCLUDE_TEXT),
    timeoutMs: parseTimeout(env.RAG_LANGSMITH_TIMEOUT_MS),
    missing,
  };
}

export async function exportTraceToLangSmith(
  trace: RagTrace,
  options: {
    config?: LangSmithExportConfig;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<LangSmithExportResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? getLangSmithExportConfig(env);
  if (!config.enabled) return { attempted: false, success: false, runId: null };

  const runId = deterministicUuid(trace.traceId);
  const payload = buildLangSmithRunPayload(trace, { runId, config });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${config.endpoint}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.LANGSMITH_API_KEY ?? "",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        attempted: true,
        success: false,
        runId,
        error: `LangSmith export failed with HTTP ${response.status}`,
      };
    }
    return { attempted: true, success: true, runId };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      runId,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildLangSmithRunPayload(
  trace: RagTrace,
  options: { runId?: string; config?: LangSmithExportConfig } = {}
): Record<string, unknown> {
  const config = options.config ?? getLangSmithExportConfig();
  const runId = options.runId ?? deterministicUuid(trace.traceId);
  return {
    id: runId,
    name: "FalconTrust RAG Query",
    run_type: "chain",
    session_name: config.project ?? undefined,
    start_time: trace.timestamp,
    end_time: new Date(new Date(trace.timestamp).getTime() + (trace.latencyMs.total ?? 0)).toISOString(),
    inputs: {
      question: trace.request.query,
      normalizedQuery: trace.request.normalizedQuery,
      expandedTerms: trace.request.expandedTerms,
      topK: trace.request.topK,
    },
    outputs: {
      answerPreview: trace.answer?.answerPreview ?? null,
      confidence: trace.answer?.confidence ?? null,
      evidenceSufficiency: trace.answer?.evidenceSufficiency ?? null,
      refusal: trace.answer?.refusal ?? null,
      citationValidation: trace.answer?.citationValidation
        ? {
            validCitations: trace.answer.citationValidation.validCitations,
            invalidCitations: trace.answer.citationValidation.invalidCitations,
            allValid: trace.answer.citationValidation.allValid,
            warnings: trace.answer.citationValidation.warnings,
          }
        : null,
      failureLayer: trace.failure.layer,
      failureReasons: trace.failure.reasons,
    },
    metadata: {
      falconTrustTraceId: trace.traceId,
      app: trace.app,
      corpus: trace.corpus,
      retrievalConfig: trace.config.retrieval,
      generation: trace.config.generation,
      tracing: {
        localTraceEnabled: trace.config.tracing.enabled,
        localTracePersisted: trace.config.tracing.persisted,
        langSmithIncludeText: config.includeText,
      },
      latencyMs: trace.latencyMs,
      retrieval: sanitizeRetrieval(trace.retrieval, config.includeText),
      selectedExcerpts: (trace.answer?.selectedExcerpts ?? []).map((excerpt) => ({
        citationIndex: excerpt.citationIndex,
        chunkId: excerpt.chunkId,
        sourceFile: excerpt.sourceFile,
        pageStart: excerpt.pageStart,
        pageEnd: excerpt.pageEnd,
        sectionPath: excerpt.sectionPath,
        excerptChars: excerpt.excerptChars,
        excerptHash: excerpt.excerptHash,
        excerptPreview: config.includeText ? excerpt.excerptPreview : undefined,
      })),
      warnings: trace.warnings,
      errors: trace.errors,
    },
    tags: [
      "falcontrust",
      "rag",
      `failure:${trace.failure.layer}`,
      `confidence:${trace.answer?.confidence ?? "unknown"}`,
    ],
  };
}

function sanitizeRetrieval(retrieval: Record<string, unknown>, includeText: boolean): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(retrieval)) {
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => sanitizeCandidate(item, includeText));
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizeCandidate(candidate: unknown, includeText: boolean): unknown {
  if (!candidate || typeof candidate !== "object") return candidate;
  const c = candidate as TraceChunkSummary & Record<string, unknown>;
  const sanitized: Record<string, unknown> = {
    rank: c.rank,
    chunkId: c.chunkId,
    documentId: c.documentId,
    sourceFile: c.sourceFile,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    sectionPath: c.sectionPath,
    score: c.score,
    vectorScore: c.vectorScore,
    bm25Score: c.bm25Score,
    rerankScore: c.rerankScore,
    noiseScore: c.noiseScore,
    noiseCategory: c.noiseCategory,
    textHash: c.textHash,
    reason: c.reason,
  };
  if (includeText) {
    sanitized.textPreview = c.textPreview;
    sanitized.text = c.text;
  }
  return sanitized;
}

function deterministicUuid(seed: string): string {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(250, Math.min(parsed, 15_000));
}

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}
