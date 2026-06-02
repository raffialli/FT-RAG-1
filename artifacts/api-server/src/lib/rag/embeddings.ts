/**
 * Ollama Cloud embeddings using nomic-embed-text:latest
 * POST {base}/api/embed
 */

const DEFAULT_BASE_URL = "https://ollama.com";

function ollamaConfig() {
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey: process.env.OLLAMA_API_KEY ?? "",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text:latest",
    generationModel: process.env.GENERATION_MODEL ?? "qwen3.5:122b",
  };
}

function ollamaHeaders(): Record<string, string> {
  const { apiKey } = ollamaConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export async function embedText(text: string): Promise<number[]> {
  const { baseUrl, embeddingModel } = ollamaConfig();
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({ model: embeddingModel, input: text }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Ollama embed failed ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as { embeddings?: number[][] };
  const embeddings = data.embeddings;
  if (!embeddings || embeddings.length === 0) {
    throw new Error("Ollama returned empty embeddings");
  }
  return embeddings[0];
}

export async function embedBatch(texts: string[], batchSize = 8): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(embedText));
    results.push(...batchResults);
  }
  return results;
}

export async function generateAnswer(prompt: string, timeoutMs = 180000): Promise<string> {
  const { baseUrl, generationModel } = ollamaConfig();
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: generationModel,
      prompt,
      stream: false,
      think: false,
      options: { temperature: 0.15, top_p: 0.9, num_predict: 1200 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Ollama generate failed ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as { response?: string };
  const answer = data.response?.trim();
  if (!answer) throw new Error("Ollama returned empty generation");
  return answer;
}

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
  const { baseUrl, embeddingModel, generationModel } = ollamaConfig();

  let embeddingOk = false;
  let embeddingError: string | null = null;
  let embeddingDims: number | null = null;

  try {
    const vec = await embedText("test connectivity");
    embeddingOk = true;
    embeddingDims = vec.length;
  } catch (e) {
    embeddingError = String(e);
  }

  let generationOk = false;
  let generationError: string | null = null;
  let generationSample: string | null = null;

  try {
    const ans = await generateAnswer("Say 'ok' in one word.", 30000);
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
    embeddingModel,
    generationModel,
    ollamaBaseUrl: baseUrl,
  };
}
