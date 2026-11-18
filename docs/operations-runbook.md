# Chaos Room Simulator — Operations Runbook

## 1. Runtime Modes & Environment Isolation
`emulator_mock` remains the default backend mode (`resolveRuntimeMode` defaults to `'emulator_mock'` when `CHAOS_BACKEND_MODE` is unset), operating strictly against the local Firestore Emulator (`demo-chaos-room`) and `MockModelProvider`:
- **Default local mode (`emulator_mock`):** Both `scripts/run-emulator-tests.mjs` and `functions/src/emulatorGuard.ts` (`assertSafeLocalExecutionEnvironment`) fail safely if:
  - `projectId` does not start with `demo-`
  - `FIRESTORE_EMULATOR_HOST` is missing or points outside `127.0.0.1` / `localhost`
  - Any live credential or API key environment variable is set (`GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY`)
- **Production live mode (`live_gemini`):** Blocked unless ALL guards in `assertSafeLiveExecutionEnvironment` pass simultaneously: `CHAOS_BACKEND_MODE=live_gemini`, `CHAOS_LIVE_GEMINI_ENABLED=true`, non-`demo-` GCP/Firebase project ID, zero local emulator environment variables, non-empty Secret Manager `GEMINI_API_KEY`, and a supported live pricing entry in `LIVE_MODEL_PRICING_BY_VERSION`. Live production origin enforcement defaults to `LIVE_PRODUCTION_ORIGINS` (`https://chaos.mikerestrepo.com`) unless `CHAOS_ALLOW_LOCALHOST_ORIGINS=true` is explicitly set.

