import {
  CHECKPOINT_TIMES,
  ENGINE_VERSION,
  MAX_SIMULATION_SECONDS,
  TICK_STEP_SECONDS,
  type CheckpointId,
  type HeadlineMeasures,
  type InterventionOption,
  type MetricTimelinePoint,
  type ScenarioDefinition,
  type ServiceHealth,
  type ServiceRuntimeStatus,
  type Snapshot,
  type SyntheticAttemptSample,
} from '../contracts/index.js';
import { createSeededRng, formatSimTime } from './prng.js';

export interface SimulationInput {
  scenario: ScenarioDefinition;
  seed?: number;
  simTimeSeconds: number;
  selectedInterventionId: string | null;
}

interface TickSimulationRecord {
  simTimeSeconds: number;
  attempts: SyntheticAttemptSample[];
  activeDbConnections: number;
  maxDbConnections: number;
  dbCpuPercent: number;
  confirmationBacklog: number;
  affectedReservations?: number;
  providerP95LatencyMs?: number | null;
  queueAgeP95Seconds?: number | null;
  validationErrorMsgIds?: string[];
  deliveredMsgIdsInTick?: string[];
  quarantinedBacklog?: number;
  replayedDeliveries?: number;
  acceptedReservationsTotal?: number;
  deliveredConfirmationsTotal?: number;
}

/**
 * Validates whether a given intervention ID exists in the scenario definition.
 */
export function isValidInterventionId(
  scenario: ScenarioDefinition,
  interventionId: string | null | undefined,
): interventionId is string {
  if (!interventionId) return false;
  return scenario.interventions.some((item) => item.id === interventionId);
}

/**
 * Normalizes and clamps simulation time to valid 5-second ticks.
 * Enforces the decision checkpoint lock: if no valid intervention is chosen,
 * simulation time cannot advance past 06:00 (360s).
 */
export function clampSimulationTime(
  requestedSeconds: number,
  scenario: ScenarioDefinition,
  selectedInterventionId: string | null,
): number {
  const stepped =
    Math.round(Math.max(0, Math.min(MAX_SIMULATION_SECONDS, requestedSeconds)) / TICK_STEP_SECONDS) *
    TICK_STEP_SECONDS;
  const hasValidIntervention = isValidInterventionId(scenario, selectedInterventionId);
  if (!hasValidIntervention && stepped > CHECKPOINT_TIMES.evidence) {
    return CHECKPOINT_TIMES.evidence;
  }
  return stepped;
}

/**
 * Returns the next canonical checkpoint time from the current tick, respecting
 * the 06:00 decision gate if no intervention has been selected.
 */
export function getNextCheckpointTarget(
  currentSimTimeSeconds: number,
  scenario: ScenarioDefinition,
  selectedInterventionId: string | null,
): { checkpoint: CheckpointId; targetSeconds: number; blockedByDecision: boolean } {
  if (currentSimTimeSeconds < CHECKPOINT_TIMES.alert) {
    return {
      checkpoint: 'alert',
      targetSeconds: CHECKPOINT_TIMES.alert,
      blockedByDecision: false,
    };
  }
  if (currentSimTimeSeconds < CHECKPOINT_TIMES.evidence) {
    return {
      checkpoint: 'evidence',
      targetSeconds: CHECKPOINT_TIMES.evidence,
      blockedByDecision: false,
    };
  }
  const hasDecision = isValidInterventionId(scenario, selectedInterventionId);
  if (!hasDecision) {
    return {
      checkpoint: 'evidence',
      targetSeconds: CHECKPOINT_TIMES.evidence,
      blockedByDecision: true,
    };
  }
  return {
    checkpoint: 'outcome',
    targetSeconds: CHECKPOINT_TIMES.outcome,
    blockedByDecision: false,
  };
}

interface Incident002MessageItem {
  msgId: string;
  reservationId: string;
  enqueuedAt: number;
  completedAt: number | null;
}

function generateIncident002Ticks(
  scenario: ScenarioDefinition,
  seed: number,
  selectedInterventionId: string | null,
): TickSimulationRecord[] {
  const rng = createSeededRng(seed);
  const validIntervention = isValidInterventionId(scenario, selectedInterventionId)
    ? selectedInterventionId
    : null;

  const records: TickSimulationRecord[] = [];
  let nextReservationSeq = 1;
  let nextAttemptSeq = 1;
  let nextMsgSeq = 1;

  const allMessages: Incident002MessageItem[] = [];

  for (let t = 0; t <= MAX_SIMULATION_SECONDS; t += TICK_STEP_SECONDS) {
    const attemptCount = t >= 120 ? 11 : 9;

    let providerP95LatencyMs = 125;
    let workerConcurrency = 4;
    let backoffActive = false;

    if (t < 90) {
      providerP95LatencyMs = 120 + Math.floor(rng() * 10);
    } else if (t <= 180) {
      const progress = (t - 90) / 90;
      providerP95LatencyMs = Math.round(950 + progress * 1850); // 950 ms at 90s -> 2800 ms at 180s
    } else if (t <= 360) {
      const progress = (t - 180) / 180;
      providerP95LatencyMs = Math.round(2800 + progress * 650); // reaches 3450 at 360s
    } else {
      if (validIntervention === 'act-backoff-circuit-breaker') {
        backoffActive = true;
        if (t <= 420) {
          const recProgress = (t - 360) / 60;
          providerP95LatencyMs = Math.round(3450 - recProgress * 3315); // drops to 135 ms by 420s (07:00)
        } else {
          providerP95LatencyMs = 125 + Math.floor(rng() * 10);
        }
      } else if (validIntervention === 'act-increase-concurrency') {
        workerConcurrency = 12;
        const escalProgress = Math.min(1, (t - 360) / 180);
        providerP95LatencyMs = Math.round(3450 + escalProgress * 750); // climbs to 4200 ms
      } else {
        providerP95LatencyMs = 3200 + Math.floor(rng() * 120);
      }
    }

    // 1. Upstream reservation requests commit successfully (0% error rate, 112-134 ms)
    const attempts: SyntheticAttemptSample[] = [];
    const newMessagesInTick: Incident002MessageItem[] = [];

    for (let i = 0; i < attemptCount; i++) {
      const reservationId = `res-${String(nextReservationSeq++).padStart(4, '0')}`;
      const msgId = `msg-${String(nextMsgSeq++).padStart(4, '0')}`;
      const durationMs = 112 + Math.floor(rng() * 22);

      const msg: Incident002MessageItem = {
        msgId,
        reservationId,
        enqueuedAt: t,
        completedAt: null,
      };
      allMessages.push(msg);
      newMessagesInTick.push(msg);

      attempts.push({
        attemptId: `att-${String(nextAttemptSeq++).padStart(5, '0')}`,
        reservationId,
        simTimeSeconds: t,
        durationMs,
        failed: false,
        timedOut: false,
        isRetry: false,
        confirmationCreated: true,
        confirmationCompletedAt: null,
        confirmationAttemptsInTick: 1,
      });
    }

    // 2. Deliver confirmation messages from queue based on provider status
    let deliveryAttemptsInTick = attemptCount;
    let maxDeliveriesThisTick = 0;

    if (t < 130) {
      maxDeliveriesThisTick = 25;
      deliveryAttemptsInTick = attemptCount;
    } else if (t <= 360) {
      maxDeliveriesThisTick = t <= 180 ? 2 : 8;
      const amp = t <= 180 ? 1.0 + ((t - 90) / 90) * 1.8 : 2.8 + ((t - 180) / 180) * 1.0;
      deliveryAttemptsInTick = Math.round(attemptCount * amp);
    } else {
      if (validIntervention === 'act-backoff-circuit-breaker') {
        if (t <= 420) {
          maxDeliveriesThisTick = 2;
          deliveryAttemptsInTick = Math.round(attemptCount * 1.1);
        } else {
          // Provider recovered to 135 ms; worker rapidly drains queue to 0
          maxDeliveriesThisTick = 38;
          deliveryAttemptsInTick = attemptCount;
        }
      } else if (validIntervention === 'act-increase-concurrency') {
        maxDeliveriesThisTick = 1;
        deliveryAttemptsInTick = Math.round(attemptCount * 6.2);
      } else {
        maxDeliveriesThisTick = 3;
        deliveryAttemptsInTick = Math.round(attemptCount * 3.75);
      }
    }

    if (maxDeliveriesThisTick > 0) {
      let delivered = 0;
      for (const msg of allMessages) {
        if (msg.completedAt === null && msg.enqueuedAt <= t) {
          msg.completedAt = t;
          delivered++;
          if (delivered >= maxDeliveriesThisTick) break;
        }
      }
    }

    const ampPerAttempt = deliveryAttemptsInTick / attempts.length;
    for (let i = 0; i < attempts.length; i++) {
      const att = attempts[i];
      if (att) {
        att.confirmationAttemptsInTick = ampPerAttempt;
        att.confirmationCompletedAt = newMessagesInTick[i]?.completedAt ?? null;
      }
    }

    // Pending backlog at this tick: items enqueued up to t that have not completed yet
    const pendingItems = allMessages.filter(
      (m) => m.enqueuedAt <= t && (m.completedAt === null || m.completedAt > t),
    );
    const confirmationBacklog = pendingItems.length;
    const pendingAges = pendingItems.map((m) => t - m.enqueuedAt);
    const queueAgeP95Seconds = computeP95(pendingAges) ?? 0;

    // Cumulative unique affected reservations (> 30s confirmation delay)
    let affectedCount = 0;
    for (const msg of allMessages) {
      if (msg.enqueuedAt <= t) {
        if (msg.completedAt !== null && msg.completedAt <= t) {
          if (msg.completedAt - msg.enqueuedAt > 30) {
            affectedCount++;
          }
        } else if (t - msg.enqueuedAt > 30) {
          affectedCount++;
        }
      }
    }

    records.push({
      simTimeSeconds: t,
      attempts,
      activeDbConnections: 21,
      maxDbConnections: 100,
      dbCpuPercent: 31,
      confirmationBacklog,
      affectedReservations: affectedCount,
      providerP95LatencyMs,
      queueAgeP95Seconds,
    });
  }

  return records;
}

