---
name: HuggingFace transformers + esbuild in Node.js
description: @huggingface/transformers must be marked external in esbuild; onnxruntime-node needs onlyBuiltDependencies approval in pnpm-workspace.yaml.
---

## Rule
When using `@huggingface/transformers` in a Node.js server bundled with esbuild, you MUST:
1. Add `"@huggingface/transformers"`, `"onnxruntime-node"`, and `"onnxruntime-web"` to the `external` array in `build.mjs`.
2. Add `onnxruntime-node` to `onlyBuiltDependencies` in `pnpm-workspace.yaml` so its native binaries get built.
3. Run `pnpm install --no-frozen-lockfile` after adding to `onlyBuiltDependencies`.

**Why:** When esbuild bundles `@huggingface/transformers`, optional dependencies (`sharp`, `onnxruntime-node`) that the package wraps in try/catch get converted to static ESM imports. Static ESM imports that fail are fatal (ERR_MODULE_NOT_FOUND), not caught. Marking the package external lets Node.js use the installed version, which handles optional deps gracefully.

**How to apply:**
```js
// build.mjs external array — add these:
"@huggingface/transformers",
"@huggingface/env",
"onnxruntime-node",
"onnxruntime-web",
```

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - onnxruntime-node  # add this line
```

**Usage pattern in embeddings.ts:**
- Use dynamic `await import("@huggingface/transformers")` inside a lazy getter
- Set `env.cacheDir` to a persistent path inside the workspace (`.hf-cache/`)
- Use `dtype: "q8"` for CPU inference
- Use `Xenova/all-MiniLM-L6-v2` (~23MB q8, 384-dim) — nomic-embed-text-v1.5 (~135MB) OOMs Replit's container
- **CRITICAL: batch serially (one at a time)** — parallel ONNX sessions multiply memory and OOM. Never use Promise.all on embedText calls.
