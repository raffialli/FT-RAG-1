import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useGetRagStatus, useIngestDocuments, useResetIndex, useUploadDocument } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetRagStatusQueryKey, getListDocumentsQueryKey, getListChunksQueryKey } from "@workspace/api-client-react";
import { Database, Upload, RefreshCw, Trash2, AlertCircle, CheckCircle, Clock, Info } from "lucide-react";

export default function StatusPanel() {
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useGetRagStatus({ query: { queryKey: getGetRagStatusQueryKey(), refetchInterval: 3000 } });
  const [log, setLog] = useState<string[]>([]);

  const ingest = useIngestDocuments({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetRagStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListChunksQueryKey() });
        const lines = [
          `✓ Ingested ${data.documentsIngested} docs, ${data.chunksCreated} chunks, ${data.vectorsCreated} vectors in ${(data.durationMs / 1000).toFixed(1)}s`,
          ...(data.warnings ?? []).map((w) => `⚠ ${w}`),
          ...(data.errors ?? []).map((e) => `✗ ${e}`),
        ];
        setLog((prev) => [...lines, ...prev].slice(0, 50));
      },
      onError: (e) => setLog((prev) => [`✗ ${String(e)}`, ...prev].slice(0, 50)),
    },
  });

  const reset = useResetIndex({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetRagStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListChunksQueryKey() });
        setLog((prev) => ["✓ Index reset", ...prev].slice(0, 50));
      },
    },
  });

  const upload = useUploadDocument({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetRagStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        setLog((prev) => [
          `✓ Uploaded: ${data.documentsIngested} doc, ${data.chunksCreated} chunks, ${data.vectorsCreated} vectors`,
          ...prev,
        ].slice(0, 50));
      },
      onError: (e) => setLog((prev) => [`✗ Upload failed: ${String(e)}`, ...prev].slice(0, 50)),
    },
  });

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    // Use raw fetch since the generated hook expects JSON
    setLog((prev) => [`⟳ Uploading ${file.name}…`, ...prev]);
    fetch("/api/rag/upload", { method: "POST", body: formData })
      .then((r) => r.json())
      .then((data) => {
        queryClient.invalidateQueries({ queryKey: getGetRagStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        setLog((prev) => [
          `✓ Uploaded: ${(data as { documentsIngested: number; chunksCreated: number; vectorsCreated: number }).documentsIngested} doc, ${(data as { documentsIngested: number; chunksCreated: number; vectorsCreated: number }).chunksCreated} chunks`,
          ...prev,
        ].slice(0, 50));
      })
      .catch((err: unknown) => setLog((prev) => [`✗ ${String(err)}`, ...prev]));
    e.target.value = "";
  };

  const handleRebuild = () => {
    const confirmed = window.confirm(
      "Rebuild the local candidate index?\n\nThis rebuilds chunks and vectors from the current source PDFs and uploaded PDFs in this test environment. It may take several minutes. It does not affect AWS, Demo, or production."
    );
    if (confirmed) ingest.mutate({ data: { rebuild: true } });
  };

  const handleReset = () => {
    const confirmation = window.prompt(
      "Reset the local candidate index?\n\nThis clears local manifest, chunks, and vectors for this candidate test environment only. It does not affect AWS, Demo, or production.\n\nType RESET to continue."
    );
    if (confirmation === "RESET") {
      reset.mutate();
    } else if (confirmation !== null) {
      setLog((prev) => ["Reset cancelled: confirmation text did not match RESET.", ...prev].slice(0, 50));
    }
  };

  const busy = ingest.isPending || reset.isPending;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Status card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Database className="w-4 h-4 text-blue-400" />
            Index Status
          </CardTitle>
          <CardDescription className="text-slate-400 text-xs">
            Current state of the vector index and ingested documents
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {statusLoading ? (
            <p className="text-slate-400 text-sm">Loading…</p>
          ) : status ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Metric label="Documents" value={status.documentCount} />
                <Metric label="Chunks" value={status.chunkCount} />
                <Metric label="Vectors" value={status.vectorCount} />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Embedding model</span>
                  <span className="text-slate-200 font-mono">{status.embeddingModel}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Generation model</span>
                  <span className="text-slate-200 font-mono">{status.generationModel}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Ollama endpoint</span>
                  <span className="text-slate-200 font-mono truncate max-w-[160px]">{status.ollamaBaseUrl}</span>
                </div>
                {status.lastIngestedAt && (
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Last ingested</span>
                    <span className="text-slate-200">{new Date(status.lastIngestedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 p-2 rounded bg-slate-800">
                {status.ready ? (
                  <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                )}
                <span className={`text-xs ${status.ready ? "text-emerald-300" : "text-amber-300"}`}>
                  {status.ready ? "Ready to query" : "Index not yet built — ingest documents to start"}
                </span>
              </div>

              {status.notes && status.notes.length > 0 && (
                <div className="space-y-1">
                  {status.notes.map((note, i) => (
                    <div key={i} className="flex gap-2 text-xs text-slate-400">
                      <Info className="w-3 h-3 mt-0.5 shrink-0 text-blue-400" />
                      {note}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <Alert className="bg-red-950 border-red-800">
              <AlertCircle className="h-4 w-4 text-red-400" />
              <AlertDescription className="text-red-300 text-xs">Could not reach API server</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Actions card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-sm">Actions</CardTitle>
          <CardDescription className="text-slate-400 text-xs">
            Ingest PDFs from attached_assets/ or upload new documents
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            onClick={() => ingest.mutate({ data: { rebuild: false } })}
            disabled={busy}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white"
          >
            {ingest.isPending ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Ingesting…
              </>
            ) : (
              <>
                <Database className="w-4 h-4 mr-2" /> Ingest Documents
              </>
            )}
          </Button>

          <Button
            variant="outline"
            onClick={handleRebuild}
            disabled={busy}
            className="w-full border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw className="w-4 h-4 mr-2" /> Rebuild Index (force re-embed)
          </Button>

          <div className="relative">
            <Button
              variant="outline"
              asChild
              className="w-full border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
            >
              <label>
                <Upload className="w-4 h-4 mr-2" /> Upload PDF
                <input
                  type="file"
                  accept=".pdf"
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  onChange={handleUpload}
                />
              </label>
            </Button>
          </div>

          <Button
            variant="outline"
            onClick={handleReset}
            disabled={busy}
            className="w-full border-red-900 text-red-400 hover:bg-red-950"
          >
            <Trash2 className="w-4 h-4 mr-2" /> Reset Index
          </Button>

          {ingest.isPending && (
            <div className="space-y-1">
              <Progress value={undefined} className="h-1.5 bg-slate-800" />
              <p className="text-xs text-slate-400 text-center">Extracting text, chunking, and embedding…</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity log */}
      {log.length > 0 && (
        <Card className="bg-slate-900 border-slate-800 md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-white text-xs">Activity Log</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-slate-950 rounded p-3 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
              {log.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("✓")
                      ? "text-emerald-400"
                      : line.startsWith("✗")
                      ? "text-red-400"
                      : line.startsWith("⚠")
                      ? "text-amber-400"
                      : "text-slate-400"
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-800 rounded p-3 text-center">
      <div className="text-xl font-bold text-white">{value.toLocaleString()}</div>
      <div className="text-xs text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}