export interface Incident003MessageItem {
  eventId: string;
  reservationId: string;
  schemaVersion: '1.0' | '2.0';
  enqueuedAt: number;
  quarantined: boolean;
  quarantinedAt: number | null;
  replayed: boolean;
  completedAt: number | null;
}

export interface Incident003DeliveryState {
  deliveredReservationIds: Set<string>;
  deliveredConfirmationsTotal: number;
  replayedDeliveriesTotal: number;
  deliveredMsgIdsInTick: string[];
}

/**
 * Pure reservationId-keyed idempotent confirmation delivery helper used for both
 * native v1.0 deliveries and adapted v2.0 FIFO replay messages. Retains original
 * msg.eventId, msg.reservationId, and msg.enqueuedAt.
 */
export function deliverIncident003Message(
  msg: Incident003MessageItem,
  simTimeSeconds: number,
  isReplay: boolean,
  state: Incident003DeliveryState,
): boolean {
  if (state.deliveredReservationIds.has(msg.reservationId)) {
    return false;
  }
  state.deliveredReservationIds.add(msg.reservationId);
  msg.completedAt = simTimeSeconds;
  if (isReplay) {
    msg.replayed = true;
    msg.quarantined = false;
    state.replayedDeliveriesTotal++;
  }
  state.deliveredConfirmationsTotal++;
  state.deliveredMsgIdsInTick.push(msg.eventId);
  return true;
}

