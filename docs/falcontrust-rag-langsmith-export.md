# FalconTrust RAG LangSmith Export

FalconTrust keeps the local structured RAG trace as the source of truth. LangSmith export is optional and disabled by default. If LangSmith is unavailable or export fails, user queries still complete normally.

## Enable

Set these environment variables on the VM or service process:

```bash
export RAG_TRACE_EXPORT_LANGSMITH=true
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY="<service-key>"
export LANGSMITH_PROJECT="falcontrust-rag-candidate"
```

For non-US LangSmith regions, also set:

```bash
export LANGSMITH_ENDPOINT="https://eu.api.smith.langchain.com"
```

Use the correct regional endpoint for the workspace. Do not put the API key in source code, bundle files, committed `.env` files, traces, reports, or logs.

## Disable

Unset any required variable, or explicitly set:

```bash
export RAG_TRACE_EXPORT_LANGSMITH=false
```

The local `includeTrace=true` API response still works without LangSmith.

## Privacy Defaults

By default, LangSmith receives safe trace metadata:

- FalconTrust trace id
- question, normalized query, expanded query terms
- corpus document/chunk/vector counts
- embedding model
- model provider and model name
- retrieval stage counts and chunk/source/page metadata
- candidate/final chunk ids and scores
- selected excerpt hashes and citation/source metadata
- answer preview, confidence, evidence sufficiency, refusal flag
- citation validation summary
- failure layer and reasons
- stage latency timings

By default, LangSmith does not receive:

- full document text
- full raw uploaded files
- full selected excerpts
- Basic Auth credentials
- API keys
- local filesystem paths
- runtime corpus files or uploads

To include retrieval and selected-excerpt previews for debugging, opt in explicitly:

```bash
export RAG_TRACE_INCLUDE_TEXT=true
```

Keep that off for normal service use unless the trace data has been reviewed for the intended workspace.

## Smoke Test

After deploying the bundle and configuring env vars, run one known non-held-out question:

```bash
curl -sS -u "$FT_USER:$FT_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What were the two main earthquakes discussed, including their magnitudes and locations?","topK":5,"includeEvidence":true,"includeTrace":true}' \
  https://ft-rag-candidate.massive-ai.net/api/rag/query
```

Confirm the JSON response still includes a local `trace` object. Then open LangSmith, choose the `falcontrust-rag-candidate` project, and look for a run named `FalconTrust RAG Query`.

## Eval Harness

The local eval runner can still run without LangSmith:

```bash
cd /opt/falcontrust-replit-audit/artifacts/api-server
RAG_EVAL_BASE_URL=https://ft-rag-candidate.massive-ai.net \
FT_USER="$FT_USER" \
FT_PASS="$FT_PASS" \
pnpm run eval:rag
```

LangSmith export is separate from eval pass/fail. Use LangSmith to inspect trace shape and compare runs over time.

## Failure Handling

Export is non-blocking. The app posts the sanitized run to LangSmith in the background. HTTP errors, timeouts, or network failures are logged as warnings with trace id/run id only; they do not change the user-facing RAG answer.
