# Chaos Room Architecture & Deterministic Contract

## 1. Pure Deterministic Simulation Engine (`@chaos-room/shared`)

- **Reproducibility:** `(scenarioVersion, engineVersion, fixed seed, selectedInterventionId, simTimeSeconds)` produces the exact same `Snapshot` in both browser and Node runtimes via Mulberry32 PRNG (`createSeededRng`) with zero wall-clock or `Math.random()` calls.
- **No Wall-Clock Dependency:** Wall-clock time spent reading, pausing, or inspecting evidence never changes simulation outcomes or cache keys.
- **Consistent `00:00` (`Orient`) Entry & `06:00` Decision Gate:** Initial load, scenario switches, and resets start paused at `00:00`. Simulation progression auto-pauses at `03:00` (`Alert`) and `06:00` (`Evidence`), and cannot advance past `06:00` (`360s`) until the visitor applies one of the three curated interventions (including `"Observe without changing anything"`). Forward scrubbing, playback, and checkpoint jumping cannot bypass `06:00` without an explicit choice.
- **Backward Scrubbing & Pre-Debrief Hygiene:** Scrubbing prior to `06:00` hides post-`06:00` evidence and branch outcomes in the rendered snapshot. Ground-truth `debrief` data never appears in snapshots, assessments, or AI payloads prior to `15:00` (`900s`).

## 2. Headline Metric Definitions

| Measure | Window / Scope | Definition |
| :--- | :--- | :--- |
| **Reservation failures** (`errorRatePercent`) | Trailing 60 simulated seconds | Failed reservation attempts (including timeouts) divided by all reservation attempts in `[max(0, t - 60), t]`. |
| **Response time** (`p95LatencyMs`) | Trailing 60 simulated seconds | 95th percentile of completed attempt durations (including timeout durations) in `[max(0, t - 60), t]`; `null` when empty. |
| **Retry amplification** | Trailing 60 simulated seconds | Confirmation delivery attempts divided by unique confirmation messages in `[max(0, t - 60), t]`. |
| **Pending confirmations** (`confirmationBacklog`) | Current tick (`t`) | Current number of accepted reservations awaiting confirmation delivery at `t` (plus quarantined/replayed tracking in `incident-003`). |
| **Reservations impacted** (`affectedReservations`) | Cumulative (`00:00 .. t`) | Cumulative count of unique synthetic reservation IDs impacted so far during the incident; retries do not inflate this count. |

## 3. Controlled AI Backend (`@chaos-room/functions`)

The backend serves a single second-generation Firebase callable (`analyzeIncident`) running in either local `emulator_mock` mode (`MockModelProvider` + Firestore Emulator `demo-chaos-room`) or deployed `live_gemini` mode (`GeminiModelProvider` + Cloud Firestore + Secret Manager):

