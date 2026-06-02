/**
 * Embeddings: nomic-embed-text-v1.5 via @huggingface/transformers (local ONNX, no API key)
 * Generation: Ollama Cloud /api/chat (qwen3.5:397b or configured model)
 *
 * Ollama Cloud only exposes /api/chat and /api/generate for text generation —
 * the /api/embed endpoint is not available on the cloud service.
 * We run nomic-embed-text-v1.5 locally via ONNX Runtime instead.
 */

import path from "node:path";

// ── Local embedding model ─────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..");
const HF_CACHE = process.env.HF_CACHE_DIR ?? path.join(WORKSPACE_ROOT, ".hf-cache");
const EMBED_MODEL = "nomic-ai/nomic-embed-text-v1.5";

// Lazy singleton — loaded on first call, reused across the process lifetime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;

async function getEmbedder() {
  if (_embedder) return _embedder;

  // Dynamic import so esbuild bundles it correctly
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = HF_CACHE;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;

  _embedder = await pipeline("feature-extraction", EMBED_MODEL, {
    dtype: "q8",   // int8 quantised — ~135 MB, fast on CPU
    device: "cpu",
  });
  return _embedder;
}

async function _embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // nomic-embed-text uses task prefixes for best quality
  const out = await pipe(text, { pooling: "mean", normalize: true });
  // out.data is Float32Array; convert to plain number[]
  return Array.from(out.data as Float32Array);
}

/** Embed a document chunk (uses search_document: prefix). */
export async function embedText(text: string): Promise<number[]> {
  return _embed(`search_document: ${text}`);
}

/** Embed a user query (uses search_query: prefix). */
export async function embedQuery(text: string): Promise<number[]> {
  return _embed(`search_query: ${text}`);
}

/** Embed a batch of document texts with a configurable batch size. */
export async function embedBatch(texts: string[], batchSize = 8): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(embedText));
    results.push(...batchResults);
  }
  return results;
}

// ── Ollama Cloud generation ───────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://ollama.com";

function ollamaConfig() {
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey: process.env.OLLAMA_API_KEY ?? "",
    generationModel: process.env.GENERATION_MODEL ?? "qwen3.5:397b",
  };
}

function ollamaHeaders(): Record<string, string> {
  const { apiKey } = ollamaConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export async function generateAnswer(prompt: string, timeoutMs = 180000): Promise<string> {
  const { baseUrl, generationModel } = ollamaConfig();

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: generationModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: { temperature: 0.15, top_p: 0.9, num_predict: 1200 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Ollama chat failed ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    message?: { role?: string; content?: string };
  };

  const answer = data.message?.content?.trim();
  if (!answer) throw new Error("Ollama returned empty generation");
  return answer;
}

// ── Connectivity test (used by Models tab) ───────────────────────────────────

export async function testConnectivity(): Promise<{
  embeddingOk: boolean;
  generationOk: boolean;
  embeddingError: string | null;
  generationError: string | null;
  embeddingDims: number | null;
  generationSample: string | null;
  embeddingModel: string;
  generationModel: string;
  ollamaBaseUrl: string;
}> {
  const { baseUrl, generationModel } = ollamaConfig();

  let embeddingOk = false;
  let embeddingError: string | null = null;
  let embeddingDims: number | null = null;

  try {
    const vec = await embedQuery("test connectivity");
    embeddingOk = true;
    embeddingDims = vec.length;
  } catch (e) {
    embeddingError = String(e);
  }

  let generationOk = false;
  let generationError: string | null = null;
  let generationSample: string | null = null;

  try {
    const ans = await generateAnswer("Reply with exactly the word: ok", 30000);
    generationOk = true;
    generationSample = ans.substring(0, 100);
  } catch (e) {
    generationError = String(e);
  }

  return {
    embeddingOk,
    generationOk,
    embeddingError,
    generationError,
    embeddingDims,
    generationSample,
    embeddingModel: EMBED_MODEL,
    generationModel,
    ollamaBaseUrl: baseUrl,
  };
}
