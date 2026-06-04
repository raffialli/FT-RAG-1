import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTestModel, getTestModelQueryKey } from "@workspace/api-client-react";
import { Cpu, CheckCircle, XCircle, RefreshCw } from "lucide-react";

export default function ModelTestPanel() {
  const test = useTestModel({ query: { queryKey: getTestModelQueryKey(), enabled: false } });

  const run = () => test.refetch();
  const providerLabel = test.data?.generationProvider === "openai" ? "OpenAI" : "Ollama";
  const endpointLabel = test.data?.generationProvider === "openai" ? "OpenAI endpoint" : "Ollama endpoint";
  const endpointValue = test.data?.generationProvider === "openai" ? test.data.openaiBaseUrl : test.data?.ollamaBaseUrl;

  return (
    <div className="space-y-6 max-w-2xl">
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Cpu className="w-4 h-4 text-blue-400" /> Generation Model Check
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-slate-400 text-sm">
            Checks the active embedding model and generation provider configured for this candidate app.
          </p>

          <Button
            onClick={run}
            disabled={test.isFetching}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {test.isFetching ? (
              <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Testing…</>
            ) : (
              <><Cpu className="w-4 h-4 mr-2" /> Run Connectivity Test</>
            )}
          </Button>

          {test.isError && (
            <div className="bg-red-950 border border-red-800 rounded p-3 text-sm text-red-300">
              Error: {String(test.error)}
            </div>
          )}

          {test.data && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3">
                <ModelCard
                  label="Embedding Model"
                  modelName={test.data.embeddingModel}
                  ok={test.data.embeddingOk}
                  error={test.data.embeddingError}
                  extra={test.data.embeddingDims != null ? `${test.data.embeddingDims} dimensions` : undefined}
                />
                <ModelCard
                  label="Generation Model"
                  modelName={test.data.generationModel}
                  ok={test.data.generationOk}
                  error={test.data.generationError}
                  extra={[
                    `Provider: ${providerLabel}`,
                    test.data.generationSample ? `Sample: "${test.data.generationSample}"` : null,
                  ].filter(Boolean).join(" · ")}
                />
              </div>

              <div className="bg-slate-800 rounded p-3 space-y-1.5">
                <p className="text-xs text-slate-400 font-medium">Configuration</p>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Generation provider</span>
                  <span className="text-slate-200 font-mono">{providerLabel}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">{endpointLabel}</span>
                  <span className="text-slate-200 font-mono">{endpointValue}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Embedding model</span>
                  <span className="text-slate-200 font-mono">{test.data.embeddingModel}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Generation model</span>
                  <span className="text-slate-200 font-mono">{test.data.generationModel}</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-white text-xs">Pipeline Architecture</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-xs text-slate-400">
            {[
              ["Ingestion", "PDF → pdf-parse → OCR cleanup → section-aware chunking → embeddings → flat JSON index"],
              ["Dense retrieval", "Query → embeddings → cosine similarity top-25"],
              ["Lexical retrieval", "Query → BM25 scoring → top-25 + exact phrase rescue"],
              ["Score fusion", "Reciprocal Rank Fusion (RRF, k=60) + exact phrase bonus"],
              ["Reranking", "Evidence quality scoring: token overlap · length quality · OCR penalty · page completeness"],
              ["Answer generation", "Top-5 evidence → grounded prompt → active generation model → structured answer + citations"],
            ].map(([stage, desc], i) => (
              <div key={i} className="flex gap-3">
                <span className="text-blue-500 shrink-0 w-32">{stage}</span>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ModelCard({
  label,
  modelName,
  ok,
  error,
  extra,
}: {
  label: string;
  modelName: string;
  ok: boolean;
  error: string | null | undefined;
  extra?: string;
}) {
  return (
    <div className={`rounded p-3 border ${ok ? "bg-emerald-950/30 border-emerald-900" : "bg-red-950/30 border-red-900"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {ok ? (
            <CheckCircle className="w-4 h-4 text-emerald-400" />
          ) : (
            <XCircle className="w-4 h-4 text-red-400" />
          )}
          <span className="text-sm text-white font-medium">{label}</span>
        </div>
        <Badge
          variant="outline"
          className={`text-xs border ${ok ? "border-emerald-800 text-emerald-300" : "border-red-800 text-red-300"}`}
        >
          {ok ? "connected" : "failed"}
        </Badge>
      </div>
      <p className="text-xs text-slate-400 mt-1 font-mono">{modelName}</p>
      {extra && <p className="text-xs text-slate-500 mt-1">{extra}</p>}
      {error && <p className="text-xs text-red-400 mt-1 break-all">{error}</p>}
    </div>
  );
}
