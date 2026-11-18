import {
  ALLOWED_ORIGINS,
  DEFAULT_LIVE_MODEL_VERSION,
  DEMO_PROJECT_ID,
  LIVE_PRODUCTION_ORIGINS,
  SUPPORTED_LIVE_MODEL_VERSIONS,
  resolvePricingForModel,
} from './config.js';
import type { BackendRuntimeMode, PricingFixture } from './types.js';

export interface LocalGuardOptions {
  requireEmulatorHost?: boolean;
  projectIdOverride?: string;
}

export interface LiveGuardOptions {
  secretApiKey?: string;
  projectIdOverride?: string;
}

/**
 * Resolves explicit backend runtime mode (`emulator_mock` is always the default).
 */
export function resolveRuntimeMode(
  env: Record<string, string | undefined> = process.env,
): BackendRuntimeMode {
  const raw = env.CHAOS_BACKEND_MODE?.trim();
  if (!raw || raw === 'emulator_mock') {
    return 'emulator_mock';
  }
  if (raw === 'live_gemini') {
    return 'live_gemini';
  }
  throw new Error(
    `Unsupported CHAOS_BACKEND_MODE "${raw}". Expected "emulator_mock" or "live_gemini".`,
  );
}

/**
 * Resolves the configured Firebase project ID from standard runtime environment variables.
 */
export function resolveConfiguredProjectId(
  env: Record<string, string | undefined> = process.env,
  explicitProjectId?: string,
): string {
  if (explicitProjectId && explicitProjectId.trim().length > 0) {
    return explicitProjectId.trim();
  }
  if (env.CHAOS_PROJECT_ID && env.CHAOS_PROJECT_ID.trim().length > 0) {
    return env.CHAOS_PROJECT_ID.trim();
  }
  if (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT.trim().length > 0) {
    return env.GOOGLE_CLOUD_PROJECT.trim();
  }
  if (env.GCLOUD_PROJECT && env.GCLOUD_PROJECT.trim().length > 0) {
    return env.GCLOUD_PROJECT.trim();
  }
  if (env.GCP_PROJECT && env.GCP_PROJECT.trim().length > 0) {
    return env.GCP_PROJECT.trim();
  }
  if (env.FIREBASE_CONFIG && env.FIREBASE_CONFIG.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(env.FIREBASE_CONFIG) as { projectId?: unknown };
      if (typeof parsed.projectId === 'string' && parsed.projectId.trim().length > 0) {
        return parsed.projectId.trim();
      }
    } catch {
      // Ignore malformed JSON and fall through to default check
    }
  }
  return DEMO_PROJECT_ID;
}

/**
 * Verifies Phase 3A local-only isolation:
 * - Targets only a `demo-` Firebase project ID.
 * - Requires local Firestore emulator host (`127.0.0.1` or `localhost`) when required.
 * - Refuses to run if production service account credentials or live Gemini API keys are set.
 */
export function assertSafeLocalExecutionEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: LocalGuardOptions = {},
): { projectId: string; firestoreEmulatorHost: string | undefined } {
  const projectId = resolveConfiguredProjectId(env, options.projectIdOverride);
  if (!projectId.startsWith('demo-')) {
    throw new Error(
      `Phase 3A isolation guard: projectId must start with "demo-" (received "${projectId}")`,
    );
  }

  const forbiddenVars = [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_API_KEY',
  ];
  for (const name of forbiddenVars) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      throw new Error(
        `Phase 3A isolation guard: forbidden live credential/secret env var "${name}" is set`,
      );
    }
  }

  const emulatorHost = env.FIRESTORE_EMULATOR_HOST?.trim();
  const requireEmulator = options.requireEmulatorHost ?? true;
  if (requireEmulator) {
    if (!emulatorHost) {
      throw new Error(
        'Phase 3A isolation guard: FIRESTORE_EMULATOR_HOST must be set to a local emulator (e.g. 127.0.0.1:8080)',
      );
    }
    const hostname = emulatorHost.split(':')[0]?.toLowerCase();
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      throw new Error(
        `Phase 3A isolation guard: FIRESTORE_EMULATOR_HOST must point to localhost or 127.0.0.1 (received "${emulatorHost}")`,
      );
    }
  }

  return {
    projectId,
    firestoreEmulatorHost: emulatorHost,
  };
}

/**
 * Verifies deliberate live Gemini execution prerequisites:
 * - Requires explicit `CHAOS_BACKEND_MODE=live_gemini` AND `CHAOS_LIVE_GEMINI_ENABLED=true`.
 * - Rejects `demo-` project IDs and active local emulator env vars.
 * - Requires a bound non-empty Gemini API secret (`GEMINI_API_KEY`).
 * - Validates supported live model ID and verified live pricing configuration.
 */
export function assertSafeLiveExecutionEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: LiveGuardOptions = {},
): {
  projectId: string;
  modelVersion: string;
  pricing: PricingFixture;
  apiKey: string;
  allowedOrigins: string[];
} {
  if (resolveRuntimeMode(env) !== 'live_gemini') {
    throw new Error('Live execution guard: CHAOS_BACKEND_MODE must be "live_gemini"');
  }
  if (env.CHAOS_LIVE_GEMINI_ENABLED !== 'true') {
    throw new Error(
      'Live execution guard: CHAOS_LIVE_GEMINI_ENABLED must be explicitly set to "true"',
    );
  }

  for (const emuVar of [
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_AUTH_EMULATOR_HOST',
    'FUNCTIONS_EMULATOR',
  ]) {
    if (env[emuVar]?.trim()) {
      throw new Error(
        `Live execution guard: local emulator env var "${emuVar}" cannot be active in live_gemini mode`,
      );
    }
  }

  const projectId = resolveConfiguredProjectId(env, options.projectIdOverride);
  if (!projectId || projectId.startsWith('demo-')) {
    throw new Error(
      `Live execution guard: non-demo Firebase projectId is required for live_gemini mode (received "${projectId}")`,
    );
  }

  const apiKey = (options.secretApiKey ?? env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Live execution guard: missing GEMINI_API_KEY secret value');
  }

  const modelVersion = (env.CHAOS_GEMINI_MODEL ?? DEFAULT_LIVE_MODEL_VERSION).trim();
  if (
    !SUPPORTED_LIVE_MODEL_VERSIONS.includes(
      modelVersion as (typeof SUPPORTED_LIVE_MODEL_VERSIONS)[number],
    )
  ) {
    throw new Error(
      `Live execution guard: unsupported model "${modelVersion}". Supported live models: ${SUPPORTED_LIVE_MODEL_VERSIONS.join(', ')}`,
    );
  }

  const pricing = resolvePricingForModel(modelVersion, { allowMockPricing: false });
  const allowedOrigins =
    env.CHAOS_ALLOW_LOCALHOST_ORIGINS === 'true' ? [...ALLOWED_ORIGINS] : [...LIVE_PRODUCTION_ORIGINS];

  return {
    projectId,
    modelVersion,
    pricing,
    apiKey,
    allowedOrigins,
  };
}