function generateIncident003Ticks(
  scenario: ScenarioDefinition,
  seed: number,
  selectedInterventionId: string | null,
): TickSimulationRecord[] {
  const rng = createSeededRng(seed);
  const validIntervention = isValidInterventionId(scenario, selectedInterventionId)
    ? selectedInterventionId
    : null;

  const records: TickSimulationRecord[] = [];
  let nextReservationSeq = 1;
  let nextAttemptSeq = 1;
  let nextEventSeq = 1;

  const allMessages: Incident003MessageItem[] = [];
  const deliveryState: Incident003DeliveryState = {
    deliveredReservationIds: new Set<string>(),
    deliveredConfirmationsTotal: 0,
    replayedDeliveriesTotal: 0,
    deliveredMsgIdsInTick: [],
  };

  for (let t = 0; t <= MAX_SIMULATION_SECONDS; t += TICK_STEP_SECONDS) {
    const attemptCount = t >= 120 ? 11 : 9;

    // Determine incompatible v2.0 producer cohort count per tick
    let incompatibleCount = 0;
    if (t < 90) {
      incompatibleCount = 0;
    } else if (t < 120) {
      // 01:30–01:55: 3/4 pods deployed v2.15.0 (6 v2.0 + 3 v1.0)
      incompatibleCount = 6;
    } else if (t <= 360) {
      // 02:00–06:00: 8 v2.0 + 3 v1.0 = 11/tick
      incompatibleCount = 8;
    } else if (
      validIntervention === 'act-rollback-quarantine-replay' ||
      validIntervention === 'act-rollback-producer-only'
    ) {
      // Producer rolled back to v2.14.2: brief pod drain at 06:05–06:10 (4 v2.0/tick), then 0
      incompatibleCount = t <= 370 ? 4 : 0;
    } else {
      // act-restart-workers-only: producer continues emitting v2.0 events
      incompatibleCount = 8;
    }

    // 1. Upstream reservation requests persist cleanly (0% errors, 112-133 ms latency)
    const attempts: SyntheticAttemptSample[] = [];
    const newMessagesInTick: Incident003MessageItem[] = [];

    for (let i = 0; i < attemptCount; i++) {
      const reservationId = `res-${String(nextReservationSeq++).padStart(4, '0')}`;
      const eventId = `evt-${String(nextEventSeq++).padStart(4, '0')}`;
      const durationMs = 112 + Math.floor(rng() * 22);
      const schemaVersion: '1.0' | '2.0' = i < incompatibleCount ? '2.0' : '1.0';

      const msg: Incident003MessageItem = {
        eventId,
        reservationId,
        schemaVersion,
        enqueuedAt: t,
        quarantined: false,
        quarantinedAt: null,
        replayed: false,
        completedAt: null,
      };
      allMessages.push(msg);
      newMessagesInTick.push(msg);

      attempts.push({
        attemptId: `att-${String(nextAttemptSeq++).padStart(5, '0')}`,
        reservationId,
        simTimeSeconds: t,
        durationMs,
        failed: false,
        timedOut: false,
        isRetry: false,
        confirmationCreated: true,
        confirmationCompletedAt: null,
        confirmationAttemptsInTick: 1,
      });
    }

    // 2. Intervention step: Quarantine incompatible messages (06:05-06:25) in RQR branch
    if (validIntervention === 'act-rollback-quarantine-replay' && t >= 365 && t <= 385) {
      let moved = 0;
      for (const msg of allMessages) {
        if (
          msg.schemaVersion === '2.0' &&
          !msg.quarantined &&
          msg.completedAt === null &&
          msg.enqueuedAt <= t
        ) {
          msg.quarantined = true;
          msg.quarantinedAt = t;
          moved++;
          if (moved >= 90) break;
        }
      }
    }

    deliveryState.deliveredMsgIdsInTick = [];
    const validationErrorMsgIds: string[] = [];

    // 3. Deliver compatible v1.0 messages immediately (non-blocking)
    for (const msg of allMessages) {
      if (msg.schemaVersion === '1.0' && msg.completedAt === null && msg.enqueuedAt <= t) {
        deliverIncident003Message(msg, t, false, deliveryState);
      }
    }

    // 4. Adapt and replay quarantined messages starting at 06:40 (400s), 20 FIFO msgs/tick
    if (validIntervention === 'act-rollback-quarantine-replay' && t >= 400) {
      let replayedNow = 0;
      for (const msg of allMessages) {
        if (msg.quarantined && msg.completedAt === null && msg.enqueuedAt <= t) {
          if (deliverIncident003Message(msg, t, true, deliveryState)) {
            replayedNow++;
            if (replayedNow >= 20) break;
          }
        }
      }
    }

    // 5. Remaining unquarantined v2.0 messages fail worker schema validation on a 30s retry cadence
    for (const msg of allMessages) {
      if (
        msg.schemaVersion === '2.0' &&
        !msg.quarantined &&
        msg.completedAt === null &&
        msg.enqueuedAt <= t &&
        (t - msg.enqueuedAt) % 30 === 0
      ) {
        validationErrorMsgIds.push(msg.eventId);
      }
    }

    for (let i = 0; i < attempts.length; i++) {
      const att = attempts[i];
      const msg = newMessagesInTick[i];
      if (att && msg) {
        att.confirmationCompletedAt = msg.completedAt;
      }
    }

    // Outstanding confirmations include both live queue and quarantine awaiting replay
    const outstandingItems = allMessages.filter(
      (m) => m.enqueuedAt <= t && (m.completedAt === null || m.completedAt > t),
    );
    const confirmationBacklog = outstandingItems.length;
    const quarantinedBacklog = outstandingItems.filter((m) => m.quarantined).length;

    // Queue age follows original enqueue time, including during quarantine and replay
    const outstandingAges = outstandingItems.map((m) => t - m.enqueuedAt);
    const queueAgeP95Seconds = computeP95(outstandingAges) ?? 0;

    // Cumulative unique affected reservations (> 30s confirmation delay threshold)
    let affectedCount = 0;
    for (const msg of allMessages) {
      if (msg.enqueuedAt <= t) {
        if (msg.completedAt !== null && msg.completedAt <= t) {
          if (msg.completedAt - msg.enqueuedAt > 30) {
            affectedCount++;
          }
        } else if (t - msg.enqueuedAt > 30) {
          affectedCount++;
        }
      }
    }

    records.push({
      simTimeSeconds: t,
      attempts,
      activeDbConnections: 21,
      maxDbConnections: 100,
      dbCpuPercent: 31,
      confirmationBacklog,
      affectedReservations: affectedCount,
      providerP95LatencyMs: 122,
      queueAgeP95Seconds,
      validationErrorMsgIds,
      deliveredMsgIdsInTick: deliveryState.deliveredMsgIdsInTick,
      quarantinedBacklog,
      replayedDeliveries: deliveryState.replayedDeliveriesTotal,
      acceptedReservationsTotal: allMessages.length,
      deliveredConfirmationsTotal: deliveryState.deliveredConfirmationsTotal,
    });
  }

  return records;
}

/**
 * Generates deterministic tick-by-tick synthetic request and confirmation samples
 * from 00:00 (0s) to 15:00 (900s) for a given scenario, seed, and branch.
 */
