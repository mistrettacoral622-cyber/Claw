# Cross-Platform Image Search Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-platform image search foundation that understands natural-language time filters, content terms, and combined time+content queries.

**Architecture:** Implement a main-process image search service with deterministic parsing and filesystem scanning, expose it through Host API, and add a bundled skill that tells agents how to use it. The first pass is dependency-light and works on Windows, macOS, and Linux/Kylin; OCR and visual embeddings remain optional enrichment points layered behind the same service contract.

**Tech Stack:** Electron main process, TypeScript, Node `fs/promises`, Host API routes, Vitest.

---

## Chunk 1: Search Core

### Task 1: Query Parser

**Files:**
- Create: `electron/services/image-search/query-parser.ts`
- Test: `tests/unit/image-search-query-parser.test.ts`

- [ ] Write tests for `昨天`, `上周末`, `上月`, content-only terms, and combined terms.
- [ ] Verify tests fail because parser does not exist.
- [ ] Implement minimal deterministic Chinese/English time parser and content extraction.
- [ ] Verify parser tests pass.

### Task 2: Filesystem Search

**Files:**
- Create: `electron/services/image-search/image-search-service.ts`
- Test: `tests/unit/image-search-service.test.ts`

- [ ] Write tests with temporary image files and fixed mtimes.
- [ ] Verify tests fail because service does not exist.
- [ ] Implement recursive image scanning, safe root handling, time filtering, content scoring, and result limits.
- [ ] Verify service tests pass.

## Chunk 2: Host API

### Task 3: Route

**Files:**
- Create: `electron/api/routes/image-search.ts`
- Modify: `electron/api/server.ts`
- Test: `tests/unit/image-search-route.test.ts`

- [ ] Write tests for `POST /api/image-search/query`.
- [ ] Verify tests fail because route does not exist.
- [ ] Add lazy Host API route and request validation.
- [ ] Verify route tests pass.

## Chunk 3: Agent Surface

### Task 4: Bundled Skill

**Files:**
- Create: `resources/preinstalled-skills/image-search/SKILL.md`
- Create: `resources/preinstalled-skills/image-search/scripts/search-images.mjs`
- Modify: `electron/utils/skill-config.ts`
- Test: `tests/unit/skill-config.test.ts` or focused route/service tests

- [ ] Add a local bundled skill that explains the query examples and calls the Host API when `KTCLAW_HOST_API_URL` and token env are available.
- [ ] Extend preinstall lookup to include `resources/preinstalled-skills` during development/package builds.
- [ ] Verify existing preinstall behavior remains compatible.

## Verification

- [ ] `pnpm vitest run tests/unit/image-search-query-parser.test.ts tests/unit/image-search-service.test.ts tests/unit/image-search-route.test.ts`
- [ ] `pnpm run typecheck`
- [ ] If communication/session routing is touched, run `pnpm run comms:replay` and `pnpm run comms:compare`.
