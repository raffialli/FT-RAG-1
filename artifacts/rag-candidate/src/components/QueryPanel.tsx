import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useRagQuery, useGetRagStatus } from "@workspace/api-client-react";
import type { QueryResult, AnswerSource, RetrievedChunk, CitationValidation } from "@workspace/api-client-react";
import {
  Search, Loader2, AlertCircle, ChevronDown, ChevronUp,
  FileText, BookOpen, BarChart3, Zap, ShieldCheck, ShieldAlert
} from "lucide-react";

const SAMPLE_QUERIES = [
  "What methods are used for flood forecasting and early warning systems?",
  "What role does community engagement play in flood resilience?",
  "How does climate change affect flood risk management policy?",
  "How do socioeconomic factors influence flood vulnerability?",
  "Explain the three levels of vulnerability in manufactured housing communities: household, housing structure, and park community.",
];

export default function QueryPanel() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: status } = useGetRagStatus();

  const ragQuery = useRagQuery({
    mutation: {
      onSuccess: (data) => {
        setResult(data);
        setShowEvidence(false);
      },
    },
  });

  const handleSubmit = () => {
    if (!query.trim() || ragQuery.isPending) return;
    ragQuery.mutate({ data: { query, topK: 5, includeEvidence: true, includeDebug: true } });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
  };

  return (
    <div className="space-y-6">
      {/* Query input */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Search className="w-4 h-4 text-blue-400" /> Ask a Question
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!status?.ready && (
            <Alert className="bg-amber-950/50 border-amber-800">
              <AlertCircle className="h-4 w-4 text-amber-400" />
              <AlertDescription className="text-amber-300 text-xs">
                Index not ready — go to the Ingest tab to process documents first.
              </AlertDescription>
            </Alert>
          )}

          <Textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about flood risk, emergency management, or related topics…"
            className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 min-h-[80px] resize-none text-sm"
            disabled={ragQuery.isPending}
          />

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {SAMPLE_QUERIES.map((q, i) => (
                <button
                  key={i}
                  onClick={() => { setQuery(q); inputRef.current?.focus(); }}
                  title={q}
                  className="text-xs text-blue-400 hover:text-blue-300 hover:underline truncate max-w-[260px]"
                >
                  {q.substring(0, 40)}…
                </button>
              ))}
            </div>
            <Button
              onClick={handleSubmit}
              disabled={ragQuery.isPending || !query.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white shrink-0"
            >
              {ragQuery.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Querying…</>
              ) : (
                <><Search className="w-4 h-4 mr-2" /> Query</>
              )}
            </Button>
          </div>
          <p className="text-xs text-slate-500">⌘+Enter to submit</p>
        </CardContent>
      </Card>

      {/* Error */}
      {ragQuery.isError && (
        <Alert className="bg-red-950 border-red-800">
          <AlertCircle className="h-4 w-4 text-red-400" />
          <AlertDescription className="text-red-300 text-xs">{String(ragQuery.error)}</AlertDescription>
        </Alert>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Answer */}
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-emerald-400" /> Answer
                </CardTitle>
                <div className="flex items-center gap-2 shrink-0">
                  <EvidenceSufficiencyBadge level={result.evidenceSufficiency} />
                  <ConfidenceBadge level={result.confidence} />
                  <span className="text-xs text-slate-500">{result.durationMs}ms</span>
                </div>
              </div>
              {result.confidenceReason && (
                <p className="text-xs text-slate-500 mt-1">{result.confidenceReason}</p>
              )}
            </CardHeader>
            <CardContent>
              <div className="bg-slate-800/50 rounded p-4 text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                {result.answer}
              </div>

              {/* Citation validation summary */}
              {result.citationValidation && (
                <CitationValidationRow cv={result.citationValidation} totalChunks={result.sources?.length ?? 0} />
              )}

              {result.warnings && result.warnings.length > 0 && (
                <div className="mt-3 space-y-1">
                  {result.warnings.map((w, i) => (
                    <div key={i} className="flex gap-2 text-xs text-amber-400">
                      <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      {w}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Citations */}
          {result.sources && result.sources.length > 0 && (
            <Card className="bg-slate-900 border-slate-800">
              <CardHeader className="pb-2">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-400" /> Citations ({result.sources.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.sources.map((src, i) => (
                  <SourceCard key={i} index={i + 1} source={src} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Evidence chunks toggle */}
          {result.retrievedChunks && result.retrievedChunks.length > 0 && (
            <Card className="bg-slate-900 border-slate-800">
              <button
                className="w-full p-4 flex items-center justify-between hover:bg-slate-800/50 transition-colors rounded-t-lg"
                onClick={() => setShowEvidence(!showEvidence)}
              >
                <div className="flex items-center gap-2 text-sm text-white">
                  <Zap className="w-4 h-4 text-purple-400" />
                  Retrieved Evidence ({result.retrievedChunks.length} chunks)
                  <span className="text-xs text-slate-400">— hybrid RRF + reranking</span>
                </div>
                {showEvidence ? (
                  <ChevronUp className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </button>
              {showEvidence && (
                <CardContent className="pt-0 space-y-3">
                  <Separator className="bg-slate-800" />
                  {result.retrievedChunks.map((chunk, i) => (
                    <EvidenceChunk key={i} index={i + 1} chunk={chunk} />
                  ))}
                </CardContent>
              )}
            </Card>
          )}

          {/* Debug trace toggle */}
          {result.debugTrace && (
            <Card className="bg-slate-900 border-slate-800">
              <button
                className="w-full p-4 flex items-center justify-between hover:bg-slate-800/50 transition-colors rounded-lg"
                onClick={() => setShowDebug(!showDebug)}
              >
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <BarChart3 className="w-4 h-4" /> Retrieval Debug Trace
                </div>
                {showDebug ? (
                  <ChevronUp className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </button>
              {showDebug && (
                <CardContent className="pt-0">
                  <Separator className="bg-slate-800 mb-3" />
                  <pre className="text-xs text-slate-400 bg-slate-950 rounded p-3 overflow-x-auto">
                    {JSON.stringify(result.debugTrace, null, 2)}
                  </pre>
                </CardContent>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({ level }: { level: string }) {
  const cfg: Record<string, { cls: string; label: string }> = {
    high: { cls: "bg-emerald-950 text-emerald-300 border-emerald-800", label: "High confidence" },
    medium: { cls: "bg-blue-950 text-blue-300 border-blue-800", label: "Medium confidence" },
    low: { cls: "bg-amber-950 text-amber-300 border-amber-800", label: "Low confidence" },
    insufficient: { cls: "bg-red-950 text-red-300 border-red-800", label: "Insufficient evidence" },
  };
  const { cls, label } = cfg[level] ?? cfg.low;
  return <Badge className={`text-xs border ${cls}`}>{label}</Badge>;
}

function EvidenceSufficiencyBadge({ level }: { level?: string }) {
  if (!level) return null;
  const cfg: Record<string, { cls: string; label: string }> = {
    sufficient: { cls: "bg-emerald-950/60 text-emerald-400 border-emerald-800/60", label: "Evidence: sufficient" },
    partial:    { cls: "bg-blue-950/60 text-blue-400 border-blue-800/60",           label: "Evidence: partial" },
    weak:       { cls: "bg-amber-950/60 text-amber-400 border-amber-800/60",        label: "Evidence: weak" },
    insufficient: { cls: "bg-red-950/60 text-red-400 border-red-800/60",            label: "Evidence: insufficient" },
  };
  const { cls, label } = cfg[level] ?? cfg.weak;
  return <Badge className={`text-xs border ${cls}`}>{label}</Badge>;
}

function CitationValidationRow({ cv, totalChunks }: { cv: CitationValidation; totalChunks: number }) {
  const hasIssues =
    !cv.allValid ||
    cv.invalidCitations.length > 0 ||
    cv.noisyCitedChunks.length > 0 ||
    cv.citedNumbers.length === 0;

  const uncitedCount = cv.uncitedChunkIndices.length;

  if (!hasIssues && uncitedCount === 0) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-emerald-500">
        <ShieldCheck className="w-3 h-3 shrink-0" />
        Citations valid — {cv.validCitations.length}/{totalChunks} sources cited
        {uncitedCount > 0 && <span className="text-slate-500">({uncitedCount} unused)</span>}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-1">
      {cv.citedNumbers.length > 0 ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <ShieldCheck className="w-3 h-3 shrink-0 text-emerald-600" />
          {cv.validCitations.length} valid citation{cv.validCitations.length !== 1 ? "s" : ""}
          {uncitedCount > 0 && `, ${uncitedCount} of ${totalChunks} sources uncited`}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <ShieldAlert className="w-3 h-3 shrink-0" />
          No source citations found in answer
        </div>
      )}
      {cv.invalidCitations.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <ShieldAlert className="w-3 h-3 shrink-0" />
          Invalid citation{cv.invalidCitations.length !== 1 ? "s" : ""}: [{cv.invalidCitations.join(", ")}]
        </div>
      )}
      {cv.noisyCitedChunks.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-400">
          <AlertCircle className="w-3 h-3 shrink-0" />
          Noisy source{cv.noisyCitedChunks.length !== 1 ? "s" : ""} cited: [{cv.noisyCitedChunks.join(", ")}]
        </div>
      )}
    </div>
  );
}

function SourceCard({ index, source }: { index: number; source: AnswerSource }) {
  const supportCls = {
    direct: "text-emerald-400",
    partial: "text-blue-400",
    weak: "text-amber-400",
  }[source.supportLevel] ?? "text-slate-400";

  const pageRange = source.pageStart === source.pageEnd
    ? `p. ${source.pageStart}`
    : `pp. ${source.pageStart}–${source.pageEnd}`;

  const title = source.displayTitle ?? source.sourceFile;

  return (
    <div className="bg-slate-800/50 rounded p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-slate-500 shrink-0">[{index}]</span>
          <span className="text-xs font-medium text-slate-200 truncate max-w-[280px]" title={source.sourceFile}>
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-slate-500">{pageRange}</span>
          <span className={`text-xs font-medium ${supportCls}`}>{source.supportLevel}</span>
          <span className="text-xs text-slate-600">{(source.score ?? 0).toFixed(4)}</span>
        </div>
      </div>
      {source.sectionPath && (
        <p className="text-xs text-blue-400 font-mono">§ {source.sectionPath}</p>
      )}
      <p className="text-xs text-slate-400 italic leading-relaxed">"{source.snippet}"</p>
    </div>
  );
}

function EvidenceChunk({ index, chunk }: { index: number; chunk: RetrievedChunk }) {
  const [expanded, setExpanded] = useState(false);
  const pageRange = chunk.pageStart === chunk.pageEnd
    ? `p. ${chunk.pageStart}`
    : `pp. ${chunk.pageStart}–${chunk.pageEnd}`;

  return (
    <div className="bg-slate-800/30 rounded p-3 space-y-2 border border-slate-700/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-500">#{index}</span>
          <span className="text-xs text-slate-300 truncate max-w-[200px]">{chunk.sourceFile}</span>
          <span className="text-xs text-slate-500">{pageRange}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-slate-500">
          <span title="RRF score">RRF {(chunk.score ?? 0).toFixed(5)}</span>
          <span title="Vector score">V {(chunk.vectorScore ?? 0).toFixed(3)}</span>
          <span title="BM25 score">B {(chunk.bm25Score ?? 0).toFixed(3)}</span>
        </div>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">
        {expanded ? chunk.text : chunk.text.substring(0, 300) + (chunk.text.length > 300 ? "…" : "")}
      </p>
      {chunk.text.length > 300 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          {expanded ? "Show less" : "Show full chunk"}
        </button>
      )}
      {chunk.cleaningFlags && chunk.cleaningFlags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chunk.cleaningFlags.map((f, i) => (
            <Badge key={i} variant="outline" className="text-[10px] border-slate-700 text-slate-500 h-4 px-1">
              {f}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