function generateScenarioTicks(
  scenario: ScenarioDefinition,
  seed: number,
  selectedInterventionId: string | null,
): TickSimulationRecord[] {
  if (scenario.incidentId === 'incident-002') {
    return generateIncident002Ticks(scenario, seed, selectedInterventionId);
  }
  if (scenario.incidentId === 'incident-003') {
    return generateIncident003Ticks(scenario, seed, selectedInterventionId);
  }

  const rng = createSeededRng(seed);
  const validIntervention = isValidInterventionId(scenario, selectedInterventionId)
    ? selectedInterventionId
    : null;

  const records: TickSimulationRecord[] = [];
  let nextReservationSeq = 1;
  let nextAttemptSeq = 1;
  const pendingRetryReservationIds: string[] = [];

  for (let t = 0; t <= MAX_SIMULATION_SECONDS; t += TICK_STEP_SECONDS) {
    // Determine system parameters at tick t
    let attemptCount = 9; // ~108 req/min baseline
    let failureProbability = 0;
    let activeDbConnections = 20;
    let maxDbConnections = 100;
    let dbCpuPercent = 30;
    let baseLatencyMs = 115;
    let confirmationBacklog = 1;

    if (t >= 120) {
      // Promotional traffic bump (+18% -> ~132 req/min = 11 attempts per 5s tick)
      attemptCount = 11;
    }

    if (t < 90) {
      // 00:00 - 01:25 Healthy baseline prior to v2.14.0 release
      failureProbability = 0;
      activeDbConnections = 19 + Math.floor(rng() * 3);
      dbCpuPercent = 29 + Math.floor(rng() * 3);
      baseLatencyMs = 110;
    } else if (t <= 130) {
      // 01:30 - 02:10 v2.14.0 deployed; early tail leak starts accumulating handles
      const progress = (t - 90) / 40;
      failureProbability = t >= 120 ? 0.04 : 0;
      activeDbConnections = Math.round(22 + progress * 36);
      dbCpuPercent = 33 + Math.floor(rng() * 3);
      baseLatencyMs = Math.round(125 + progress * 90);
    } else if (t <= 180) {
      // 02:15 - 03:00 (Alert checkpoint at 180s): pool climbs rapidly to 92/100
      const progress = (t - 130) / 50;
      failureProbability = 0.14 + progress * 0.24;
      activeDbConnections = Math.min(100, Math.round(62 + progress * 32));
      dbCpuPercent = 36 + Math.floor(rng() * 3);
      baseLatencyMs = Math.round(280 + progress * 450);
    } else if (t <= 360) {
      // 03:05 - 06:00 (Evidence checkpoint at 360s): pool saturated at 100/100
      failureProbability = 0.44;
      activeDbConnections = 100;
      dbCpuPercent = 37 + (t % 10 === 0 ? 1 : 0);
      baseLatencyMs = 680;
    } else {
      // Post-06:00 (365s - 900s): branched by selectedInterventionId fixed at 06:00
      if (validIntervention === 'act-rollback-drain') {
        if (t <= 395) {
          // 06:05 - 06:35 Cordoning v2.14.0 pods & draining in-flight requests (brief disruption)
          const drainProgress = (t - 360) / 35;
          failureProbability = Math.max(0.08, 0.32 * (1 - drainProgress));
          activeDbConnections = Math.round(100 - drainProgress * 52);
          dbCpuPercent = 35;
          baseLatencyMs = Math.round(420 * (1 - drainProgress * 0.6));
        } else {
          // 06:40 - 15:00 Full recovery on v2.13.4; zero errors
          failureProbability = 0;
          activeDbConnections = 20 + (t % 15 === 0 ? 2 : 0);
          dbCpuPercent = 30 + (t % 10 === 0 ? 1 : 0);
          baseLatencyMs = 112;
        }
      } else if (validIntervention === 'act-increase-pool') {
        maxDbConnections = 200;
        if (t <= 465) {
          // 06:05 - 07:45 Temporary improvement: extra 100 pool slots absorb demand
          const fillProgress = (t - 360) / 105;
          failureProbability = t <= 365 ? 0.09 : t % 20 === 0 ? 0.09 : 0;
          activeDbConnections = Math.round(104 + fillProgress * 46); // climbs 104 -> 150
          dbCpuPercent = 41 + (t % 10 === 0 ? 1 : 0);
          baseLatencyMs = Math.round(145 + fillProgress * 65);
        } else if (t <= 570) {
          // 07:50 - 09:30 Leak fills remaining slots (154 -> 200); timeouts ramp back up
          const satProgress = (t - 465) / 105;
          failureProbability = 0.08 + satProgress * 0.36;
          activeDbConnections = Math.min(200, Math.round(154 + satProgress * 46));
          dbCpuPercent = 40;
          baseLatencyMs = Math.round(240 + satProgress * 520);
        } else {
          // 09:35 - 15:00 Re-saturated at 200/200; severe timeouts persist
          failureProbability = 0.44;
          activeDbConnections = 200;
          dbCpuPercent = 39;
          baseLatencyMs = 710;
        }
      } else {
        // 'act-observe' (or fallback): remains pinned at 100/100 with ~46% error rate
        failureProbability = 0.46;
        activeDbConnections = 100;
        dbCpuPercent = 38;
        baseLatencyMs = 720;
      }
    }

    const attempts: SyntheticAttemptSample[] = [];
    for (let i = 0; i < attemptCount; i++) {
      const roll = rng();
      const latencyJitter = Math.round(rng() * 38);

      // Decide if this attempt is a retry of a recently failed reservation ID
      let isRetry = false;
      let reservationId: string;
      if (pendingRetryReservationIds.length > 0 && i % 3 === 0) {
        reservationId = pendingRetryReservationIds.shift()!;
        isRetry = true;
      } else {
        reservationId = `res-${String(nextReservationSeq++).padStart(4, '0')}`;
      }

      const failed = failureProbability > 0 && (i / attemptCount < failureProbability || roll < failureProbability * 0.25);
      const timedOut = failed;
      const durationMs = timedOut
        ? 2460 + Math.min(40, latencyJitter)
        : baseLatencyMs + latencyJitter;

      if (failed && !isRetry && pendingRetryReservationIds.length < 24) {
        pendingRetryReservationIds.push(reservationId);
      }

      attempts.push({
        attemptId: `att-${String(nextAttemptSeq++).padStart(5, '0')}`,
        reservationId,
        simTimeSeconds: t,
        durationMs,
        failed,
        timedOut,
        isRetry,
        confirmationCreated: !failed,
        confirmationCompletedAt: !failed ? t + TICK_STEP_SECONDS : null,
        confirmationAttemptsInTick: !failed ? 1 : 0,
      });
    }

    // Confirmation pipeline remains healthy in incident-001 (1-2 in-flight items)
    const successfulInTick = attempts.filter((a) => !a.failed).length;
    confirmationBacklog = Math.max(0, Math.min(3, Math.round(successfulInTick / 6)));

    records.push({
      simTimeSeconds: t,
      attempts,
      activeDbConnections,
      maxDbConnections,
      dbCpuPercent,
      confirmationBacklog,
    });
  }

  return records;
}

/**
 * Computes the 95th percentile from a list of durations, or null if empty.
 */
export function computeP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx] ?? null;
}

/**
 * Computes headline measures at target tick `simTimeSeconds` from tick records.
 * - Reservation error rate, API p95 latency, and retry amplification use trailing 60-simulated-second windows.
 * - Confirmation backlog is the current number awaiting confirmation at `simTimeSeconds`.
 * - Affected reservations is the cumulative count of unique impacted reservation IDs during the incident up to `simTimeSeconds`.
 */
function computeMeasuresAtTick(
  records: TickSimulationRecord[],
  simTimeSeconds: number,
  scenarioIncidentId: string = 'incident-001',
): HeadlineMeasures {
  const windowStart = Math.max(0, simTimeSeconds - 60);
  const windowRecords = records.filter(
    (r) => r.simTimeSeconds >= windowStart && r.simTimeSeconds <= simTimeSeconds,
  );
  const cumulativeRecords = records.filter((r) => r.simTimeSeconds <= simTimeSeconds);
  const currentRecord =
    records.find((r) => r.simTimeSeconds === simTimeSeconds) ??
    records[records.length - 1]!;

  const windowAttempts = windowRecords.flatMap((r) => r.attempts);
  const failedWindowAttempts = windowAttempts.filter((a) => a.failed);
  const reservationErrorRate =
    windowAttempts.length > 0
      ? Number((failedWindowAttempts.length / windowAttempts.length).toFixed(4))
      : 0;

  const durations = windowAttempts.map((a) => a.durationMs);
  const apiP95LatencyMs = computeP95(durations);

  const isInc2 = scenarioIncidentId === 'incident-002';
  const isInc3 = scenarioIncidentId === 'incident-003';

  // Unique confirmation messages vs delivery/validation attempts in trailing 60s
  let retryAmplification = 1.0;
  let validationErrorAttempts = 0;
  let validationErrorUniqueMessages = 0;

  if (isInc3) {
    const windowValIds = windowRecords.flatMap((r) => r.validationErrorMsgIds ?? []);
    const windowDeliveredIds = windowRecords.flatMap((r) => r.deliveredMsgIdsInTick ?? []);
    validationErrorAttempts = windowValIds.length;
    validationErrorUniqueMessages = new Set(windowValIds).size;
    const totalTouchedUnique = new Set([...windowValIds, ...windowDeliveredIds]).size;
    const totalAttemptsInWindow = windowValIds.length + windowDeliveredIds.length;
    retryAmplification =
      validationErrorAttempts === 0 || totalTouchedUnique === 0
        ? 1.0
        : Number((totalAttemptsInWindow / totalTouchedUnique).toFixed(2));
  } else {
    const confirmedWindowAttempts = windowAttempts.filter((a) => a.confirmationCreated);
    const totalDeliveryAttempts = confirmedWindowAttempts.reduce(
      (sum, a) => sum + a.confirmationAttemptsInTick,
      0,
    );
    retryAmplification =
      confirmedWindowAttempts.length > 0
        ? Number((totalDeliveryAttempts / confirmedWindowAttempts.length).toFixed(2))
        : 1.0;
  }

  // Cumulative unique impacted reservation IDs up to simTimeSeconds
  const impactedReservationIds = new Set<string>();
  if (!isInc2 && !isInc3) {
    for (const rec of cumulativeRecords) {
      for (const att of rec.attempts) {
        if (att.failed) {
          impactedReservationIds.add(att.reservationId);
        }
      }
    }
  }

  const affectedReservations =
    (isInc2 || isInc3) && currentRecord.affectedReservations !== undefined
      ? currentRecord.affectedReservations
      : impactedReservationIds.size;

  const base: HeadlineMeasures = {
    reservationErrorRate,
    apiP95LatencyMs,
    confirmationBacklog: currentRecord.confirmationBacklog,
    affectedReservations,
    retryAmplification,
    windowAttempts: windowAttempts.length,
    windowFailedAttempts: failedWindowAttempts.length,
    activeDbConnections: currentRecord.activeDbConnections,
    maxDbConnections: currentRecord.maxDbConnections,
    dbCpuPercent: currentRecord.dbCpuPercent,
  };

  if (isInc2) {
    base.providerP95LatencyMs = currentRecord.providerP95LatencyMs;
    base.queueAgeP95Seconds = currentRecord.queueAgeP95Seconds;
  }

  if (isInc3) {
    base.providerP95LatencyMs = currentRecord.providerP95LatencyMs;
    base.queueAgeP95Seconds = currentRecord.queueAgeP95Seconds;
    base.validationErrorAttempts = validationErrorAttempts;
    base.validationErrorUniqueMessages = validationErrorUniqueMessages;
    base.quarantinedBacklog = currentRecord.quarantinedBacklog ?? 0;
    base.replayedDeliveries = currentRecord.replayedDeliveries ?? 0;
    base.acceptedReservationsTotal = currentRecord.acceptedReservationsTotal ?? 0;
    base.deliveredConfirmationsTotal = currentRecord.deliveredConfirmationsTotal ?? 0;
  }

  return base;
}

