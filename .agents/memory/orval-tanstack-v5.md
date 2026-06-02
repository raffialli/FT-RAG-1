---
name: Orval + TanStack Query v5 query options
description: In TanStack Query v5, UseQueryOptions requires queryKey — always include it when passing custom options to Orval-generated hooks.
---

## Rule
When passing custom options (e.g., `refetchInterval`, `enabled`) to Orval-generated query hooks in this repo, always include `queryKey: get*QueryKey()`.

**Why:** TanStack Query v5 changed `UseQueryOptions` to require `queryKey` as a non-optional field. Orval generates hooks that accept `{ query?: UseQueryOptions<...> }`. If you pass `{ query: { refetchInterval: 15000 } }` without `queryKey`, TypeScript errors with `Property 'queryKey' is missing`.

**How to apply:**
```tsx
// WRONG — missing queryKey
useGetRagStatus({ query: { refetchInterval: 15000 } });

// CORRECT — include queryKey from the generated getter
useGetRagStatus({ query: { queryKey: getGetRagStatusQueryKey(), refetchInterval: 15000 } });
```

Import the `get*QueryKey` helper from `@workspace/api-client-react` alongside the hook.
