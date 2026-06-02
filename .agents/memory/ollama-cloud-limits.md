---
name: Ollama Cloud API limitations
description: /api/embed is not available on Ollama Cloud; only chat/generation endpoints work. No embedding models in the cloud catalog.
---

## Rule
Never try to use `/api/embed` against `https://ollama.com`. It returns 401 for every model, including cloud generation models. There are no embedding models in the Ollama Cloud catalog.

**Why:** Ollama Cloud (https://ollama.com/api/...) only exposes generation/chat endpoints. The embed endpoint is only available on a local Ollama daemon (localhost:11434). The key IS valid — `/api/tags` and `/api/chat` both work with `Authorization: Bearer $OLLAMA_API_KEY`.

**How to apply:**
- For generation: use `POST https://ollama.com/api/chat` with one of the ~40 available models (e.g., `qwen3.5:397b`, `gpt-oss:120b`, `deepseek-v4-flash`). Check available models with `curl https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY"`.
- For embeddings: use `@huggingface/transformers` locally (nomic-embed-text-v1.5), or a different embedding provider with its own key.
- Notable: `qwen3.5:122b` does NOT exist on Ollama Cloud; use `qwen3.5:397b` instead.
- The `/api/chat` response may include a `thinking` field (chain of thought) — extract only `message.content`.