function buildIncident002ServiceStatuses(
  scenario: ScenarioDefinition,
  measures: HeadlineMeasures,
  simTimeSeconds: number,
  selectedInterventionId: string | null,
): ServiceRuntimeStatus[] {
  const providerLatency = measures.providerP95LatencyMs ?? 125;
  const backlog = measures.confirmationBacklog;
  const retryAmp = measures.retryAmplification;

  return scenario.topology.map((node) => {
    switch (node.id) {
      case 'visitor': {
        const health: ServiceHealth =
          backlog >= 150 ? 'failing' : backlog >= 30 ? 'degraded' : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            backlog > 20
              ? `Reservations succeed (0% errors); confirmations delayed (${backlog} queued)`
              : 'Reservations and confirmations completing normally',
          primaryMetricLabel: 'Affected IDs',
          primaryMetricValue: `${measures.affectedReservations}`,
          secondaryMetricLabel: 'Error rate (60s)',
          secondaryMetricValue: '0.0%',
        };
      }
      case 'api-gateway': {
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Routing normally within SLO (0.0% error rate)',
          primaryMetricLabel: 'API p95 (60s)',
          primaryMetricValue:
            measures.apiP95LatencyMs !== null ? `${measures.apiP95LatencyMs} ms` : '115 ms',
          secondaryMetricLabel: 'Window attempts',
          secondaryMetricValue: `${measures.windowAttempts} / 60s`,
        };
      }
      case 'reservation-service': {
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Persisting reservations and enqueuing confirmation events normally',
          primaryMetricLabel: 'Error rate (60s)',
          primaryMetricValue: '0.0%',
          secondaryMetricLabel: 'Enqueue rate',
          secondaryMetricValue: '132 msgs/min',
        };
      }
      case 'inventory-db': {
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Connection pool and transaction commits healthy',
          primaryMetricLabel: 'Active DB pool',
          primaryMetricValue: `${measures.activeDbConnections} / ${measures.maxDbConnections}`,
          secondaryMetricLabel: 'DB CPU',
          secondaryMetricValue: `${measures.dbCpuPercent}%`,
        };
      }
      case 'confirmation-queue': {
        const health: ServiceHealth =
          backlog >= 150 ? 'failing' : backlog >= 30 ? 'degraded' : 'healthy';
        const p95Age = measures.queueAgeP95Seconds ?? 0;
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? `Backlog critical (${backlog} messages; p95 age ${p95Age}s)`
              : health === 'degraded'
                ? `Backlog mounting (${backlog} messages; p95 age ${p95Age}s)`
                : 'Queue depth normal (< 5 messages)',
          primaryMetricLabel: 'Queue depth',
          primaryMetricValue: `${backlog} msgs`,
          secondaryMetricLabel: 'Queue age p95',
          secondaryMetricValue: `${p95Age}s`,
        };
      }
      case 'confirmation-worker': {
        const health: ServiceHealth =
          retryAmp >= 2.0 ? 'failing' : retryAmp > 1.2 ? 'degraded' : 'healthy';
        const threads =
          selectedInterventionId === 'act-increase-concurrency' &&
          simTimeSeconds > CHECKPOINT_TIMES.evidence
            ? '12 threads'
            : '4 threads';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? `Retry storm active (${retryAmp.toFixed(2)}x attempt amplification)`
              : health === 'degraded'
                ? `Elevated retry rate (${retryAmp.toFixed(2)}x amplification)`
                : 'Delivering confirmations normally (1.0x amplification)',
          primaryMetricLabel: 'Retry amp (60s)',
          primaryMetricValue: `${retryAmp.toFixed(2)}x`,
          secondaryMetricLabel: 'Worker pool',
          secondaryMetricValue: threads,
        };
      }
      case 'notification-provider': {
        const health: ServiceHealth =
          providerLatency >= 2000 ? 'failing' : providerLatency >= 500 ? 'degraded' : 'healthy';
        const is429 =
          providerLatency >= 2000
            ? selectedInterventionId === 'act-increase-concurrency' &&
              simTimeSeconds > CHECKPOINT_TIMES.evidence
              ? '78% HTTP 429'
              : '42% HTTP 429'
            : '0%';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? `Downstream carrier delay (${providerLatency} ms) & rate limiting`
              : health === 'degraded'
                ? `Elevated response latency (${providerLatency} ms)`
                : 'External confirmation delivery healthy (< 150 ms)',
          primaryMetricLabel: 'Provider p95',
          primaryMetricValue: `${providerLatency} ms`,
          secondaryMetricLabel: 'Throttle rate',
          secondaryMetricValue: is429,
        };
      }
    }
  });
}