- **Second-Generation Callable (`functions/src/index.ts`):** Configured with `region: 'us-central1'`, `timeoutSeconds: 25`, `memory: '256MiB'`, `maxInstances: 10`, `enforceAppCheck: true`, `secrets: [geminiApiKeySecret]` via `defineSecret('GEMINI_API_KEY')`, explicit CORS allowlist (`ALLOWED_ORIGINS`), and runtime origin verification against `LIVE_PRODUCTION_ORIGINS` (`https://chaos.mikerestrepo.com`) in `live_gemini` mode unless `CHAOS_ALLOW_LOCALHOST_ORIGINS=true`.
- **Self-Contained Deployment Build:** `functions/scripts/build.mjs` compiles TypeScript and bundles `@chaos-room/shared` directly into `functions/dist/index.js` via `esbuild` so the deployed entrypoint has zero runtime workspace symlink dependencies outside `functions/` (keeping only `firebase-admin` and `firebase-functions` external).
- **Deny-All Client Firestore Rules (`firestore.rules`):** Explicitly denies all unauthenticated and authenticated browser reads and writes (`allow read, write: if false;`) across every backend collection (`analysisCache`, `generationAttempts`, `requestRecords`, `quotaDays`, `quotaMonths`, `quotaMinutes`, `visitorState`, `evaluationRuns`, `systemControl`) and catch-all routes. Only Admin SDK server transactions read or mutate state.
- **Modular Backend Responsibilities:**
  - `requestValidator.ts` — Enforces Auth/App Check context, payload byte cap (`1,024` bytes), strict schema allowlist, credential/control field rejection, and the 15 canonical `(incidentId, checkpoint, selectedInterventionId)` states.
  - `reconstruction.ts` — Rebuilds exact canonical snapshots server-side at `180s` (`alert`, `null`), `360s` (`evidence`, `null`), and `900s` (`outcome`, scenario-valid intervention) and derives SHA-256 cache keys.
  - `geminiProvider.ts` — Live REST `v1beta` `generateContent` + `:countTokens` adapter (`gemini-3.5-flash-lite` primary, `gemini-3.1-flash-lite` secondary) using matched `CountTokensRequest.generateContentRequest`, `generationConfig.responseJsonSchema`, `DEFAULT_GEMINI_THINKING_LEVEL = 'LOW'`, `maxOutputTokens: 2,000`, all-billable token accounting (`usageMetadata` input + output + thinking + extra), `CanonicalAIPacket`-only input, and zero automatic retries.
  - `accountingStore.ts` — Atomic Firestore admission transaction (`visitor` `2/min`, `12/day`, `1` pending; `project` `30/min`; `generation` `30/day` UTC, `600/month` UTC; `$4.50/month` = `4,500,000` integer microdollars), `25s` per-key generation leases, server-derived worst-case pre-provider spend reservation (`7,400` microUSD for `gemini-3.5-flash-lite`), dual runtime operational controls (`aiDisabled` and `liveGenerationDisabled`), mock vs. live cache/replay isolation (`isMockProvider`), stale/expired lease protection, UTC period rollover attribution, and idempotent reconciliation.
  - `outputValidator.ts` — Treats provider responses as unknown untrusted data, validates schema/citations/actions/bounds, and enforces server-owned provenance (`AI analysis (generated live)`, `AI analysis (shared cache hit)`, or `Mocked AI analysis (Phase 3A emulator)`).
  - `emulatorGuard.ts` — Enforces explicit runtime mode routing (`emulator_mock` default vs. dual-latch `live_gemini` requiring Secret Manager key, non-`demo-` project, and zero emulator environment variables).
- **Boundary & Retry Semantics:** Provider invocation (`15s` deadline, zero automatic retries) runs outside Firestore transactions. Controls do not guarantee exactly-once external API execution; crashes, timeouts, or unknown token usage retain the full server-derived worst-case reservation without refunding spend on lease expiry.

## 4. Visitor-Facing AI Client & State Architecture (`@chaos-room/web`)

The web frontend connects to `analyzeIncident` while preserving 100% offline autonomy and honest provenance labeling:

- **Typed Client Boundary & Environment Precedence (`aiClient.ts`, `App.tsx`):**
  - `isDevOrReviewEnvironment` (`import.meta.env.DEV` or `MODE === 'review'`) is evaluated **before** `window.__CHAOS_FIREBASE_CONFIG__` or `CHAOS_PRODUCTION_FIREBASE_CONFIG`:
    - In dev/review mode (`npm run dev`, `npm run build:review`), `App` routes to `window.__CHAOS_TRANSPORT_OVERRIDE__` (with forced mock provenance) if injected, or defaults to `MockAnalyzeIncidentTransport` so local development never fires calls to production Firebase/App Check.
    - In production builds (`!isDevOrReviewEnvironment`), `App` ignores `window.__CHAOS_TRANSPORT_OVERRIDE__` and resolves `window.__CHAOS_FIREBASE_CONFIG__ ?? CHAOS_PRODUCTION_FIREBASE_CONFIG`, initializing `FirebaseCallableTransport` (lazy dynamic imports of `firebase/app`, `firebase/auth`, `firebase/app-check`, `firebase/functions` using named app `[CHAOS_ROOM]`, `signInAnonymously`, and `ReCaptchaEnterpriseProvider`)—or `OfflineUnconfiguredTransport` if no config is present.
