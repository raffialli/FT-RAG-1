/**
 * Embeddings: Xenova/all-MiniLM-L6-v2 via @huggingface/transformers (local ONNX, ~23 MB q8)
 * Generation: Ollama Cloud /api/chat or OpenAI Chat Completions
 *
 * Why this model:
 *  - nomic-embed-text-v1.5 (~135 MB) + ONNX Runtime initialization exceeds Replit's memory limit
 *  - all-MiniLM-L6-v2 q8 is only ~23 MB; total RSS stays well under 512 MB
 *  - 384-dim embeddings; good quality for English semantic search
 *
 * Batching is intentionally serial (concurrency=1) to keep the ONNX session
 * memory flat — running 8 parallel inference sessions would OOM the container.
 */

import path from "node:path";

// ── Local embedding model ─────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..");
const HF_CACHE = process.env.HF_CACHE_DIR ?? path.join(WORKSPACE_ROOT, ".hf-cache");
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;

async function getEmbedder() {
  if (_embedder) return _embedder;
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = HF_CACHE;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  _embedder = await pipeline("feature-extraction", EMBED_MODEL, {
    dtype: "q8",
    device: "cpu",
  });
  return _embedder;
}

/** Embed a single text. */
export async function embedText(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

/** Embed a query — same function, separated for parity with nomic prefixes. */
export async function embedQuery(text: string): Promise<number[]> {
  return embedText(text);
}

/**
 * Embed a batch of texts SERIALLY (one at a time) to keep memory flat.
 * DO NOT use Promise.all here — running concurrent ONNX sessions OOMs Replit.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text));
  }
  return results;
}

// ── Answer generation providers ───────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://ollama.com";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
type GenerationProvider = "ollama" | "openai";

function generationProvider(): GenerationProvider {
  return process.env.GENERATION_PROVIDER === "openai" ? "openai" : "ollama";
}

function ollamaConfig() {
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey: process.env.OLLAMA_API_KEY ?? "",
    generationModel: process.env.GENERATION_MODEL ?? "qwen3.5:397b",
  };
}

function ollamaHeaders(): Record<string, string> {
  const { apiKey } = ollamaConfig();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

function openAIConfig() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, ""),
    apiKey: process.env.OPENAI_API_KEY ?? "",
    generationModel: process.env.OPENAI_GENERATION_MODEL ?? "gpt-4.1-mini",
  };
}

function openAIHeaders(): Record<string, string> {
  const { apiKey } = openAIConfig();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function generateWithOllama(prompt: string, timeoutMs: number): Promise<string> {
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
    const err = await response.text().catch(() => "");
    throw new Error(`Ollama chat failed ${response.status}: ${err}`);
  }
  const data = (await response.json()) as { message?: { content?: string } };
  const answer = data.message?.content?.trim();
  if (!answer) throw new Error("Ollama returned empty generation");
  return answer;
}

function extractOpenAIContent(data: { choices?: Array<{ message?: { content?: unknown } }> }): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

async function generateWithOpenAI(prompt: string, timeoutMs: number): Promise<string> {
  const { baseUrl, generationModel } = openAIConfig();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: generationModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.15,
      top_p: 0.9,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`OpenAI chat failed ${response.status}: ${err}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const answer = extractOpenAIContent(data);
  if (!answer) throw new Error("OpenAI returned empty generation");
  return answer;
}

export async function generateAnswer(prompt: string, timeoutMs = 180000): Promise<string> {
  return generationProvider() === "openai"
    ? generateWithOpenAI(prompt, timeoutMs)
    : generateWithOllama(prompt, timeoutMs);
}

// ── Connectivity test ─────────────────────────────────────────────────────────

export async function testConnectivity(): Promise<{
  embeddingOk: boolean;
  generationOk: boolean;
  embeddingError: string | null;
  generationError: string | null;
  embeddingDims: number | null;
  generationSample: string | null;
  generationProvider: GenerationProvider;
  embeddingModel: string;
  generationModel: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string | null;
}> {
  const provider = generationProvider();
  const ollama = ollamaConfig();
  const openai = openAIConfig();

  let embeddingOk = false, embeddingError: string | null = null, embeddingDims: number | null = null;
  try {
    const vec = await embedQuery("connectivity test");
    embeddingOk = true;
    embeddingDims = vec.length;
  } catch (e) { embeddingError = String(e); }

  let generationOk = false, generationError: string | null = null, generationSample: string | null = null;
  try {
    const ans = await generateAnswer("Reply with exactly the word: ok", 30000);
    generationOk = true;
    generationSample = ans.substring(0, 100);
  } catch (e) { generationError = String(e); }

  return {
    embeddingOk, generationOk,
    embeddingError, generationError,
    embeddingDims, generationSample,
    generationProvider: provider,
    embeddingModel: EMBED_MODEL,
    generationModel: provider === "openai" ? openai.generationModel : ollama.generationModel,
    ollamaBaseUrl: ollama.baseUrl,
    openaiBaseUrl: provider === "openai" ? openai.baseUrl : null,
  };
}