function buildIncident003ServiceStatuses(
  scenario: ScenarioDefinition,
  measures: HeadlineMeasures,
  simTimeSeconds: number,
  selectedInterventionId: string | null,
): ServiceRuntimeStatus[] {
  const backlog = measures.confirmationBacklog;
  const quarantined = measures.quarantinedBacklog ?? 0;
  const replayed = measures.replayedDeliveries ?? 0;
  const p95Age = measures.queueAgeP95Seconds ?? 0;
  const valAttempts = measures.validationErrorAttempts ?? 0;
  const valUnique = measures.validationErrorUniqueMessages ?? 0;
  const acceptedTotal = measures.acceptedReservationsTotal ?? 0;
  const deliveredTotal = measures.deliveredConfirmationsTotal ?? 0;
  const providerLatency = measures.providerP95LatencyMs ?? 122;

  const isRolledBack =
    simTimeSeconds > CHECKPOINT_TIMES.evidence &&
    (selectedInterventionId === 'act-rollback-quarantine-replay' ||
      selectedInterventionId === 'act-rollback-producer-only') &&
    simTimeSeconds >= 375;

  const isDrainingRollback =
    simTimeSeconds > CHECKPOINT_TIMES.evidence &&
    (selectedInterventionId === 'act-rollback-quarantine-replay' ||
      selectedInterventionId === 'act-rollback-producer-only') &&
    simTimeSeconds < 375;

  return scenario.topology.map((node) => {
    switch (node.id) {
      case 'visitor': {
        const health: ServiceHealth =
          backlog >= 150 ? 'failing' : backlog >= 20 ? 'degraded' : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            backlog > 0
              ? `Reservations succeed (0% errors); ${backlog} confirmations pending (${deliveredTotal}/${acceptedTotal} delivered)`
              : 'Reservations and confirmations completing normally',
          primaryMetricLabel: 'Affected IDs',
          primaryMetricValue: `${measures.affectedReservations}`,
          secondaryMetricLabel: 'Delivered',
          secondaryMetricValue: `${deliveredTotal} / ${acceptedTotal}`,
        };
      }
      case 'api-gateway': {
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Routing normally within SLO (0.0% error rate)',
          primaryMetricLabel: 'API p95 (60s)',
          primaryMetricValue:
            measures.apiP95LatencyMs !== null ? `${measures.apiP95LatencyMs} ms` : '115 ms',
          secondaryMetricLabel: 'Window attempts',
          secondaryMetricValue: `${measures.windowAttempts} / 60s`,
        };
      }
      case 'reservation-service': {
        const versionTag =
          simTimeSeconds < 90
            ? 'v2.14.2'
            : isRolledBack
              ? 'v2.14.2 (rolled back)'
              : isDrainingRollback
                ? 'v2.15.0 → v2.14.2'
                : 'v2.15.0 (3/4 pods)';
        const schemaTag =
          simTimeSeconds < 90
            ? 'schema v1.0'
            : isRolledBack
              ? 'schema v1.0'
              : isDrainingRollback
                ? 'draining v2.0 → v1.0'
                : simTimeSeconds < 120
                  ? 'v2.0 (67%) / v1.0'
                  : 'v2.0 (73%) / v1.0';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: `Persisting reservations (0.0% API errors) & publishing confirmation events (${versionTag})`,
          primaryMetricLabel: 'Release',
          primaryMetricValue: versionTag,
          secondaryMetricLabel: 'Event schema',
          secondaryMetricValue: schemaTag,
        };
      }
      case 'inventory-db': {
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Connection pool and reservation commits healthy',
          primaryMetricLabel: 'Active DB pool',
          primaryMetricValue: `${measures.activeDbConnections} / ${measures.maxDbConnections}`,
          secondaryMetricLabel: 'DB CPU',
          secondaryMetricValue: `${measures.dbCpuPercent}%`,
        };
      }
      case 'confirmation-queue': {
        const health: ServiceHealth =
          backlog >= 150 ? 'failing' : backlog >= 20 ? 'degraded' : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            backlog === 0
              ? 'Queue cleared; all confirmations delivered'
              : quarantined > 0
                ? `${backlog} outstanding (${quarantined} quarantined; p95 age ${p95Age}s)`
                : `${backlog} outstanding confirmations retained (p95 age ${p95Age}s)`,
          primaryMetricLabel: 'Outstanding',
          primaryMetricValue: `${backlog} msgs`,
          secondaryMetricLabel: 'Quarantined / p95 age',
          secondaryMetricValue: `${quarantined} / ${p95Age}s`,
        };
      }
      case 'confirmation-worker': {
        const health: ServiceHealth =
          valAttempts >= 150 ? 'failing' : valAttempts > 0 ? 'degraded' : 'healthy';
        const workerMode =
          selectedInterventionId === 'act-rollback-quarantine-replay' && simTimeSeconds >= 400
            ? 'v1.8.0+adapt'
            : selectedInterventionId === 'act-restart-workers-only' &&
                simTimeSeconds > CHECKPOINT_TIMES.evidence &&
                simTimeSeconds <= 385
              ? 'v1.8.0 (restart)'
              : 'v1.8.0';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            valAttempts > 0
              ? `Schema validation failing (${valAttempts} attempts / ${valUnique} unique msgs in 60s); v1.0 still delivering`
              : replayed > 0 && backlog > 0
                ? `Adapting & replaying quarantined messages (${replayed} replayed cleanly)`
                : 'Delivering confirmations cleanly (0 validation failures)',
          primaryMetricLabel: 'Val fails (60s)',
          primaryMetricValue: `${valAttempts} (${valUnique} uniq)`,
          secondaryMetricLabel: 'Replayed',
          secondaryMetricValue: `${replayed} (${workerMode})`,
        };
      }
      case 'notification-provider': {
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'External notification delivery healthy (valid payloads return HTTP 200)',
          primaryMetricLabel: 'Provider p95',
          primaryMetricValue: `${providerLatency} ms`,
          secondaryMetricLabel: 'Delivery status',
          secondaryMetricValue: '100% HTTP 200',
        };
      }
    }
  });
}