## 2. Verified Tooling & Prerequisites
- **Node.js:** `>= 22` (verified on `v24.19.0`)
- **Java Runtime (for `npm run test:emulator` only):** OpenJDK `21+` (required by Firebase's local Firestore emulator JAR)
- **Firebase CLI & Testing Tools:** `firebase-tools`, `@firebase/rules-unit-testing`, `esbuild`, `vitest` (installed via `npm install`)

### Verification Commands
```bash
npm run typecheck
npm test
npm run build
npm run test:emulator
```
*(On Windows PowerShell with restricted `.ps1` execution policy, invoke `npm.cmd` instead of `npm`.)*
- `npm run test:emulator` runs `scripts/run-emulator-tests.mjs`, locates Java 21+ automatically, targets `--project demo-chaos-room`, starts only the Firestore emulator on `127.0.0.1:8080`, runs `vitest.emulator.config.ts`, and exits cleanly.

## 3. Quotas, Limits, and Conservative Accounting
Centralized in `functions/src/config.ts`:
- **Per visitor:** `2` requests/minute (UTC minute), `12` requests/day (UTC day), `1` active pending request (applied across new requests and duplicate completed/in-flight `requestId` replays; replays increment request counters without triggering duplicate provider calls or spend reconciliation).
- **Project-wide:** `30` accepted requests/minute (UTC minute, including cache hits and duplicate `requestId` replays).
- **Generation attempts:** `30`/day UTC and `600`/calendar month UTC (shared by public cache misses, failures, and owner evaluations).
- **Spending cap:** `4,500,000` integer microdollars (`$4.50/month` USD) reserved worst-case before provider invocation, derived from server-owned pricing (`5,000` microdollars under `MOCK_PHASE3A_FIXTURE_UNVERIFIED` in `emulator_mock`; `7,400` microdollars / `\$0.0074` for `gemini-3.5-flash-lite` primary and `5,000` microdollars / `\$0.0050` for `gemini-3.1-flash-lite` secondary in `live_gemini`, accounting for input + output + thinking + excess billable tokens). Pre-generation token checks via the matched `v1beta` `:countTokens` contract (`CountTokensRequest.generateContentRequest` bounded by the remaining deadline, plus post-count `assertPreparedRequestUnchanged` request-integrity verification) reject oversized/unverified requests before paid `:generateContent` calls and refund the full reservation; `:countTokens` or generation timeouts and unknown usage retain full reservation; unexpected provider overruns record full unclamped `actualCostMicros`.
- **Ceilings & deadlines:** `8,000` input tokens (enforced pre-generation via `v1beta` `:countTokens` across `systemInstruction`, `contents`, and `generationConfig.responseJsonSchema`), `2,000` output+thinking tokens (`thinkingLevel: 'LOW'`), `15,000 ms` independent provider deadline (`Promise.race` with unhandled-rejection guard if a provider ignores `AbortSignal`), `25 s` callable timeout (`25 s` generation lease TTL), `30 days` fixed cache & `requestId` reuse TTL (not extended on reads; expired/obsolete `requestId` replays return `unavailable` with `request_response_expired` / `request_identity_obsolete` while preserving `(visitorUid, requestPayloadHash)` and `isMockProvider` binding), `15 s` failure cooldown.

### Non-Guaranteed Exactly-Once External API Caveat
Firestore transactions guard admission, lease ownership, and idempotent spend reconciliation, but **do not guarantee exactly-once external model execution**:
- If a worker crashes or times out after calling an external provider, the external API may still execute or bill even though the backend retains the full worst-case reservation (`5,000` microdollars mock / `7,400` microdollars `gemini-3.5-flash-lite` live), ignores stale/late cache writes, and does not perform automatic provider retries.

### UTC Boundary Rollover
- Every `generationAttempts` lease persists its admission `quotaDayKey` (`YYYY-MM-DD`) and `quotaMonthKey` (`YYYY-MM`).
- Finalization reconciles `actualSpendMicros` and `reservedSpendMicros` against that admission `quotaMonthKey` even if execution crosses UTC midnight or month-end.

## 4. Dual Operational Controls & Emergency Kill Switch
Operator-only Firestore settings (`systemControl/runtime`) and environment variables allow instant control without redeploying code (direct browser reads/writes to `systemControl` and all other collections are denied by `firestore.rules`):

1. **Master Kill Switch (`aiDisabled`):**
   - Set `systemControl/runtime.aiDisabled = true` (or env var `CHAOS_AI_DISABLED=true`).
   - Immediately halts all public and evaluation AI responses—including cache hits—returning `status: 'disabled'` (`reasonCode: 'ai_disabled'`).
2. **Cache-Only Mode (`liveGenerationDisabled`):**
   - Set `systemControl/runtime` to `{ "aiDisabled": false, "liveGenerationDisabled": true, "reason": "Live generation paused; cached assessments remain available" }` (or env var `CHAOS_LIVE_GENERATION_DISABLED=true`).
   - Continues serving validated entries from `analysisCache` (`$0.00` marginal model spend) while rejecting cache misses at Step 8a before acquiring a lease or reserving spend (`status: 'disabled'`, `reasonCode: 'live_generation_disabled'`).

## 5. Firestore Collections & Data-Retention Assumptions
All 9 collections deny direct browser access (`allow read, write: if false;` in `firestore.rules`):
- `analysisCache` — Public validated results, active leases, failure cooldowns. Valid cache entries expire in application logic after `30 days` from `generatedAtMs`; expired docs may be deleted by scheduled cleanup or Firestore TTL policy on `expiresAtMs`.
- `generationAttempts` — Lease audit records (`reconciled`, `chargedCostMicros`, `quotaDayKey`, `quotaMonthKey`). Retain 90 days for spend auditability.
- `requestRecords` — Request ID idempotency & payload-hash bindings. Retain 7–30 days or apply Firestore TTL cleanup.
- `quotaMinutes`, `quotaDays`, `quotaMonths`, `visitorState` — UTC rate, quota, and microdollar ledger documents; retain monthly billing ledgers at least 1 year, daily/minute counters 30 days.
- `evaluationRuns` — Internal owner evaluation run records; bypasses public cache while counting toward shared daily/monthly generation & spend allowances.
- `systemControl` — Runtime operator flags (`runtime`). Retain permanently.

## 6. Frontend Client Configuration & Runtime Behavior (`@chaos-room/web`)

### Local Dev vs. Production Transport Precedence
- **Development / Review Builds (`import.meta.env.DEV` or `MODE === 'review'`):** `App.tsx` checks `isDevOrReviewEnvironment` **before** any Firebase config. By default `npm run dev` routes all `"Request AI analysis"` clicks to `MockAnalyzeIncidentTransport` (or `window.__CHAOS_TRANSPORT_OVERRIDE__` with forced mock provenance), operating 100% locally with zero network calls to Firebase or Gemini.
- **Production Builds (`!isDevOrReviewEnvironment`):** Ignores `window.__CHAOS_TRANSPORT_OVERRIDE__` and resolves `window.__CHAOS_FIREBASE_CONFIG__ ?? CHAOS_PRODUCTION_FIREBASE_CONFIG` (`apps/web/src/config/firebase.ts`). When omitted (e.g., in forks without Firebase config), falls back cleanly to `OfflineUnconfiguredTransport`.
- **Expected `FirebaseClientConfig` shape:**
  ```json
  {
    "projectId": "<your-firebase-project-id>",
    "appId": "<your-firebase-web-app-id>",
    "apiKey": "<your-firebase-web-api-key>",
    "authDomain": "<your-project>.firebaseapp.com",
    "storageBucket": "<your-project>.firebasestorage.app",
    "messagingSenderId": "<your-sender-id>",
    "functionsRegion": "us-central1",
    "recaptchaSiteKey": "<your-recaptcha-enterprise-site-key>"
  }
  ```
- **App Check site key is mandatory for live mode:** `FirebaseCallableTransport` rejects initialization if `recaptchaSiteKey` is missing or empty, failing fast with `reasonCode: 'app_check_required'` without firing live calls.
- **Identified App Reuse & Safe Initialization:** Reuses specifically named app `[CHAOS_ROOM]` only after verifying matching configuration options; concurrent initialization is serialized via an `initPromise` mutex; transport instance remains stable across simulation ticks and does not re-instantiate on time updates.

### Request Ownership, Retry Semantics & Stale-Response Protection
1. **Invocation Identity & Ownership:**
   - Every request is allocated a monotonic local invocation identity (`invocationCounterRef` / `activeInvocationIdRef`), strictly separate from the canonical state key and server `requestId`.
   - Only the currently active invocation may publish results, publish errors, or clear loading state.
   - Any visitor transition (reset to `00:00`, switching scenarios, scrubbing, backward navigation, branch changes, or unmount) invalidates the invocation identity and aborts the in-flight `AbortController`. Late-settling responses or errors from prior invocations are ignored.
2. **Independent Bounded Client Deadline:**
   - The client enforces an independent bounded deadline (`DEFAULT_CLIENT_ANALYSIS_DEADLINE_MS = 28,000` ms, configurable via `clientDeadlineMs` prop) racing initialization and transport calls via `Promise.race` with timer cleanup.
   - If the deadline is reached, the UI reverts to the authored fallback with `status: 'timeout'` (`reasonCode: 'client_deadline_exceeded'`). The status copy explicitly informs visitors that client-side deadline does not guarantee server-side cancellation.
3. **Retry Semantics & Cooldown Enforcement:**
   - Responses with `retryAfterMs` (e.g., `pending` server leases or rate limits) trigger a client-side cooldown period with a live countdown timer (`Cooldown active (Xs)` / `Check in Xs`).
   - During the cooldown, all equivalent submission paths are disabled to prevent duplicate load.
   - **Unresolved Request Recovery:** Polling or retrying an unresolved request (e.g., `pending` lease or network transport drop) reuses the exact same `requestId` to honor backend deduplication and replay rules.
   - **Terminal Failure Retry:** Retrying after a confirmed terminal failure (`disabled`, `quota_reached`, `timeout`, `invalid_output`, `version_mismatch`) generates a fresh UUID `requestId` upon an explicit visitor click (`Retry AI analysis`).
   - Local canonical identity strictly includes `engineVersion`: `${incidentId}@${scenarioVersion}@${engineVersion}|${checkpoint}|${intervention ?? 'none'}`.
4. **Runtime Response Validation of Unknown Data:**
   - All response envelopes and nested results are treated as untrusted runtime data (`validateUnknownResponse` and `normalizeValidatedResponse`).
   - Verifies envelope shape, status membership, required fields, checkpoint/scenario/engineVersion/intervention consistency, and snapshot citations.
   - Malformed data or nested mismatches produce an honest `invalid_output` fallback without throwing or rendering mismatched analysis.
5. **Branch-Free Invariant:**
   - Requests at `Alert` (`03:00`) and `Evidence` (`06:00`) always send `selectedInterventionId: null`.
   - `Outcome` (`15:00`) requests require an intervention; requesting `Outcome` analysis before selecting an intervention is disabled.
6. **Honest Fallbacks & Walkthrough Access:**
   - During loading or after any failure (`disabled`, `quota_reached`, `timeout`, `invalid_output`, `version_mismatch`, `unavailable`), the authored baseline walkthrough remains fully visible and interactive.
   - Visitors can toggle between the AI analysis (when available) and the authored baseline walkthrough at will.
7. **Review Controls Restriction:**
   - Dev preview controls are strictly gated by `Boolean(import.meta.env.DEV) || import.meta.env.MODE === 'review'`.
   - URL query parameters alone will not unlock development controls in production builds.
