# Chaos Room Simulator

**Live Simulator:** [https://chaos.mikerestrepo.com](https://chaos.mikerestrepo.com)  
**Product & Architecture Case Study:** [https://mikerestrepo.com/projects/chaos-room/](https://mikerestrepo.com/projects/chaos-room/)

> **Fictional system · Synthetic data**  
> All services, metrics, logs, distributed traces, reservation IDs, and deployment events in this repository are synthetic.

Chaos Room Simulator is a deterministic SRE incident investigation simulator for a fictional event-reservation platform. Visitors start at a consistent `00:00` (`Orient`) baseline, watch an outage unfold across a 7-node service topology, correlate customer impact with synchronized metrics, logs, traces, and deployment events, compare authored baseline assessments with optional grounded Gemini AI analysis, commit to an operational intervention at a hard `06:00` (`Evidence`) decision gate, and verify causal outcomes through `15:00` (`Outcome`) and the post-incident debrief.

---

## Incident Scenarios

Every scenario shares a 7-node platform topology (`visitor` → `api-gateway` → `reservation-service` → `inventory-db`, plus asynchronous `confirmation-queue` → `confirmation-worker` → `notification-provider`) and includes a plausible distraction clue alongside the real fault:

| ID | Symptom Title | Underlying Failure Mode | Plausible Distraction |
| :--- | :--- | :--- | :--- |
| **`incident-001`** | *“Reservations are timing out”* | `reservation-service` `v2.14.0` early return in `reserveWithTimeout` skips `conn.Release()`, leaking DB pool handles until `inventory-db` (`100/100`) saturates while DB CPU stays ~38%. | `+18%` promotional newsletter traffic bump (well within rated capacity). |
| **`incident-002`** | *“Reservations succeed, confirmations stall”* | External `notification-provider` latency slowdown triggers an unconstrained `0ms`-delay retry loop in `confirmation-worker`, creating a retry storm (`2.5x–6.18x`) and queue backlog while bookings succeed (`0.0%` reservation error rate). | Apparent suspicion of upstream reservation/worker crashes despite healthy `115–133 ms` reservation commits. |
| **`incident-003`** | *“A release leaves confirmations behind”* | `reservation-service` `v2.15.0` emits `schemaVersion "2.0"` payloads nesting `reservation.id` instead of root `reservationId`; `confirmation-worker` `v1.8.0` NACKs `v2.0` messages while `v1.0` canary bookings deliver normally. | `+22.2%` promotional campaign arrival bump (`108` → `132 req/min`) coinciding with queue growth. |

---

## Canonical Timeline, Onboarding & Decision Gates

Each scenario spans **15 simulated minutes (`00:00` – `15:00`)** in 5-second discrete ticks (`TICK_STEP_SECONDS = 5`, `MAX_SIMULATION_SECONDS = 900`), designed for **3–5 minutes of visitor time** with accelerated playback (`Pace: Standard` / `Fast`) and instant checkpoint jumping:

| Checkpoint | Sim Time | Workspace Behavior & Guardrails |
| :--- | :--- | :--- |
| **Orient** | `00:00` (`0s`) | Consistent paused entry state on load, scenario switch, and reset. Fresh profiles see an accessible native `<dialog>` **Mission Briefing** (`MissionBriefingDialog.tsx`), an optional 6-step **Interactive Guided Tour** (`GuidedTourDialog.tsx`), an always-visible customer journey strip, state-driven next-step guidance (`guidanceService.ts`), and neutral empty states (`"No incident evidence recorded yet..."` and locked pre-alert assessment without inferring healthy operations). |
| **Alert** | `03:00` (`180s`) | Auto-pauses as the symptom alert fires. Unlocks structured assessment (cited facts, ranked hypotheses, verification checks, and optional AI request) while keeping `recommendedInterventions: []` and requests strictly branch-free (`selectedInterventionId: null`). |
| **Evidence & Intervene** | `06:00` (`360s`) | **Hard Decision Gate.** Auto-pauses when decisive evidence is available. Forward playback, scrubbing, and checkpoint jumps cannot advance past `06:00` until the visitor applies one of three curated interventions (root-cause mitigation, capacity/symptom-masking or incomplete action, or `"Observe without changing anything"`). |
| **Outcome & Debrief** | `15:00` (`900s`) | Displays the deterministic branch outcome, allows comparing alternative branches (with `immediateTradeoff` parity), and unlocks the full causal **Debrief** (actual root cause, causal chain, alternative clue explanation, outcome comparison table, and prevention opportunities). Ground truth never enters snapshots, assessments, or AI prompts before `15:00`. |

---

## Product & Architecture Decisions

- **Pure TypeScript Deterministic Engine (`@chaos-room/shared`):** Uses a seeded Mulberry32 PRNG (`createSeededRng`) with zero wall-clock or `Math.random()` dependencies. Identical `(scenarioVersion, engineVersion, seed, simTimeSeconds, selectedInterventionId)` produces identical snapshots in browser and Node runtimes.
- **100% Autonomous Offline Operation + Explicit Provenance:** Every canonical checkpoint includes an expert-authored baseline walkthrough. If offline, rate-limited, paused by system controls, or rejected by validation, the UI degrades transparently with honest status banners (`Authored baseline walkthrough`, `Live AI analysis (Gemini)`, `Shared cached AI analysis (Gemini)`, or `Local mock: Generated AI analysis`) while keeping full investigation capability intact.
- **Server-Side Canonical Reconstruction & Cache Identity:** The callable backend (`analyzeIncident`) ignores client telemetry arrays and rebuilds the exact canonical checkpoint snapshot (`180s` / `360s` / `900s`) server-side (`reconstruction.ts`), hashing the `CanonicalAIPacket` plus `modelVersion`, `promptVersion`, and `schemaVersion` with FIPS 180-4 SHA-256 (`computeBackendCacheDocId`). UI workspace state (active tabs, filters, pinned evidence, onboarding dialogs, playback speed) never enters prompts or splits the cache.
- **Hardened Client Request Lifecycle (`aiClient.ts`, `App.tsx`):** Deliberate user-triggered requests only (never auto-fired on page load, playback ticks, or tour steps), monotonic invocation ownership (`activeInvocationIdRef`) + `AbortController` cancellation on scenario/checkpoint/branch changes, `28s` bounded client deadline, `retryAfterMs` cooldown timers, and `validateUnknownResponse` runtime schema/citation verification.
- **Zero-UI-Dependency Responsive Console:** Custom CSS & inline SVG topology workspace ordered `System map → Evidence → Assessment & response` across wide desktop (`> 1440px`, 3 columns), laptop (`1025px–1440px`, 2+1 split), and mobile (`<= 1024px`, accessible tabs with shared timeline controls).

---

## Tech Stack & Repository Structure

| Layer | Technologies |
| :--- | :--- |
| **Shared Simulation & Contracts** | TypeScript `5.7`, pure ESM package (`@chaos-room/shared`), Mulberry32 PRNG, Web Crypto / Node SHA-256 |
| **Frontend Console** | React `19`, Vite `6`, native HTML `<dialog>`, custom CSS/SVG topology & charts (`@chaos-room/web`), lazy-loaded Firebase Web SDK `11` |
| **Backend & Security** | Firebase Cloud Functions 2nd Gen (`nodejs22`, self-contained `esbuild` bundle `functions/dist/index.js`), Cloud Firestore (deny-all client `firestore.rules`, Admin SDK atomic transactions), Anonymous Firebase Auth + App Check (`ReCaptchaEnterpriseProvider`), Cloud Secret Manager (`GEMINI_API_KEY`) |
| **AI Model Integration** | Google Gemini REST `v1beta` (`gemini-3.5-flash-lite` primary, `gemini-3.1-flash-lite` secondary) using `:countTokens` + `:generateContent` (`responseJsonSchema`, `thinkingLevel: 'LOW'`) |
| **Testing & Verification** | Vitest `2.1`, React Testing Library + `jsdom`, `@firebase/rules-unit-testing`, local Firebase Firestore Emulator |

- [`packages/shared`](packages/shared) (`@chaos-room/shared`) — Deterministic simulation engine, metric aggregators, scenario definitions/debriefs/walkthroughs, canonical AI packet serializer, and SHA-256 cache digest helpers.
- [`apps/web`](apps/web) (`@chaos-room/web`) — React operations console, onboarding dialogs, guided tour, state-driven guidance, and typed AI client boundary.
- [`functions`](functions) (`@chaos-room/functions`) — Second-generation `analyzeIncident` callable, Firestore admission/accounting ledger, Gemini `v1beta` provider, strict output validator, and `esbuild` bundler.
- [`docs/`](docs) — Deep-dive technical docs: [Architecture](docs/architecture.md), [AI Contract & Cache Spec](docs/ai-contract.md), [Operations Runbook](docs/operations-runbook.md), and [Scenario Authoring Guide](docs/scenario-authoring.md).

---

## AI Usage, Safeguards & Engineering Attribution

### Runtime AI Safeguards
- **Prompt Isolation & Citation Grounding:** Prompts send only `CanonicalAIPacket` (opaque scenario ID, topology, current checkpoint measures, and visible evidence up to `checkpointTime`). Ground-truth `debrief`, future evidence, and authored `walkthroughs` never enter prompts. `outputValidator.ts` treats provider JSON as untrusted data, rejects out-of-snapshot citation IDs or cross-scenario intervention IDs, enforces `recommendedInterventions: []` at `Alert`, and overwrites provenance metadata server-side.
- **Pre-Generation Token Verification (`:countTokens`):** Before any paid `:generateContent` request is sent, `geminiProvider.ts` verifies `1 <= totalTokens <= 8,000` via `:countTokens` using the exact `{ systemInstruction, contents, generationConfig }` payload (`CountTokensRequest.generateContentRequest`) and runs `assertPreparedRequestUnchanged` before dispatch (`maxOutputTokens: 2,000`, `15,000 ms` provider deadline, zero automatic retries).
- **Atomic Budget & Rate-Limit Ledger (`accountingStore.ts`):** Every cache miss executes inside a Cloud Firestore transaction enforcing:
  - Per-visitor limits: `2` requests/min (UTC), `12` requests/day (UTC), `1` active pending request (`25s` lease TTL).
  - Project-wide limits: `30` accepted requests/min, `30` generation attempts/day (UTC), `600` generation attempts/month (UTC).
  - Application model-spend allowance: `$4.50 USD/month` (`4,500,000` integer microdollars). Worst-case spend (`7,400 µ$` / `$0.0074` for `gemini-3.5-flash-lite`) is reserved pre-call and reconciled from actual `usageMetadata` after validation; pre-generation rejections refund `100%` (`0 µ$` charged), timeouts/missing usage retain the full reservation, and shared cache hits serve validated results for `30 days` at `$0.00` incremental model cost.
- **Dual Runtime Controls & Bot Defense:** Public calls require Anonymous Auth, Firebase App Check (reCAPTCHA Enterprise), `1,024`-byte payload limit, and server-side origin checks. Two Firestore flags (`systemControl/runtime`) allow instant zero-redeploy control: `liveGenerationDisabled` pauses new Gemini calls while keeping validated cache hits live, and `aiDisabled` halts all AI responses immediately.

### Product Leadership & AI-Assisted Engineering
- **Product & Architecture Ownership (Mike Restrepo):** Defined the product vision, incident scenarios, deterministic simulation rules, `06:00` decision-gate pedagogy, onboarding UX flow, cost/rate-limit budgets, security boundaries, and release acceptance criteria.
- **AI-Assisted Implementation:** Partnered with **Antigravity** as an AI engineering co-developer to implement TypeScript modules, CSS/SVG console refinements, automated test suites, and headless verification workflows under human review and invariant testing.

---

## Local Development & Verification

### Prerequisites
- **Frontend & Unit/Integration Tests:** **Node.js `>= 22`** (tested on `v24.19.0`). Local `npm run dev` runs completely offline against `MockAnalyzeIncidentTransport`—no Firebase project, API key, or Java runtime required.
- **Firestore Emulator Tests (`npm run test:emulator` only):** **OpenJDK 21+** (required by Firebase's local Firestore emulator JAR).

```bash
# 1. Install workspace dependencies from the lockfile
npm ci

# 2. Typecheck all workspaces (@chaos-room/shared, @chaos-room/functions, @chaos-room/web)
npm run typecheck

# 3. Run all unit & integration tests (12 suites, 138 tests)
#    (pretest automatically builds the self-contained @chaos-room/functions bundle)
npm test

# 4. Build shared types, self-contained Cloud Functions bundle, and production web bundle
npm run build

# 5. Run Firestore Emulator security-rules & transaction tests (12 tests; requires OpenJDK 21+)
npm run test:emulator

# 6. Start the local Vite dev server (http://localhost:5173; defaults to offline MockAnalyzeIncidentTransport)
npm run dev
```

> **Windows PowerShell note:** If your PowerShell execution policy blocks `.ps1` shims, invoke `npm.cmd` and `npx.cmd` instead of `npm` and `npx`.

### Automated Test Coverage (Freshly Verified)
- **`npm test` (`vitest.config.ts`) — 12 test files, 138 tests:**
  - `@chaos-room/shared` (6 files, 40 tests): PRNG & cross-runtime determinism, metric invariants, canonical AI serializer & 15-state enumeration, Scenario 2 & Scenario 3 conservation/replay checks, and SHA-256 golden cache digest verification.
  - `@chaos-room/functions` unit/bundle suites (4 files, 35 tests): Pricing derivation, live/mock runtime mode guards, `GeminiModelProvider` preflight `:countTokens` & schema handling, `liveGenerationDisabled` cache-hit preservation, evaluation halt conditions, and isolated `esbuild` bundle import verification.
  - `@chaos-room/web` UI & AI client suites (2 files, 63 tests): End-to-end investigation & `06:00` gate flows, `00:00` onboarding & Mission Briefing, responsive reading order & skip-link focus, 6-step accessible Guided Tour, deliberate AI requests, request ownership/abort cancellation, runtime response validation, dev/review mock transport precedence, and production override rejection.
- **`npm run test:emulator` (`vitest.emulator.config.ts`) — 1 test file, 12 tests:**
  - End-to-end Firestore emulator tests against `demo-chaos-room` covering all 15 canonical states, 30-day shared cache reuse without TTL extension, concurrent lease conflicts, visitor/project/daily/monthly/`$4.50` spend limits, UTC day/month rollover accounting, idempotent `requestId` replay, independent provider deadlines, pre-generation `:countTokens` rejections, unclamped overrun recording, and deny-all client `firestore.rules` enforcement via `@firebase/rules-unit-testing`.

---

## Known Limitations & Tradeoffs

1. **Bounded Synthetic Scenarios vs. Open-Ended Chaos:** Scenarios run over fixed `5s` discrete ticks (`00:00`–`15:00`) with three curated interventions per incident so every branch produces verifiable causal telemetry and an educational debrief, rather than executing arbitrary commands on live containers.
2. **Application Model-Spend Allowance vs. Cloud Infrastructure Billing:** The `$4.50/month` Firestore ledger enforces an internal ceiling on Gemini API token generation (`gemini-3.5-flash-lite`), while Firebase Hosting, Cloud Functions, Firestore, Secret Manager, and App Check are governed separately under standard Google Cloud billing/free-tier quotas.
3. **Non-Guaranteed Exactly-Once External Provider Execution:** Firestore transactions serialize lease acquisition and spend reconciliation, but cannot guarantee exactly-once external model execution if a Cloud Function instance crashes or times out mid-HTTP call. The backend mitigates this by keeping automatic retries disabled (`0` retries) and retaining the full `$0.0074` worst-case reservation on timeout or unknown usage.
4. **Cold First-Request Auth & App Check Latency:** In a fresh browser profile, the first live AI request initializes lazy-loaded Firebase SDK modules, signs in anonymously, and runs reCAPTCHA Enterprise risk scoring on click, adding cold initialization latency (`~3.5–6.4s` observed in automated runs) before the callable request executes; subsequent requests in the same session reuse cached tokens (`< 1s` on cache hits).