function buildServiceStatuses(
  scenario: ScenarioDefinition,
  measures: HeadlineMeasures,
  simTimeSeconds: number,
  selectedInterventionId: string | null,
): ServiceRuntimeStatus[] {
  if (scenario.incidentId === 'incident-002') {
    return buildIncident002ServiceStatuses(
      scenario,
      measures,
      simTimeSeconds,
      selectedInterventionId,
    );
  }
  if (scenario.incidentId === 'incident-003') {
    return buildIncident003ServiceStatuses(
      scenario,
      measures,
      simTimeSeconds,
      selectedInterventionId,
    );
  }

  const errPct = Math.round(measures.reservationErrorRate * 100);
  const poolRatio = measures.activeDbConnections / measures.maxDbConnections;

  return scenario.topology.map((node) => {
    switch (node.id) {
      case 'visitor': {
        const health: ServiceHealth =
          errPct >= 20 ? 'failing' : errPct > 0 ? 'degraded' : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? `${errPct}% of reservation attempts timing out`
              : health === 'degraded'
                ? 'Elevated reservation tail latency'
                : 'Reservations completing normally',
          primaryMetricLabel: 'Affected IDs',
          primaryMetricValue: `${measures.affectedReservations}`,
          secondaryMetricLabel: 'Error rate (60s)',
          secondaryMetricValue: `${(measures.reservationErrorRate * 100).toFixed(1)}%`,
        };
      }
      case 'api-gateway': {
        const health: ServiceHealth =
          (measures.apiP95LatencyMs ?? 0) >= 1800
            ? 'failing'
            : (measures.apiP95LatencyMs ?? 0) >= 500
              ? 'degraded'
              : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? 'Returning HTTP 504 on 2,500 ms upstream timeouts'
              : health === 'degraded'
                ? 'Elevated upstream wait time'
                : 'Routing normally within SLO',
          primaryMetricLabel: 'API p95 (60s)',
          primaryMetricValue:
            measures.apiP95LatencyMs !== null ? `${measures.apiP95LatencyMs} ms` : 'No data',
          secondaryMetricLabel: 'Window attempts',
          secondaryMetricValue: `${measures.windowAttempts} / 60s`,
        };
      }
      case 'reservation-service': {
        const isRolledBack =
          simTimeSeconds > CHECKPOINT_TIMES.evidence &&
          selectedInterventionId === 'act-rollback-drain' &&
          simTimeSeconds >= 410;
        const versionTag =
          simTimeSeconds < 90 ? 'v2.13.4' : isRolledBack ? 'v2.13.4 (rolled back)' : 'v2.14.0';
        const health: ServiceHealth =
          errPct >= 15 || poolRatio >= 0.95
            ? 'failing'
            : errPct > 0 || poolRatio >= 0.65
              ? 'degraded'
              : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? `Blocked acquiring DB handles (${versionTag})`
              : health === 'degraded'
                ? `Pool pressure elevated (${versionTag})`
                : `Acquiring & releasing handles cleanly (${versionTag})`,
          primaryMetricLabel: 'Release',
          primaryMetricValue: versionTag,
          secondaryMetricLabel: 'Failed (60s)',
          secondaryMetricValue: `${measures.windowFailedAttempts} / ${measures.windowAttempts}`,
        };
      }
      case 'inventory-db': {
        const health: ServiceHealth =
          poolRatio >= 0.95 ? 'failing' : poolRatio >= 0.65 ? 'degraded' : 'healthy';
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health,
          statusSummary:
            health === 'failing'
              ? `Connection pool saturated (${measures.activeDbConnections}/${measures.maxDbConnections}); CPU moderate`
              : health === 'degraded'
                ? `Active connections climbing (${measures.activeDbConnections}/${measures.maxDbConnections})`
                : `Pool healthy (${measures.activeDbConnections}/${measures.maxDbConnections})`,
          primaryMetricLabel: 'Active pool',
          primaryMetricValue: `${measures.activeDbConnections} / ${measures.maxDbConnections}`,
          secondaryMetricLabel: 'DB CPU',
          secondaryMetricValue: `${measures.dbCpuPercent}%`,
        };
      }
      case 'confirmation-queue':
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Queue draining normally for accepted reservations',
          primaryMetricLabel: 'Backlog',
          primaryMetricValue: `${measures.confirmationBacklog} msg`,
          secondaryMetricLabel: 'Queue age p95',
          secondaryMetricValue: '40 ms',
        };
      case 'confirmation-worker':
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'Processing queued confirmations without backlog',
          primaryMetricLabel: 'Retry amp (60s)',
          primaryMetricValue: `${measures.retryAmplification.toFixed(2)}x`,
          secondaryMetricLabel: 'Worker CPU',
          secondaryMetricValue: '19%',
        };
      case 'notification-provider':
        return {
          id: node.id,
          name: node.name,
          role: node.role,
          health: 'healthy',
          statusSummary: 'External confirmation delivery healthy',
          primaryMetricLabel: 'Provider p95',
          primaryMetricValue: '110 ms',
          secondaryMetricLabel: 'Delivery success',
          secondaryMetricValue: '100%',
        };
    }
  });
}

/**
 * Pure deterministic snapshot builder.
 * Identical (scenarioVersion, engineVersion, seed, selectedInterventionId, simTimeSeconds)
 * always produce the exact same Snapshot in browser and Node.
 */