- **Deliberate Request Lifecycle & Ownership:**
  - AI requests require explicit visitor interaction (`Request AI analysis ({CHECKPOINT})`); no generation runs automatically on load, playback ticks, filtering, or tour steps.
  - Monotonic local invocation identity (`invocationCounterRef` / `activeInvocationIdRef`) plus `AbortController` invalidation ensures late-settling responses or errors after scenario switches, resets, scrubbing, backward navigation, branch changes, or unmounts are discarded cleanly.
  - Alert (`03:00`) and Evidence (`06:00`) requests are strictly branch-free (`selectedInterventionId: null`).
- **Independent Deadline, Retry Semantics & Unknown Data Validation:**
  - Enforces a `28,000 ms` bounded client deadline (`DEFAULT_CLIENT_ANALYSIS_DEADLINE_MS`) via `Promise.race`, reverting to the authored walkthrough with durable timeout copy.
  - Honors `retryAfterMs` cooldown timers across equivalent submission paths, preserves `requestId` for unresolved recovery (`pending` / transport failure), and generates a fresh UUID `requestId` for explicit retries after confirmed terminal failures.
  - Validates raw response envelopes and nested fields through `validateUnknownResponse` and `normalizeValidatedResponse` against the reconstructed canonical checkpoint snapshot (`CHECKPOINT_TIMES[checkpoint]`), mapping malformed responses to `invalid_output` fallback.

## 5. Workspace Layout & Accessible Onboarding (`@chaos-room/web`)

- **Consistent `00:00` Entry & Neutral Opening States:** Initial load, scenario switching, and reset start paused at `00:00` with explicit `"Accelerated simulation time"` framing (`Pace: Standard` / `Fast`). Before `03:00`, `EvidencePanel` distinguishes `"No incident evidence recorded yet at ..."` from `"No evidence items match the active filter."`, and `AssessmentPanel` keeps assessment and AI controls gated with neutral wording (never inferring healthy operations from missing evidence).
- **Mission Briefing (`MissionBriefingDialog.tsx`):** Scenario-agnostic, spoiler-free native `<dialog>` shown on fresh visits and persisted under versioned local storage (`chaos-room:mission-briefing:v1` in `onboardingPreferences.ts`, resilient to storage exceptions). Reopenable via `"Mission briefing"` in the header while pausing playback without losing investigation state.
- **Interactive Guided Tour (`GuidedTourDialog.tsx`):** Optional, non-stacking 6-step spotlight tour (`#tour-anchor-header`, `#tour-anchor-metrics`, `#tour-anchor-timeline`, `#panel-system`, `#panel-evidence`, and dynamically `#panel-analysis` pre-`06:00` or `#intervention-decision-section` at `06:00+`). Persists completion/dismissal under `chaos-room:guided-tour:v1`, switches/restores mobile tabs on Steps 4–6, traps `Tab`/`Shift+Tab` focus, moves screen-reader focus to `#guided-tour-step-title` on step changes, pauses playback without auto-resuming, honors `prefers-reduced-motion: reduce`, and triggers zero AI requests.
- **State-Driven Guidance & Responsive Workspace Order:** `resolveNextStepGuidance` (`guidanceService.ts`) provides a single reconciled guidance strip above the workspace. Visual, DOM, and keyboard focus order follows `System map → Evidence → Assessment & response`: 3 columns on wide desktop (`> 1440px`), 2 columns (`System map` + `Evidence`) above full-width `Assessment & response` on laptop (`1025px–1440px`), and 3 tabs on mobile/tablet (`<= 1024px`) with shared timeline controls preserved above the grid.
