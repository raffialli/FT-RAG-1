import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import StatusPanel from "@/components/StatusPanel";
import QueryPanel from "@/components/QueryPanel";
import DocumentsPanel from "@/components/DocumentsPanel";
import ReportsPanel from "@/components/ReportsPanel";
import ModelTestPanel from "@/components/ModelTestPanel";
import { useGetRagStatus, getGetRagStatusQueryKey } from "@workspace/api-client-react";
import { Database, Search, FileText, BarChart3, Cpu } from "lucide-react";

export default function RagApp() {
  const [activeTab, setActiveTab] = useState("query");
  const { data: status } = useGetRagStatus({ query: { queryKey: getGetRagStatusQueryKey(), refetchInterval: 15000 } });
  const provider = status?.generationProvider === "openai" ? "OpenAI" : status?.generationProvider === "ollama" ? "Ollama" : null;
  const embeddingModel = status?.embeddingModel ?? "Xenova/all-MiniLM-L6-v2";
  const generationLabel = status && provider ? `${provider} / ${status.generationModel}` : "Generation model loading";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center">
              <Database className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-white leading-none">FalconTrust RAG Candidate</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Hybrid retrieval · {embeddingModel} · {generationLabel}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status && (
              <>
                <Badge variant="outline" className={`text-xs border-0 ${status.ready ? "bg-emerald-950 text-emerald-400" : "bg-amber-950 text-amber-400"}`}>
                  {status.ready ? `${status.vectorCount} vectors` : "Not ingested"}
                </Badge>
                <Badge variant="outline" className="text-xs border-0 bg-slate-800 text-slate-300">
                  {status.documentCount} docs · {status.chunkCount} chunks
                </Badge>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-slate-900 border border-slate-800 mb-6">
            <TabsTrigger value="query" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-400 gap-2">
              <Search className="w-3.5 h-3.5" /> Query
            </TabsTrigger>
            <TabsTrigger value="ingest" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-400 gap-2">
              <Database className="w-3.5 h-3.5" /> Ingest
            </TabsTrigger>
            <TabsTrigger value="documents" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-400 gap-2">
              <FileText className="w-3.5 h-3.5" /> Documents
            </TabsTrigger>
            <TabsTrigger value="reports" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-400 gap-2">
              <BarChart3 className="w-3.5 h-3.5" /> Reports
            </TabsTrigger>
            <TabsTrigger value="model" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-400 gap-2">
              <Cpu className="w-3.5 h-3.5" /> Models
            </TabsTrigger>
          </TabsList>

          <TabsContent value="query">
            <QueryPanel />
          </TabsContent>

          <TabsContent value="ingest">
            <StatusPanel />
          </TabsContent>

          <TabsContent value="documents">
            <DocumentsPanel />
          </TabsContent>

          <TabsContent value="reports">
            <ReportsPanel />
          </TabsContent>

          <TabsContent value="model">
            <ModelTestPanel />
          </TabsContent>
        </Tabs>
      </main>

      <Separator className="bg-slate-800" />
      <footer className="max-w-7xl mx-auto px-4 py-3 text-xs text-slate-500 flex items-center justify-between">
        <span>FalconTrust RAG Experiment — Hybrid (dense + BM25) + Reranking</span>
        <span>{embeddingModel} · {generationLabel}</span>
      </footer>
    </div>
  );
}