export function buildSnapshot(input: SimulationInput): Snapshot {
  const { scenario } = input;
  const seed = input.seed ?? scenario.defaultSeed;
  const validIntervention = isValidInterventionId(scenario, input.selectedInterventionId)
    ? input.selectedInterventionId
    : null;

  const clampedTime = clampSimulationTime(input.simTimeSeconds, scenario, validIntervention);

  // If scrubbed before 06:00 (360s), hide future branch effects in the snapshot
  const effectiveInterventionAtTick =
    clampedTime >= CHECKPOINT_TIMES.evidence ? validIntervention : null;

  const allRecords = generateScenarioTicks(scenario, seed, effectiveInterventionAtTick);
  const isInc2 = scenario.incidentId === 'incident-002';
  const isInc3 = scenario.incidentId === 'incident-003';
  const measures = computeMeasuresAtTick(allRecords, clampedTime, scenario.incidentId);

  const timelineSeries: MetricTimelinePoint[] = [];
  for (let t = 0; t <= clampedTime; t += 15) {
    const m = computeMeasuresAtTick(allRecords, t, scenario.incidentId);
    const pt: MetricTimelinePoint = {
      simTimeSeconds: t,
      formattedTime: formatSimTime(t),
      reservationErrorRate: m.reservationErrorRate,
      apiP95LatencyMs: m.apiP95LatencyMs,
      confirmationBacklog: m.confirmationBacklog,
      affectedReservations: m.affectedReservations,
      retryAmplification: m.retryAmplification,
      activeDbConnections: m.activeDbConnections,
      maxDbConnections: m.maxDbConnections,
      dbCpuPercent: m.dbCpuPercent,
      requestsPerMinute: m.windowAttempts,
    };
    if (isInc2) {
      pt.providerP95LatencyMs = m.providerP95LatencyMs;
      pt.queueAgeP95Seconds = m.queueAgeP95Seconds;
    }
    if (isInc3) {
      pt.providerP95LatencyMs = m.providerP95LatencyMs;
      pt.queueAgeP95Seconds = m.queueAgeP95Seconds;
      pt.validationErrorAttempts = m.validationErrorAttempts;
      pt.validationErrorUniqueMessages = m.validationErrorUniqueMessages;
      pt.quarantinedBacklog = m.quarantinedBacklog;
      pt.replayedDeliveries = m.replayedDeliveries;
    }
    timelineSeries.push(pt);
  }

  const reachedCheckpoints: CheckpointId[] = [];
  if (clampedTime >= CHECKPOINT_TIMES.alert) reachedCheckpoints.push('alert');
  if (clampedTime >= CHECKPOINT_TIMES.evidence) reachedCheckpoints.push('evidence');
  if (clampedTime >= CHECKPOINT_TIMES.outcome && effectiveInterventionAtTick !== null) {
    reachedCheckpoints.push('outcome');
  }

  let activeCheckpoint: CheckpointId | null = null;
  if (clampedTime === CHECKPOINT_TIMES.outcome && effectiveInterventionAtTick !== null) {
    activeCheckpoint = 'outcome';
  } else if (clampedTime >= CHECKPOINT_TIMES.evidence) {
    activeCheckpoint = 'evidence';
  } else if (clampedTime >= CHECKPOINT_TIMES.alert) {
    activeCheckpoint = 'alert';
  }

  const awaitingInterventionDecision =
    clampedTime === CHECKPOINT_TIMES.evidence && validIntervention === null;

  const visibleEvidence = scenario
    .buildEvidenceCatalog(effectiveInterventionAtTick)
    .filter((item) => item.simTimeSeconds <= clampedTime);

  // Interventions are only visible once the visitor reaches the Evidence checkpoint (06:00).
  // For Scenario 3, resolve clock-gated stageSchedule so completed-stage facts only unlock on
  // the active branch once the simulation clock reaches each stage's observation time.
  const availableInterventions: InterventionOption[] =
    clampedTime >= CHECKPOINT_TIMES.evidence
      ? isInc3
        ? scenario.interventions.map((option) => {
            const { stageSchedule, ...rest } = option;
            if (!stageSchedule) {
              return rest;
            }
            const isActiveBranch = effectiveInterventionAtTick === option.id;
            return {
              ...rest,
              stages: stageSchedule.map((entry) =>
                isActiveBranch && clampedTime >= entry.unlocksAtSeconds
                  ? entry.observedText
                  : entry.plannedText,
              ),
            };
          })
        : scenario.interventions
      : [];

  let severity: Snapshot['severity'] = 'normal';
  let customerImpactBanner =
    'Normal operations — Visitors are reserving event spots and receiving confirmations within SLO.';

  if (isInc2) {
    if (clampedTime < 90) {
      severity = 'normal';
      customerImpactBanner =
        'Normal operations — Visitors are reserving event spots and receiving confirmation emails within SLO.';
    } else if (clampedTime < CHECKPOINT_TIMES.alert) {
      severity = 'elevated';
      customerImpactBanner =
        'Early degradation — Notification provider latency is rising; confirmation queue age is beginning to climb.';
    } else if (clampedTime <= CHECKPOINT_TIMES.evidence) {
      severity = 'high';
      customerImpactBanner = `Active incident — Confirmation queue backlogged at ${measures.confirmationBacklog} messages; confirmations delayed for ${measures.affectedReservations} reservations. Upstream reservations 100% operational.`;
    } else if (effectiveInterventionAtTick === 'act-backoff-circuit-breaker') {
      if (measures.confirmationBacklog > 5) {
        severity = 'recovering';
        customerImpactBanner = `Mitigation in progress — Backoff and circuit breaker contained retry storm; provider recovered, confirmation queue draining (${measures.confirmationBacklog} remaining).`;
      } else {
        severity = 'resolved';
        customerImpactBanner = `Service recovered — Confirmation queue cleared. ${measures.affectedReservations} reservations experienced confirmation delays over 30 seconds.`;
      }
    } else if (effectiveInterventionAtTick === 'act-increase-concurrency') {
      severity = 'critical';
      customerImpactBanner = `Severe escalation — Tripled worker concurrency overwhelmed partner provider; retry amplification at ${measures.retryAmplification.toFixed(2)}x with ${measures.confirmationBacklog} messages stalled in queue.`;
    } else {
      severity = 'high';
      customerImpactBanner = `Unresolved stall — Continuous unconstrained retries sustain downstream provider throttling; ${measures.confirmationBacklog} messages delayed in queue.`;
    }
  } else if (isInc3) {
    if (clampedTime < 90) {
      severity = 'normal';
      customerImpactBanner =
        'Normal operations — Visitors are reserving event spots and receiving confirmations within SLO.';
    } else if (clampedTime < CHECKPOINT_TIMES.alert) {
      severity = 'elevated';
      customerImpactBanner =
        'Early anomaly — A subset of accepted reservations are missing ticket confirmations while other confirmations continue delivering on time.';
    } else if (clampedTime <= CHECKPOINT_TIMES.evidence) {
      severity = 'high';
      customerImpactBanner = `Active incident — ${measures.confirmationBacklog} confirmations remain pending (${measures.validationErrorAttempts ?? 0} worker validation failures across ${measures.validationErrorUniqueMessages ?? 0} unique messages in 60s); ${measures.affectedReservations} reservations delayed > 30s while reservation API stays 100% operational.`;
    } else if (effectiveInterventionAtTick === 'act-rollback-quarantine-replay') {
      if (measures.confirmationBacklog > 0) {
        severity = 'recovering';
        customerImpactBanner = `Mitigation in progress — Producer rolled back; ${measures.quarantinedBacklog ?? 0} failed events quarantined, ${measures.replayedDeliveries ?? 0} adapted & replayed (${measures.confirmationBacklog} outstanding confirmations remaining).`;
      } else {
        severity = 'resolved';
        customerImpactBanner = `Service recovered — All ${measures.deliveredConfirmationsTotal ?? 1943} confirmations delivered cleanly (including ${measures.replayedDeliveries ?? 436} adapted replays, 0 duplicates). ${measures.affectedReservations} reservations experienced confirmation delays over 30 seconds.`;
      }
    } else if (effectiveInterventionAtTick === 'act-rollback-producer-only') {
      severity = 'elevated';
      customerImpactBanner = `Partial recovery — New reservations now confirm on time after producer rollback, but ${measures.confirmationBacklog} previously queued messages remain unconfirmed and continue failing validation.`;
    } else {
      severity = 'critical';
      customerImpactBanner = `Unresolved impact — Workers restarted onto the same validator while incompatible producer events continue; ${measures.confirmationBacklog} confirmations remain stalled (${measures.validationErrorAttempts ?? 0} validation failures / 60s).`;
    }
  } else {
    if (clampedTime < 140) {
      severity = 'normal';
    } else if (clampedTime < CHECKPOINT_TIMES.alert) {
      severity = 'elevated';
      customerImpactBanner =
        'Early degradation — Tail reservation attempts are beginning to time out while DB connections climb.';
    } else if (clampedTime <= CHECKPOINT_TIMES.evidence) {
      severity = 'critical';
      customerImpactBanner = `Active incident — ${(measures.reservationErrorRate * 100).toFixed(1)}% of reservation attempts in the last 60s failed; ${measures.affectedReservations} unique reservations impacted so far.`;
    } else if (effectiveInterventionAtTick === 'act-rollback-drain') {
      if (clampedTime < 450) {
        severity = 'recovering';
        customerImpactBanner =
          'Mitigation in progress — Rolling back to v2.13.4 and draining affected pods to release stranded DB connections.';
      } else {
        severity = 'resolved';
        customerImpactBanner = `Service recovered — Pool stabilized at ${measures.activeDbConnections}/${measures.maxDbConnections} connections; trailing 60s error rate is ${(measures.reservationErrorRate * 100).toFixed(1)}%.`;
      }
    } else if (effectiveInterventionAtTick === 'act-increase-pool') {
      if (clampedTime <= 480) {
        severity = 'recovering';
        customerImpactBanner = `Temporary relief — Expanded 200-connection pool is absorbing traffic (${measures.activeDbConnections}/200 in use), but leaked handles are still climbing.`;
      } else {
        severity = 'critical';
        customerImpactBanner = `Renewed saturation — Leaked handles exhausted the 200-connection ceiling (${measures.activeDbConnections}/200); ${(measures.reservationErrorRate * 100).toFixed(1)}% of attempts failing.`;
      }
    } else {
      severity = 'critical';
      customerImpactBanner = `Unresolved outage — Connection pool remains pinned at ${measures.activeDbConnections}/${measures.maxDbConnections}; ${measures.affectedReservations} unique reservations impacted.`;
    }
  }

  return {
    incidentId: scenario.incidentId,
    symptomTitle: scenario.symptomTitle,
    scenarioVersion: scenario.scenarioVersion,
    engineVersion: ENGINE_VERSION,
    seed,
    simTimeSeconds: clampedTime,
    formattedTime: formatSimTime(clampedTime),
    activeCheckpoint,
    reachedCheckpoints,
    awaitingInterventionDecision,
    selectedInterventionId: effectiveInterventionAtTick,
    selectedInterventionAppliedAt:
      effectiveInterventionAtTick !== null ? CHECKPOINT_TIMES.evidence : null,
    severity,
    customerImpactBanner,
    measures,
    timelineSeries,
    services: buildServiceStatuses(
      scenario,
      measures,
      clampedTime,
      effectiveInterventionAtTick,
    ),
    visibleEvidence,
    availableInterventions,
  };
}
