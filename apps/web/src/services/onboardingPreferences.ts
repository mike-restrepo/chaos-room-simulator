export const MISSION_BRIEFING_STORAGE_KEY = 'chaos-room:mission-briefing:v1';
export const MISSION_BRIEFING_PREF_VERSION = 1;

export const GUIDED_TOUR_STORAGE_KEY = 'chaos-room:guided-tour:v1';
export const GUIDED_TOUR_PREF_VERSION = 1;

export interface MissionBriefingPreference {
  version: number;
  dismissed: boolean;
  updatedAtIso?: string;
}

export type GuidedTourStatus = 'dismissed' | 'completed';

export interface GuidedTourPreference {
  version: number;
  status: GuidedTourStatus;
  lastStepId?: string;
  updatedAtIso?: string;
}

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function hasDismissedMissionBriefing(storage?: Storage | null): boolean {
  try {
    const target = resolveStorage(storage);
    if (!target) {
      return false;
    }
    const raw = target.getItem(MISSION_BRIEFING_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw) as Partial<MissionBriefingPreference> | null;
    return (
      Boolean(parsed) &&
      typeof parsed === 'object' &&
      parsed?.version === MISSION_BRIEFING_PREF_VERSION &&
      parsed?.dismissed === true
    );
  } catch {
    return false;
  }
}

export function saveMissionBriefingDismissed(storage?: Storage | null): boolean {
  try {
    const target = resolveStorage(storage);
    if (!target) {
      return false;
    }
    const payload: MissionBriefingPreference = {
      version: MISSION_BRIEFING_PREF_VERSION,
      dismissed: true,
      updatedAtIso: new Date().toISOString(),
    };
    target.setItem(MISSION_BRIEFING_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function getGuidedTourPreference(
  storage?: Storage | null,
): GuidedTourPreference | null {
  try {
    const target = resolveStorage(storage);
    if (!target) {
      return null;
    }
    const raw = target.getItem(GUIDED_TOUR_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<GuidedTourPreference> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== GUIDED_TOUR_PREF_VERSION ||
      (parsed.status !== 'dismissed' && parsed.status !== 'completed')
    ) {
      return null;
    }
    return {
      version: parsed.version,
      status: parsed.status,
      lastStepId: typeof parsed.lastStepId === 'string' ? parsed.lastStepId : undefined,
      updatedAtIso: typeof parsed.updatedAtIso === 'string' ? parsed.updatedAtIso : undefined,
    };
  } catch {
    return null;
  }
}

export function hasDismissedOrCompletedGuidedTour(storage?: Storage | null): boolean {
  return getGuidedTourPreference(storage) !== null;
}

export function saveGuidedTourPreference(
  status: GuidedTourStatus,
  lastStepId?: string,
  storage?: Storage | null,
): boolean {
  try {
    const target = resolveStorage(storage);
    if (!target) {
      return false;
    }
    const payload: GuidedTourPreference = {
      version: GUIDED_TOUR_PREF_VERSION,
      status,
      ...(lastStepId ? { lastStepId } : {}),
      updatedAtIso: new Date().toISOString(),
    };
    target.setItem(GUIDED_TOUR_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
