import fs from "node:fs";
import path from "node:path";
import type { RagEvalCase, RagEvalResult } from "./rag-eval.js";
import type { RagTrace } from "./rag-trace.js";

const evalModuleUrl = new URL("./rag-eval.ts", import.meta.url).href;
const { evaluateTraceAgainstCase } = await import(evalModuleUrl) as typeof import("./rag-eval.js");

interface RunnerOutput {
  mode: "api" | "trace-file" | "trace-dir";
  caseCount: number;
  passed: number;
  failed: number;
  results: RagEvalResult[];
}

const casesPath = process.env.RAG_EVAL_CASES ?? path.join(
  process.cwd(),
  "src",
  "lib",
  "rag",
  "rag-eval-cases.synthetic.json"
);

const cases = readJson<RagEvalCase[]>(casesPath);
const output = await runEval(cases);
console.log(JSON.stringify(output, null, 2));

if (output.failed > 0 && process.env.RAG_EVAL_ALLOW_FAILURES !== "true") {
  process.exitCode = 1;
}

async function runEval(casesToRun: RagEvalCase[]): Promise<RunnerOutput> {
  if (process.env.RAG_EVAL_BASE_URL) {
    return evaluateApi(casesToRun, process.env.RAG_EVAL_BASE_URL);
  }
  if (process.env.RAG_EVAL_TRACE_FILE) {
    const trace = readJson<RagTrace>(process.env.RAG_EVAL_TRACE_FILE);
    return summarize("trace-file", casesToRun.map((testCase) => evaluateTraceAgainstCase(testCase, trace)));
  }
  if (process.env.RAG_EVAL_TRACE_DIR) {
    const traces = fs.readdirSync(process.env.RAG_EVAL_TRACE_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson<RagTrace>(path.join(process.env.RAG_EVAL_TRACE_DIR as string, file)));
    const results = casesToRun.map((testCase) => {
      const matchingTrace = traces.find((trace) => trace.request.query === testCase.question);
      if (!matchingTrace) {
        return {
          id: testCase.id,
          passed: false,
          failureLayer: "diagnostic/search issue" as const,
          reasons: ["No trace in RAG_EVAL_TRACE_DIR matched this case question."],
        };
      }
      return evaluateTraceAgainstCase(testCase, matchingTrace);
    });
    return summarize("trace-dir", results);
  }
  throw new Error("Set RAG_EVAL_BASE_URL, RAG_EVAL_TRACE_FILE, or RAG_EVAL_TRACE_DIR.");
}

async function evaluateApi(casesToRun: RagEvalCase[], baseUrl: string): Promise<RunnerOutput> {
  const results: RagEvalResult[] = [];
  for (const testCase of casesToRun) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/rag/query`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        query: testCase.question,
        topK: 5,
        includeEvidence: true,
        includeDebug: false,
        includeTrace: true,
      }),
    });
    if (!response.ok) {
      results.push({
        id: testCase.id,
        passed: false,
        failureLayer: "diagnostic/search issue",
        reasons: [`API returned ${response.status}: ${await response.text()}`],
      });
      continue;
    }
    const body = await response.json() as { trace?: RagTrace | null };
    if (!body.trace) {
      results.push({
        id: testCase.id,
        passed: false,
        failureLayer: "diagnostic/search issue",
        reasons: ["API response did not include trace. Ensure includeTrace is supported and true."],
      });
      continue;
    }
    results.push(evaluateTraceAgainstCase(testCase, body.trace));
  }
  return summarize("api", results);
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.RAG_EVAL_AUTH_HEADER) {
    headers.Authorization = process.env.RAG_EVAL_AUTH_HEADER;
  } else if (process.env.FT_USER && process.env.FT_PASS) {
    const credentials = Buffer.from(`${process.env.FT_USER}:${process.env.FT_PASS}`).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  }
  return headers;
}

function summarize(mode: RunnerOutput["mode"], results: RagEvalResult[]): RunnerOutput {
  const passed = results.filter((result) => result.passed).length;
  return {
    mode,
    caseCount: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
