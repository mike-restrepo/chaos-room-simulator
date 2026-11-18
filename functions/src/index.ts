import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  ALLOWED_ORIGINS,
  BACKEND_LIMITS,
  DEFAULT_MOCK_MODEL_VERSION,
  GEMINI_API_KEY_SECRET_NAME,
  MOCK_PRICING_FIXTURE_V1,
} from './config.js';
import {
  assertSafeLiveExecutionEnvironment,
  assertSafeLocalExecutionEnvironment,
  resolveRuntimeMode,
} from './emulatorGuard.js';
import { GeminiModelProvider } from './geminiProvider.js';
import { MockModelProvider } from './mockProvider.js';
import { RequestValidationError } from './requestValidator.js';
import { executeAnalyzeIncident } from './service.js';
import type {
  AnalyzeIncidentResponse,
  CallableAuthContext,
  ModelProvider,
  PricingFixture,
} from './types.js';

const geminiApiKeySecret = defineSecret(GEMINI_API_KEY_SECRET_NAME);

let cachedDb: Firestore | null = null;
const mockProvider = new MockModelProvider();

function getFirestoreForProject(projectId: string): Firestore {
  if (!cachedDb) {
    const app =
      getApps().find((a) => a.name === '[DEFAULT]') ?? initializeApp({ projectId });
    cachedDb = getFirestore(app);
  }
  return cachedDb;
}

export interface ResolvedCallableRuntime {
  mode: 'emulator_mock' | 'live_gemini';
  db: Firestore;
  provider: ModelProvider;
  modelVersion: string;
  pricing: PricingFixture;
  allowedOrigins: string[];
}

function resolveCallableRuntime(): ResolvedCallableRuntime {
  const mode = resolveRuntimeMode(process.env);
  if (mode === 'emulator_mock') {
    const { projectId } = assertSafeLocalExecutionEnvironment(process.env, {
      requireEmulatorHost: true,
    });
    return {
      mode,
      db: getFirestoreForProject(projectId),
      provider: mockProvider,
      modelVersion: DEFAULT_MOCK_MODEL_VERSION,
      pricing: MOCK_PRICING_FIXTURE_V1,
      allowedOrigins: ALLOWED_ORIGINS,
    };
  }

  let secretValue = '';
  try {
    secretValue = geminiApiKeySecret.value();
  } catch {
    secretValue = process.env[GEMINI_API_KEY_SECRET_NAME] ?? '';
  }

  const liveEnv = assertSafeLiveExecutionEnvironment(process.env, {
    secretApiKey: secretValue,
  });

  return {
    mode,
    db: getFirestoreForProject(liveEnv.projectId),
    provider: new GeminiModelProvider({ apiKey: liveEnv.apiKey }),
    modelVersion: liveEnv.modelVersion,
    pricing: liveEnv.pricing,
    allowedOrigins: liveEnv.allowedOrigins,
  };
}

function mapValidationErrorToHttpsError(error: RequestValidationError): HttpsError {
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return new HttpsError('unauthenticated', error.message);
    case 'APP_CHECK_REQUIRED':
    case 'CREDENTIALS_IN_PAYLOAD':
      return new HttpsError('failed-precondition', error.message);
    case 'REQUEST_ID_CONFLICT':
      return new HttpsError('already-exists', error.message);
    default:
      return new HttpsError('invalid-argument', error.message);
  }
}

/**
 * Second-generation Firebase callable entrypoint for controlled incident analysis.
 * Defaults to local `emulator_mock` mode (`MockModelProvider` + `demo-*` Firestore emulator).
 * Live Gemini mode requires explicit runtime opt-in flags plus Secret Manager `GEMINI_API_KEY`.
 */
export const analyzeIncident = onCall(
  {
    region: 'us-central1',
    timeoutSeconds: BACKEND_LIMITS.functionTimeoutSeconds,
    memory: '256MiB',
    maxInstances: 10,
    enforceAppCheck: true,
    cors: ALLOWED_ORIGINS,
    secrets: [geminiApiKeySecret],
  },
  async (request): Promise<AnalyzeIncidentResponse> => {
    try {
      const runtime = resolveCallableRuntime();
      const requestOrigin = request.rawRequest?.headers?.origin;
      if (
        runtime.mode === 'live_gemini' &&
        typeof requestOrigin === 'string' &&
        !runtime.allowedOrigins.includes(requestOrigin)
      ) {
        throw new HttpsError('permission-denied', 'Origin is not permitted for live analysis.');
      }

      const context: CallableAuthContext = {
        auth: request.auth
          ? {
              uid: request.auth.uid,
              token: request.auth.token as unknown as Record<string, unknown>,
            }
          : null,
        app: request.app
          ? {
              appId: request.app.appId,
              alreadyConsumed: request.app.alreadyConsumed,
            }
          : null,
      };
      return await executeAnalyzeIncident(request.data, context, {
        db: runtime.db,
        provider: runtime.provider,
        pricing: runtime.pricing,
        modelVersion: runtime.modelVersion,
      });
    } catch (error) {
      console.error('analyzeIncident handler caught error:', error);
      if (
        error instanceof HttpsError ||
        (typeof error === 'object' && error !== null && 'httpErrorCode' in error)
      ) {
        throw error;
      }
      if (
        error instanceof RequestValidationError ||
        (typeof error === 'object' && error !== null && (error as Error).name === 'RequestValidationError')
      ) {
        throw mapValidationErrorToHttpsError(error as RequestValidationError);
      }
      throw new HttpsError('internal', 'Internal error during incident analysis.');
    }
  },
);
