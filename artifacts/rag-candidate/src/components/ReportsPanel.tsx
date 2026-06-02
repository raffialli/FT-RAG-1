import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGetReports, getGetReportsQueryKey } from "@workspace/api-client-react";
import type { ComparisonReport } from "@workspace/api-client-react";
import { BarChart3, Search, ChevronDown, ChevronUp } from "lucide-react";

export default function ReportsPanel() {
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: reports = [], isLoading } = useGetReports({ query: { queryKey: getGetReportsQueryKey(), refetchInterval: 10000 } });

  const filtered = reports.filter(
    (r: ComparisonReport) =>
      r.question.toLowerCase().includes(search.toLowerCase()) ||
      r.classification.toLowerCase().includes(search.toLowerCase())
  );

  const confidenceCounts = {
    high: reports.filter((r: ComparisonReport) => r.candidateConfidence === "high").length,
    medium: reports.filter((r: ComparisonReport) => r.candidateConfidence === "medium").length,
    low: reports.filter((r: ComparisonReport) => r.candidateConfidence === "low").length,
    insufficient: reports.filter((r: ComparisonReport) => r.candidateConfidence === "insufficient").length,
  };

  return (
    <div className="space-y-6">
      {/* Stats row */}
      {reports.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Queries" value={reports.length} color="text-white" />
          <StatCard label="High Confidence" value={confidenceCounts.high} color="text-emerald-400" />
          <StatCard label="Medium" value={confidenceCounts.medium} color="text-blue-400" />
          <StatCard label="Low / Insufficient" value={confidenceCounts.low + confidenceCounts.insufficient} color="text-amber-400" />
        </div>
      )}

      {/* Reports list */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-white text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              Query Reports ({reports.length})
            </CardTitle>
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter…"
                className="pl-8 bg-slate-800 border-slate-700 text-white text-sm h-8 w-48"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-slate-400 text-sm p-4">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-slate-500 text-sm p-4">
              {reports.length === 0
                ? "No reports yet. Run queries in the Query tab."
                : "No reports match your filter."}
            </p>
          ) : (
            <ScrollArea className="h-[600px]">
              <div className="divide-y divide-slate-800">
                {filtered.map((report: ComparisonReport) => (
                  <div key={report.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <p className="text-sm text-slate-200 leading-relaxed">{report.question}</p>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="text-[10px] border-slate-700 text-slate-400 h-4 px-1"
                          >
                            {report.classification}
                          </Badge>
                          <ConfidenceBadge level={report.candidateConfidence} />
                          <span className="text-xs text-slate-600">
                            {new Date(report.createdAt).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => setExpandedId(expandedId === report.id ? null : report.id)}
                        className="text-slate-500 hover:text-slate-300 shrink-0"
                      >
                        {expandedId === report.id ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                    </div>

                    {expandedId === report.id && (
                      <div className="space-y-3 pt-2">
                        <div className="bg-slate-800/50 rounded p-3">
                          <p className="text-xs text-slate-400 mb-1 font-medium">Answer</p>
                          <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                            {report.candidateAnswer}
                          </p>
                        </div>

                        {report.candidateSources && report.candidateSources.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs text-slate-500 font-medium">
                              Sources ({report.candidateSources.length})
                            </p>
                            {(report.candidateSources as {
                              sourceFile: string;
                              pageStart: number;
                              pageEnd: number;
                              supportLevel: string;
                            }[]).map((src, i) => (
                              <div
                                key={i}
                                className="flex items-center gap-2 text-xs text-slate-400 bg-slate-800/30 rounded px-2 py-1"
                              >
                                <span className="font-mono">[{i + 1}]</span>
                                <span className="truncate">{src.sourceFile}</span>
                                <span className="text-slate-600 shrink-0">
                                  p.{src.pageStart}
                                </span>
                                <span className={`shrink-0 ${
                                  src.supportLevel === "direct" ? "text-emerald-400" :
                                  src.supportLevel === "partial" ? "text-blue-400" : "text-amber-400"
                                }`}>
                                  {src.supportLevel}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">Evidence quality:</span>
                          <Badge
                            variant="outline"
                            className="text-[10px] border-slate-700 text-slate-400 h-4 px-1"
                          >
                            {report.evidenceQuality}
                          </Badge>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

function ConfidenceBadge({ level }: { level: string }) {
  const cfg: Record<string, string> = {
    high: "bg-emerald-950 text-emerald-300 border-emerald-800",
    medium: "bg-blue-950 text-blue-300 border-blue-800",
    low: "bg-amber-950 text-amber-300 border-amber-800",
    insufficient: "bg-red-950 text-red-300 border-red-800",
  };
  return (
    <Badge className={`text-[10px] border h-4 px-1 ${cfg[level] ?? cfg.low}`}>{level}</Badge>
  );
}
