# AI Evidence Serializer, Validation & Cache Contract

## 1. Input Boundary (`serializeEvidenceForAI`)

`serializeEvidenceForAI` always calls `buildCanonicalCheckpointSnapshot` server-side first (rebuilding at `180s` Alert / `360s` Evidence / `900s` Outcome) so playback telemetry from arbitrary timestamps can never masquerade as checkpoint evidence. Assessment and AI requests remain gated during `00:00` (`Orient`) prior to `03:00` (`Alert`).

- **Included in `CanonicalAIPacket`:**
  - Opaque incident ID (`incident-001`, `incident-002`, `incident-003`) and symptom title.
  - Canonical system description and 7-node service topology.
  - Current canonical checkpoint (`alert` at `03:00`, `evidence` at `06:00`, `outcome` at `15:00`).
  - Canonical checkpoint measures and visible evidence (`simTimeSeconds <= checkpointTime`).
  - Visible intervention options (omitted at `alert`; included at `evidence` and `outcome`).
  - Applied intervention ID (`null` at `alert` and `evidence`; populated at `outcome`).
- **Explicitly Excluded:**
  - Ground truth (`debrief`, `actualRootCause`, `technicalTitle`) and authored `walkthroughs`.
  - Future evidence (`simTimeSeconds > checkpointTime`).
  - Authoring flags (`isAlternativeClue`).
  - Visitor workspace state (pinned evidence IDs, active tab, playback speed, onboarding state, session ID).

## 2. Output Validation (`validateAnalysisResult` & `validateAndNormalizeProviderOutput`)

- Every citation ID in `observedFacts`, `rankedHypotheses`, and `alternativeExplanations` must exist in `snapshot.visibleEvidence`.
- At `Alert` (`03:00`), `recommendedInterventions` **must be empty (`[]`)** and `verificationChecks` must provide investigation steps.
- At `Evidence` (`06:00`) and `Outcome` (`15:00`), every `recommendedInterventions[].interventionId` must match a valid scenario intervention ID (with no duplicates or cross-scenario IDs).
- `functions/src/outputValidator.ts` treats raw provider output as untrusted unknown data, validates strict keys, field bounds, enums, and citations, and overwrites all provenance fields server-side (`sourceMode`, `isPreviewMock`, `modelVersion`, `promptVersion`, `generatedAtIso`, `sourceBadgeLabel`). Server badge labels distinguish mocked emulator runs (`Mocked AI analysis (Phase 3A emulator)`), fresh live generations (`AI analysis (generated live)`), and cross-visitor cache hits (`AI analysis (shared cache hit)`), while the frontend assessment mapper (`apps/web/src/services/assessmentService.ts`) normalizes visitor-facing labels to `Live AI analysis (Gemini)`, `Shared cached AI analysis (Gemini)`, `Local mock: Generated AI analysis`, `Local mock: Shared cached AI analysis`, or `Authored baseline walkthrough`. Mocked cache entries never satisfy live requests or replays (`isMockProvider` matching in `accountingStore.ts`).

## 3. Cache Identity, Dual Runtime Controls & Live Adapter

- **SHA-256 Cache Identity:** `computeCanonicalPacketDigest`, `computeCanonicalCacheKey`, and `computeBackendCacheDocId` hash `stableStringify(packet)` plus `modelVersion`, `promptVersion`, and `schemaVersion` using FIPS 180-4 SHA-256. Any change to visible evidence text or versions generates a new key, while visitor identity, request ID, wall-clock time, tabs, pins, and playback speed never split the cache. (Legacy FNV-1a `hashPacket` is retained only for non-cryptographic packet inspection and is not used as backend cache identity.)
- **Controlled Live Adapter (`functions/src/geminiProvider.ts`):** Implements `ModelProvider` (`isMock: false`) against the matched Gemini REST `v1beta` `generateContent` and `:countTokens` contract (`POST /v1beta/models/{model}:generateContent` with `gemini-3.5-flash-lite` primary and `gemini-3.1-flash-lite` secondary, `DEFAULT_GEMINI_THINKING_LEVEL = 'LOW'`, `maxOutputTokens: 2,000`, strict packet-bounded `generationConfig.responseJsonSchema`, zero automatic retries, `AbortSignal` deadline enforcement, and `CanonicalAIPacket`-only input). Before dispatching any paid generation call, `prepareGeminiRequest`, `buildGeminiGenerateContentRequest`, `verifyPreGenerationInputTokens` (`POST /v1beta/models/{model}:countTokens` accepting `{ generateContentRequest }`, bounded by the remaining request deadline), and `assertPreparedRequestUnchanged` reject oversized (`> 8,000` tokens), unverified, or post-count-mutated requests before paid transport. Pre-generation rejections refund the `7,400` microUSD reservation (`0` charged); `:countTokens` or generation timeouts and missing/malformed `usageMetadata` retain `7,400` microUSD; unexpected provider usage overruns record full unclamped `actualCostMicros`.
- **Dual Runtime Controls (`systemControl/runtime`):**
  - `aiDisabled === true` (or `CHAOS_AI_DISABLED=true`): Master emergency kill switch checked at admission Step 3 before reading cache; immediately returns `status: 'disabled'` (`reasonCode: 'ai_disabled'`).
  - `liveGenerationDisabled === true` (or `CHAOS_LIVE_GENERATION_DISABLED=true`): Cache-only operational control checked at admission Step 8a **after** valid cache hits (Step 6) and **before** acquiring a generation lease or reserving spend (Step 9). Valid cached analyses return `status: 'cached'` (`cacheHit: true`, `$0.00` spend), while cache misses return `status: 'disabled'` (`reasonCode: 'live_generation_disabled'`).
- **Expiry, Cooldown & Bounded `requestId` Reuse:** Cache entries expire `30 days` after `generatedAtMs` without extending on reads. Failed/invalid generations trigger a `15s` cooldown (`reasonCode: 'failure_cooldown'`). Valid cache hits continue serving when daily/monthly generation allowances are exhausted (unless blocked by request rate limits or `aiDisabled`). Replaying a completed `requestId` or recovering an `in_flight` -> `reconciled` attempt preserves `(visitorUid, requestPayloadHash)` and `isMockProvider` binding, increments visitor/project request counters, never starts duplicate generation or spend reconciliation, and validates `cacheDocId`, `cacheKey`, `packetSha256`, `modelVersion`, `promptVersion`, `schemaVersion`, `validateAnalysisResult`, and fixed 30-day expiry (`nowMs < responseExpiresAtMs`):
  - Past fixed 30-day expiry -> `status: 'unavailable'`, `reasonCode: 'request_response_expired'`, `result: undefined` (without extending expiry).
  - Canonical evidence text, provider mock/live mode, or model/prompt/schema mismatch -> `status: 'unavailable'`, `reasonCode: 'request_identity_obsolete'`, `result: undefined`.
  - Un-reconciled expired `in_flight` attempt lease -> finalized cleanly as `status: 'timeout'`, `reasonCode: 'lease_expired'`, `result: undefined`.
- **Callable Status Envelopes:** `analyzeIncident` returns structured statuses (`ok`, `cached`, `pending`, `quota_reached`, `disabled`, `version_mismatch`, `timeout`, `invalid_output`, `unavailable`) so the frontend falls back deterministically to curated offline walkthroughs.
- **Internal Evaluation (`runInternalEvaluationAnalysis`):** Bypasses `analysisCache` reads/writes while sharing daily/monthly generation quotas, `$4.50/month` spend allowance, runtime controls, and output validation. Public callable requests cannot enable evaluation mode or bypass cache.
