# Scenario Authoring Guide

Each Chaos Room incident must use an opaque identifier (`incident-001`, `incident-002`, `incident-003`) and symptom-based title so metadata never reveals the underlying failure mode before investigation.

## Required Elements per Scenario

1. **Consistent starting baseline (`00:00` / `0s` `Orient` through `01:30`):** Initial paused entry state, normal request flow, and baseline metrics. Pre-`03:00` UI states must not leak future assessments or assert healthy operations if early warning evidence is already visible before `03:00`.
2. **Initiating fault & plausible distraction (`01:30` – `03:00`):** At least one alternative hypothesis (e.g., benign traffic bump) that can be ruled out using correlated evidence (`isAlternativeClue: true`, excluded from AI packets).
3. **Three canonical analysis checkpoints:**
   - `Alert` (`03:00` / `180s`) — symptom alert fires, auto-pauses, unlocks structured assessment (`recommendedInterventions: []`)
   - `Evidence` (`06:00` / `360s`) — fixed intervention decision gate blocking progression to `15:00` until an intervention is applied
   - `Outcome` (`15:00` / `900s`) — three distinct causal branches
4. **Three curated interventions:**
   - One recommended root-cause mitigation
   - One capacity/symptom-masking or incomplete action
   - `"Observe without changing anything"` (or scenario-appropriate passive/symptom restart option) with `immediateTradeoff` copy preserved on branch-switch cards
5. **Authored walkthroughs (5 states per incident):** `Alert`, `Evidence`, and all 3 `Outcome` branches, passing `validateAnalysisResult` against canonical snapshots.
6. **Deterministic Debrief:** Actual root cause, causal chain, customer impact summary, alternative clue explanation, outcome comparison table, and prevention opportunities (strictly hidden prior to `15:00`).
