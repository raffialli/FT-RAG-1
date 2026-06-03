import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useListDocuments,
  useListChunks,
  getGetRagStatusQueryKey,
  getListChunksQueryKey,
  getListDocumentsQueryKey,
} from "@workspace/api-client-react";
import type { RagDocument } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, ChevronRight, FileText, Search, Trash2 } from "lucide-react";

export default function DocumentsPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const { data: docs = [], isLoading } = useListDocuments();
  const chunkParams = { documentId: selectedDoc ?? undefined };
  const { data: chunks = [] } = useListChunks(
    chunkParams,
    { query: { queryKey: getListChunksQueryKey(chunkParams), enabled: !!selectedDoc } }
  );

  const filtered = docs.filter((d: RagDocument) =>
    d.filename.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = async (doc: RagDocument) => {
    const confirmed = window.confirm(
      `Remove "${doc.filename}" from this candidate index?\n\nThis removes its document entry, chunks, vectors, and generated text files. It does not delete other documents.`
    );
    if (!confirmed) return;

    setDeletingDocId(doc.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/rag/documents/${encodeURIComponent(doc.id)}`, {
        method: "DELETE",
      });
      const data = await response.json() as {
        success?: boolean;
        error?: string;
        before?: { targetChunkCount?: number; targetVectorCount?: number };
      };
      if (!response.ok || data.success === false) {
        throw new Error(data.error ?? `Delete failed with status ${response.status}`);
      }

      if (selectedDoc === doc.id) setSelectedDoc(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetRagStatusQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListChunksQueryKey() }),
      ]);
      setMessage({
        type: "success",
        text: `Removed ${doc.filename} from the index (${data.before?.targetChunkCount ?? doc.chunkCount} chunks, ${data.before?.targetVectorCount ?? 0} vectors).`,
      });
    } catch (e) {
      setMessage({ type: "error", text: `Remove failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setDeletingDocId(null);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Document list */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <FileText className="w-4 h-4 text-blue-400" />
            Documents ({docs.length})
          </CardTitle>
          <div className="relative mt-2">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter documents…"
              className="pl-8 bg-slate-800 border-slate-700 text-white text-sm h-8"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {message && (
            <div className="px-3 pb-3">
              <Alert
                className={
                  message.type === "success"
                    ? "border-emerald-900 bg-emerald-950/40"
                    : "border-red-900 bg-red-950/40"
                }
              >
                {message.type === "success" ? (
                  <CheckCircle className="h-4 w-4 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-400" />
                )}
                <AlertDescription
                  className={message.type === "success" ? "text-emerald-300" : "text-red-300"}
                >
                  {message.text}
                </AlertDescription>
              </Alert>
            </div>
          )}
          {isLoading ? (
            <p className="text-slate-400 text-sm p-4">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-slate-500 text-sm p-4">
              {docs.length === 0 ? "No documents ingested yet." : "No documents match filter."}
            </p>
          ) : (
            <ScrollArea className="h-[500px]">
              <div className="divide-y divide-slate-800">
                {filtered.map((doc: RagDocument) => (
                  <div
                    key={doc.id}
                    className={`p-3 transition-colors ${
                      selectedDoc === doc.id ? "bg-slate-800" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedDoc(selectedDoc === doc.id ? null : doc.id)}
                      className="w-full rounded text-left hover:bg-slate-800/60 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="text-sm text-slate-200 truncate font-mono text-xs">
                            {doc.filename}
                          </span>
                        </div>
                        <ChevronRight
                          className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${
                            selectedDoc === doc.id ? "rotate-90" : ""
                          }`}
                        />
                      </div>
                    </button>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">{doc.pageCount} pages</span>
                        <span className="text-slate-700">·</span>
                        <span className="text-xs text-slate-500">{doc.chunkCount} chunks</span>
                        <span className="text-slate-700">·</span>
                        <StatusBadge status={doc.status} />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={deletingDocId === doc.id}
                        onClick={() => void handleDelete(doc)}
                        className="h-7 border-slate-700 bg-slate-900 text-xs text-slate-300 hover:bg-red-950/50 hover:text-red-200"
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        {deletingDocId === doc.id ? "Removing..." : "Remove from index"}
                      </Button>
                    </div>
                    {doc.cleaningFlags && doc.cleaningFlags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5 pl-5">
                        {doc.cleaningFlags.slice(0, 3).map((f, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            className="text-[10px] border-slate-700 text-slate-500 h-4 px-1"
                          >
                            {f}
                          </Badge>
                        ))}
                        {doc.cleaningFlags.length > 3 && (
                          <span className="text-[10px] text-slate-600">
                            +{doc.cleaningFlags.length - 3} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Chunk viewer */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-sm">
            {selectedDoc
              ? `Chunks — ${docs.find((d: RagDocument) => d.id === selectedDoc)?.filename ?? selectedDoc}`
              : "Select a document to view chunks"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!selectedDoc ? (
            <p className="text-slate-500 text-sm p-4">Click a document on the left to inspect its chunks.</p>
          ) : (
            <ScrollArea className="h-[500px]">
              <div className="divide-y divide-slate-800">
                {chunks.map((chunk, i) => (
                  <div key={chunk.chunkId} className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-slate-500">#{i + 1}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">
                          p. {chunk.pageStart}{chunk.pageEnd !== chunk.pageStart ? `–${chunk.pageEnd}` : ""}
                        </span>
                      </div>
                    </div>
                    {chunk.sectionPath && (
                      <p className="text-xs text-blue-400 font-mono">§ {chunk.sectionPath}</p>
                    )}
                    <p className="text-xs text-slate-400 leading-relaxed">{chunk.text}</p>
                  </div>
                ))}
                {chunks.length === 0 && (
                  <p className="text-slate-500 text-sm p-4">No chunks found for this document.</p>
                )}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    ingested: "bg-emerald-950 text-emerald-400 border-emerald-900",
    error: "bg-red-950 text-red-400 border-red-900",
    pending: "bg-amber-950 text-amber-400 border-amber-900",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[10px] h-4 px-1 border ${cfg[status] ?? cfg.pending}`}
    >
      {status}
    </Badge>
  );
}
