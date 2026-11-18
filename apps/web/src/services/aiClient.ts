import {
  ENGINE_VERSION,
  validateAnalysisResult,
  type AnalysisResult,
  type AnalyzeIncidentResponse,
  type AnalyzeIncidentStatus,
  type CheckpointId,
  type PublicAnalyzeRequest,
  type Snapshot,
} from '@chaos-room/shared';

export const DEFAULT_CLIENT_ANALYSIS_DEADLINE_MS = 28_000;

export const VALID_ANALYSIS_STATUSES: Set<AnalyzeIncidentStatus> = new Set([
  'ok',
  'cached',
  'pending',
  'quota_reached',
  'disabled',
  'version_mismatch',
  'timeout',
  'invalid_output',
  'unavailable',
]);

export interface FirebaseClientConfig {
  apiKey: string;
  projectId: string;
  appId: string;
  authDomain?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  functionsRegion?: string;
  recaptchaSiteKey?: string;
}

export interface AnalyzeIncidentTransport {
  readonly transportName: string;
  analyzeIncident(
    request: PublicAnalyzeRequest,
    abortSignal?: AbortSignal,
  ): Promise<AnalyzeIncidentResponse>;
}

export interface MockTransportScenario {
  status?: AnalyzeIncidentStatus;
  cacheHit?: boolean;
  isMockProvider?: boolean;
  result?: AnalysisResult;
  reasonCode?: string;
  message?: string;
  retryAfterMs?: number;
  expectedScenarioVersion?: string;
  expectedEngineVersion?: string;
  simulatedDelayMs?: number;
  throwTransportError?: Error;
  ignoreAbortSignal?: boolean;
}

/**
 * Injectable mock transport for local UI verification and testing.
 * Supports configurable delay, errors, ignoreAbortSignal, and dynamic response generation.
 */
export class MockAnalyzeIncidentTransport implements AnalyzeIncidentTransport {
  readonly transportName = 'mock_transport';
  private scenarioHandler: (
    request: PublicAnalyzeRequest,
  ) => MockTransportScenario | Promise<MockTransportScenario>;

  constructor(
    handlerOrScenario:
      | MockTransportScenario
      | ((request: PublicAnalyzeRequest) => MockTransportScenario | Promise<MockTransportScenario>) = {},
  ) {
    if (typeof handlerOrScenario === 'function') {
      this.scenarioHandler = handlerOrScenario;
    } else {
      this.scenarioHandler = () => handlerOrScenario;
    }
  }

  setScenario(
    handlerOrScenario:
      | MockTransportScenario
      | ((request: PublicAnalyzeRequest) => MockTransportScenario | Promise<MockTransportScenario>),
  ): void {
    if (typeof handlerOrScenario === 'function') {
      this.scenarioHandler = handlerOrScenario;
    } else {
      this.scenarioHandler = () => handlerOrScenario;
    }
  }

  async analyzeIncident(
    request: PublicAnalyzeRequest,
    abortSignal?: AbortSignal,
  ): Promise<AnalyzeIncidentResponse> {
    const scenario = await this.scenarioHandler(request);

    if (scenario.simulatedDelayMs && scenario.simulatedDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, scenario.simulatedDelayMs);
        if (abortSignal && !scenario.ignoreAbortSignal) {
          abortSignal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Request aborted', 'AbortError'));
          });
        }
      });
    }

    if (abortSignal?.aborted && !scenario.ignoreAbortSignal) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    if (scenario.throwTransportError) {
      throw scenario.throwTransportError;
    }

    const status = scenario.status ?? 'ok';
    const serverTimeIso = new Date().toISOString();

    return {
      status,
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: scenario.cacheHit ?? (status === 'cached'),
      isMockProvider: scenario.isMockProvider ?? true,
      cacheKey: `mock|${request.incidentId}|${request.checkpoint}|${request.selectedInterventionId ?? 'none'}`,
      result: scenario.result,
      reasonCode: scenario.reasonCode,
      message:
        scenario.message ??
        (status === 'ok'
          ? 'Generated mocked AI analysis.'
          : status === 'cached'
            ? 'Retrieved mocked AI analysis from shared cache.'
            : `Mock response with status: ${status}`),
      retryAfterMs: scenario.retryAfterMs,
      expectedScenarioVersion: scenario.expectedScenarioVersion ?? request.scenarioVersion,
      expectedEngineVersion: scenario.expectedEngineVersion ?? ENGINE_VERSION,
      serverTimeIso,
    };
  }
}

/**
 * Offline transport used when no Firebase configuration or live transport is supplied.
 * Guarantees zero unhandled network exceptions and completely offline operation.
 */
export class OfflineUnconfiguredTransport implements AnalyzeIncidentTransport {
  readonly transportName = 'offline_unconfigured';

  async analyzeIncident(
    request: PublicAnalyzeRequest,
    _abortSignal?: AbortSignal,
  ): Promise<AnalyzeIncidentResponse> {
    return {
      status: 'disabled',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'unconfigured_offline',
      message:
        'AI backend connection is not configured in this environment. Deterministic authored walkthrough is active.',
      serverTimeIso: new Date().toISOString(),
    };
  }
}

export interface FirebaseSdkModules {
  initializeApp: (options: Record<string, unknown>, name?: string) => unknown;
  getApps: () => Array<{ name: string; options: Record<string, unknown> }>;
  getAuth: (app: unknown) => { currentUser: { uid: string } | null };
  signInAnonymously: (auth: unknown) => Promise<{ user: { uid: string } }>;
  initializeAppCheck: (app: unknown, options: unknown) => unknown;
  ReCaptchaEnterpriseProvider: new (siteKey: string) => unknown;
  getFunctions: (app: unknown, region: string) => unknown;
  httpsCallable: (
    functions: unknown,
    name: string,
  ) => (data: unknown) => Promise<{ data: unknown }>;
}

export const CHAOS_FIREBASE_APP_NAME = '[CHAOS_ROOM]';

export interface TransportTimingEntry {
  transportInvocationId: number;
  requestId: string;
  isFirstTransportCall: boolean;
  sdkImportMs: number;
  authAppCheckMs: number;
  callableAndTokenExecutionMs: number;
  isColdSdk: boolean;
  isColdAuth: boolean;
  stageNotes: {
    sdkImport: 'observable';
    authAppCheck: 'observable_aggregate (individual reCAPTCHA risk evaluation iframe is internal to SDK)';
    callableAndTokenExecution: 'observable (includes SDK token readiness and HTTPS callable roundtrip)';
  };
}

/**
 * Live Firebase Callable transport for analyzeIncident.
 * Supports anonymous Auth, App Check with reCAPTCHA Enterprise, and callable functions.
 * Validates configuration, handles concurrent initialization safely, and avoids swallowing errors.
 */
export class FirebaseCallableTransport implements AnalyzeIncidentTransport {
  readonly transportName = 'firebase_callable';
  private config: FirebaseClientConfig;
  private sdkLoader?: () => Promise<FirebaseSdkModules>;
  private initPromise: Promise<(request: PublicAnalyzeRequest) => Promise<AnalyzeIncidentResponse>> | null = null;
  private hasCompletedFirstCall = false;
  private transportInvocationCounter = 0;
  private timingsByInvocationId = new Map<number, TransportTimingEntry>();
  private timingsByRequestId = new Map<string, TransportTimingEntry[]>();
  private lastTiming: TransportTimingEntry | null = null;
  private initialSdkImportMs: number = 0;
  private initialAuthAppCheckMs: number = 0;
  private initialWasColdAuth: boolean = false;

  constructor(config: FirebaseClientConfig, sdkLoader?: () => Promise<FirebaseSdkModules>) {
    this.config = config;
    this.sdkLoader = sdkLoader;
  }

  public getTimingForInvocation(invocationId: number): TransportTimingEntry | null {
    return this.timingsByInvocationId.get(invocationId) ?? null;
  }

  public getTimingForRequest(requestId: string): TransportTimingEntry | null {
    const list = this.timingsByRequestId.get(requestId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  }

  public getAllTimingsForRequest(requestId: string): TransportTimingEntry[] {
    return [...(this.timingsByRequestId.get(requestId) ?? [])];
  }

  public getLastTiming(): TransportTimingEntry | null {
    return this.lastTiming;
  }

  private async loadSdk(): Promise<FirebaseSdkModules> {
    if (this.sdkLoader) {
      return this.sdkLoader();
    }
    const [appMod, authMod, appCheckMod, functionsMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/app-check'),
      import('firebase/functions'),
    ]);
    return {
      initializeApp: appMod.initializeApp as unknown as FirebaseSdkModules['initializeApp'],
      getApps: appMod.getApps as unknown as FirebaseSdkModules['getApps'],
      getAuth: authMod.getAuth as unknown as FirebaseSdkModules['getAuth'],
      signInAnonymously: authMod.signInAnonymously as unknown as FirebaseSdkModules['signInAnonymously'],
      initializeAppCheck: appCheckMod.initializeAppCheck as unknown as FirebaseSdkModules['initializeAppCheck'],
      ReCaptchaEnterpriseProvider: appCheckMod.ReCaptchaEnterpriseProvider as unknown as FirebaseSdkModules['ReCaptchaEnterpriseProvider'],
      getFunctions: functionsMod.getFunctions as unknown as FirebaseSdkModules['getFunctions'],
      httpsCallable: functionsMod.httpsCallable as unknown as FirebaseSdkModules['httpsCallable'],
    };
  }

  private getCallableRunner(): Promise<(request: PublicAnalyzeRequest) => Promise<AnalyzeIncidentResponse>> {
    if (!this.initPromise) {
      const runnerPromise = (async () => {
        // Enforce required live configuration
        if (!this.config.projectId?.trim()) {
          throw new Error('Firebase configuration missing required projectId');
        }
        if (!this.config.apiKey?.trim()) {
          throw new Error('Firebase configuration missing required apiKey');
        }
        if (!this.config.appId?.trim()) {
          throw new Error('Firebase configuration missing required appId');
        }
        if (!this.config.recaptchaSiteKey?.trim()) {
          throw new Error(
            'App Check reCAPTCHA Enterprise site key (recaptchaSiteKey) is required for live Firebase mode.',
          );
        }

        const tSdk0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const sdk = await this.loadSdk();
        const tSdk1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.initialSdkImportMs = Math.max(0, tSdk1 - tSdk0);

        const existingApps = sdk.getApps();

        // Check for specific named app or matching default app
        let app = existingApps.find((a) => a.name === CHAOS_FIREBASE_APP_NAME);
        if (app) {
          if (
            app.options.projectId !== this.config.projectId ||
            app.options.appId !== this.config.appId ||
            app.options.apiKey !== this.config.apiKey
          ) {
            throw new Error(
              `Existing Firebase app "${CHAOS_FIREBASE_APP_NAME}" configuration does not match expected credentials.`,
            );
          }
        } else {
          app = sdk.initializeApp(
            {
              apiKey: this.config.apiKey,
              projectId: this.config.projectId,
              appId: this.config.appId,
              authDomain: this.config.authDomain,
              storageBucket: this.config.storageBucket,
              messagingSenderId: this.config.messagingSenderId,
            },
            CHAOS_FIREBASE_APP_NAME,
          ) as { name: string; options: Record<string, unknown> };
        }

        const tAuth0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Initialize App Check; do not swallow real errors
        try {
          sdk.initializeAppCheck(app, {
            provider: new sdk.ReCaptchaEnterpriseProvider(this.config.recaptchaSiteKey),
            isTokenAutoRefreshEnabled: true,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // Only permit the error if App Check was already registered for this app instance
          if (!msg.toLowerCase().includes('already') && !msg.toLowerCase().includes('duplicate')) {
            throw new Error(`App Check initialization failed: ${msg}`);
          }
        }

        // Ensure anonymous auth session
        const auth = sdk.getAuth(app);
        this.initialWasColdAuth = !auth.currentUser;
        if (!auth.currentUser) {
          await sdk.signInAnonymously(auth);
        }
        const tAuth1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.initialAuthAppCheckMs = Math.max(0, tAuth1 - tAuth0);

        const region = this.config.functionsRegion ?? 'us-central1';
        const functions = sdk.getFunctions(app, region);
        const callable = sdk.httpsCallable(functions, 'analyzeIncident');

        return async (req: PublicAnalyzeRequest): Promise<AnalyzeIncidentResponse> => {
          const transportInvocationId = ++this.transportInvocationCounter;
          const isFirstCall = !this.hasCompletedFirstCall;
          this.hasCompletedFirstCall = true;

          const tCall0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
          let res: { data: unknown };
          try {
            res = await callable(req);
          } finally {
            const tCall1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const callDuration = Math.max(0, tCall1 - tCall0);

            const entry: TransportTimingEntry = {
              transportInvocationId,
              requestId: req.requestId,
              isFirstTransportCall: isFirstCall,
              sdkImportMs: isFirstCall ? this.initialSdkImportMs : 0,
              authAppCheckMs: isFirstCall ? this.initialAuthAppCheckMs : 0,
              callableAndTokenExecutionMs: callDuration,
              isColdSdk: isFirstCall && this.initialSdkImportMs > 0,
              isColdAuth: isFirstCall && this.initialWasColdAuth,
              stageNotes: {
                sdkImport: 'observable',
                authAppCheck: 'observable_aggregate (individual reCAPTCHA risk evaluation iframe is internal to SDK)',
                callableAndTokenExecution: 'observable (includes SDK token readiness and HTTPS callable roundtrip)',
              },
            };

            this.timingsByInvocationId.set(transportInvocationId, entry);
            const existingList = this.timingsByRequestId.get(req.requestId) ?? [];
            existingList.push(entry);
            this.timingsByRequestId.set(req.requestId, existingList);
            this.lastTiming = entry;
          }

          return res.data as AnalyzeIncidentResponse;
        };
      })();

      // Clear initPromise on failure so future deliberate retries can initialize again
      runnerPromise.catch(() => {
        if (this.initPromise === runnerPromise) {
          this.initPromise = null;
        }
      });

      this.initPromise = runnerPromise;
    }
    return this.initPromise;
  }

  async analyzeIncident(
    request: PublicAnalyzeRequest,
    abortSignal?: AbortSignal,
  ): Promise<AnalyzeIncidentResponse> {
    if (abortSignal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    let runner: (req: PublicAnalyzeRequest) => Promise<AnalyzeIncidentResponse>;
    try {
      runner = await this.getCallableRunner();
    } catch (initErr: unknown) {
      return mapFirebaseErrorToResponse(
        initErr instanceof Error
          ? new Error(`Firebase SDK initialization failed: ${initErr.message}`)
          : new Error(`Firebase SDK initialization failed: ${String(initErr)}`),
        request,
      );
    }

    try {
      if (abortSignal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      return await runner(request);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      return mapFirebaseErrorToResponse(err, request);
    }
  }
}

function mapFirebaseErrorToResponse(
  error: unknown,
  request: PublicAnalyzeRequest,
): AnalyzeIncidentResponse {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : 'Unknown communication error';
  const serverTimeIso = new Date().toISOString();

  if (code.includes('unauthenticated') || message.toLowerCase().includes('auth')) {
    return {
      status: 'unavailable',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'auth_failure',
      message: `Authentication failed: ${message}`,
      serverTimeIso,
    };
  }

  if (
    message.toLowerCase().includes('recaptchasitekey') ||
    message.toLowerCase().includes('app check recaptcha enterprise site key')
  ) {
    return {
      status: 'unavailable',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'app_check_required',
      message: `App Check configuration required: ${message}`,
      serverTimeIso,
    };
  }

  if (
    code.includes('permission-denied') ||
    code.includes('app-check') ||
    message.toLowerCase().includes('app check') ||
    message.toLowerCase().includes('recaptcha')
  ) {
    return {
      status: 'unavailable',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'app_check_failure',
      message: `App Check or authorization rejected the request: ${message}`,
      serverTimeIso,
    };
  }

  if (
    message.toLowerCase().includes('initialization') ||
    message.toLowerCase().includes('dynamic import') ||
    message.toLowerCase().includes('sdk init')
  ) {
    return {
      status: 'unavailable',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'initialization_failure',
      message: `Firebase SDK initialization failed: ${message}`,
      serverTimeIso,
    };
  }

  if (code.includes('resource-exhausted')) {
    return {
      status: 'quota_reached',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'quota_exhausted',
      message: `AI generation limit reached: ${message}`,
      serverTimeIso,
    };
  }

  if (code.includes('deadline-exceeded')) {
    return {
      status: 'timeout',
      incidentId: request.incidentId,
      checkpoint: request.checkpoint,
      selectedInterventionId: request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: false,
      reasonCode: 'server_deadline_exceeded',
      message: 'AI request timed out waiting for server response.',
      serverTimeIso,
    };
  }

  return {
    status: 'unavailable',
    incidentId: request.incidentId,
    checkpoint: request.checkpoint,
    selectedInterventionId: request.selectedInterventionId,
    cacheHit: false,
    isMockProvider: false,
    reasonCode: 'transport_error',
    message: `Network or service communication failed: ${message}`,
    serverTimeIso,
  };
}

/**
 * Computes the unique local canonical identity string for a simulation state.
 * Strictly includes engineVersion alongside incidentId, scenarioVersion, checkpoint, and canonical intervention.
 */
export function computeCanonicalStateKey(
  incidentId: string,
  scenarioVersion: string,
  engineVersion: string,
  checkpoint: CheckpointId,
  selectedInterventionId: string | null,
): string {
  // Alert and evidence canonical requests are strictly branch-free
  const effectiveIntervention =
    checkpoint === 'alert' || checkpoint === 'evidence' ? null : selectedInterventionId;
  return `${incidentId}@${scenarioVersion}@${engineVersion}|${checkpoint}|${effectiveIntervention ?? 'none'}`;
}

export function buildPublicAnalyzeRequest(params: {
  incidentId: string;
  scenarioVersion: string;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
  requestId: string;
  engineVersion?: string;
}): PublicAnalyzeRequest {
  const { incidentId, scenarioVersion, checkpoint, selectedInterventionId, requestId, engineVersion } =
    params;
  // Enforce contract: Alert and Evidence cannot specify selectedInterventionId
  const effectiveIntervention =
    checkpoint === 'alert' || checkpoint === 'evidence' ? null : selectedInterventionId;

  return {
    incidentId,
    scenarioVersion,
    engineVersion: engineVersion ?? ENGINE_VERSION,
    checkpoint,
    selectedInterventionId: effectiveIntervention,
    requestId,
  };
}

export interface ExpectedCanonicalState {
  incidentId: string;
  scenarioVersion: string;
  engineVersion: string;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
}

/**
 * Determines whether a backend response status represents a confirmed terminal outcome
 * under the existing backend contract.
 *
 * Ambiguous outcomes (timeout, client_deadline_exceeded, transport/network disconnects)
 * must preserve the existing requestId so the visitor can recover the original request.
 */
export function isConfirmedTerminalBackendStatus(
  response: AnalyzeIncidentResponse | null | undefined,
): boolean {
  if (!response) return false;
  if (
    response.status === 'disabled' ||
    response.status === 'quota_reached' ||
    response.status === 'invalid_output' ||
    response.status === 'version_mismatch'
  ) {
    return true;
  }
  if (response.status === 'unavailable') {
    // Ambiguous network/transport failures where server completion is unknown are NOT terminal
    const isAmbiguousTransport =
      response.reasonCode === 'transport_error' ||
      response.reasonCode === 'transport_failure' ||
      response.reasonCode === 'initialization_failure';
    return !isAmbiguousTransport;
  }
  // status: 'timeout' (client deadline, callable deadline, provider deadline) is AMBIGUOUS
  // status: 'pending' (server lease active) is AMBIGUOUS / UNRESOLVED
  return false;
}

/**
 * Validates an unknown runtime response against the canonical state expectation and snapshot.
 * Treats all incoming data as untrusted, verifying envelope shape, status, required fields,
 * nested result identity, and citation membership.
 */
export function validateUnknownResponse(
  raw: unknown,
  expected: ExpectedCanonicalState,
  snapshot: Snapshot,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ['Response must be a non-null object'] };
  }

  const obj = raw as Record<string, unknown>;

  // Validate status
  if (typeof obj.status !== 'string' || !VALID_ANALYSIS_STATUSES.has(obj.status as AnalyzeIncidentStatus)) {
    errors.push(`Invalid or unsupported response status "${String(obj.status)}"`);
  }

  // Validate top-level identity fields
  if (obj.incidentId !== expected.incidentId) {
    errors.push(`Response incidentId "${String(obj.incidentId)}" does not match expected "${expected.incidentId}"`);
  }

  if (obj.checkpoint !== expected.checkpoint) {
    errors.push(`Response checkpoint "${String(obj.checkpoint)}" does not match expected "${expected.checkpoint}"`);
  }

  // Canonical intervention rules
  if (expected.checkpoint === 'alert' || expected.checkpoint === 'evidence') {
    if (obj.selectedInterventionId !== null && obj.selectedInterventionId !== undefined) {
      errors.push(`Response for ${expected.checkpoint} must have null selectedInterventionId`);
    }
  } else if (expected.checkpoint === 'outcome') {
    if (obj.selectedInterventionId !== expected.selectedInterventionId) {
      errors.push(
        `Response outcome selectedInterventionId "${String(obj.selectedInterventionId)}" does not match expected "${expected.selectedInterventionId}"`,
      );
    }
  }

  if (typeof obj.message !== 'string') {
    errors.push('Response message must be a string');
  }

  if (typeof obj.cacheHit !== 'boolean') {
    errors.push('Response cacheHit must be a boolean');
  }

  if (typeof obj.isMockProvider !== 'boolean') {
    errors.push('Response isMockProvider must be a boolean');
  }

  if (typeof obj.serverTimeIso !== 'string' || isNaN(Date.parse(obj.serverTimeIso))) {
    errors.push('Response serverTimeIso must be a valid ISO date string');
  }

  if (obj.retryAfterMs !== undefined) {
    if (typeof obj.retryAfterMs !== 'number' || obj.retryAfterMs < 0 || isNaN(obj.retryAfterMs)) {
      errors.push('Response retryAfterMs must be a non-negative number');
    }
  }

  // Validate success/result consistency
  const isSuccessStatus = obj.status === 'ok' || obj.status === 'cached';
  if (isSuccessStatus) {
    if (typeof obj.result !== 'object' || obj.result === null || Array.isArray(obj.result)) {
      errors.push(`Response with status "${obj.status}" must include a valid result object`);
    } else {
      const res = obj.result as Record<string, unknown>;

      if (res.incidentId !== expected.incidentId) {
        errors.push(`Nested result.incidentId "${String(res.incidentId)}" does not match expected "${expected.incidentId}"`);
      }

      if (res.checkpoint !== expected.checkpoint) {
        errors.push(`Nested result.checkpoint "${String(res.checkpoint)}" does not match expected "${expected.checkpoint}"`);
      }

      if (res.scenarioVersion !== expected.scenarioVersion) {
        errors.push(`Nested result.scenarioVersion "${String(res.scenarioVersion)}" does not match expected "${expected.scenarioVersion}"`);
      }

      if (expected.checkpoint === 'alert' || expected.checkpoint === 'evidence') {
        if (res.selectedInterventionId !== null && res.selectedInterventionId !== undefined) {
          errors.push(`Nested result.selectedInterventionId for ${expected.checkpoint} must be null`);
        }
      } else if (expected.checkpoint === 'outcome') {
        if (res.selectedInterventionId !== expected.selectedInterventionId) {
          errors.push(`Nested result.selectedInterventionId does not match expected "${expected.selectedInterventionId}"`);
        }
      }

      // Validate every field consumed by the renderer before calling shared validator:
      // 1. conciseAssessment
      if (typeof res.conciseAssessment !== 'string' || res.conciseAssessment.trim().length === 0) {
        errors.push('result.conciseAssessment must be a non-empty string');
      }

      // 2. confidence ({ level: 'Low' | 'Medium' | 'High', justification: string })
      if (typeof res.confidence !== 'object' || res.confidence === null || Array.isArray(res.confidence)) {
        errors.push('result.confidence must be an object with level and justification');
      } else {
        const conf = res.confidence as Record<string, unknown>;
        if (typeof conf.level !== 'string' || !['Low', 'Medium', 'High'].includes(conf.level)) {
          errors.push('result.confidence.level must be "Low", "Medium", or "High"');
        }
        if (typeof conf.justification !== 'string' || conf.justification.trim().length === 0) {
          errors.push('result.confidence.justification must be a non-empty string');
        }
      }

      // 3. observedFacts (array of { text: string, citationIds: string[] })
      if (!Array.isArray(res.observedFacts)) {
        errors.push('result.observedFacts must be an array');
      } else {
        for (let i = 0; i < res.observedFacts.length; i++) {
          const fact = res.observedFacts[i];
          if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
            errors.push(`result.observedFacts[${i}] must be an object`);
          } else {
            const factObj = fact as Record<string, unknown>;
            if (typeof factObj.text !== 'string' || factObj.text.trim().length === 0) {
              errors.push(`result.observedFacts[${i}].text must be a non-empty string`);
            }
            if (!Array.isArray(factObj.citationIds)) {
              errors.push(`result.observedFacts[${i}].citationIds must be an array`);
            } else {
              for (let j = 0; j < factObj.citationIds.length; j++) {
                if (typeof factObj.citationIds[j] !== 'string') {
                  errors.push(`result.observedFacts[${i}].citationIds[${j}] must be a string`);
                }
              }
            }
          }
        }
      }

      // 4. rankedHypotheses (array of { rank: number, statement: string, likelihood: string, supportingCitationIds: string[] })
      if (!Array.isArray(res.rankedHypotheses)) {
        errors.push('result.rankedHypotheses must be an array');
      } else {
        for (let i = 0; i < res.rankedHypotheses.length; i++) {
          const hyp = res.rankedHypotheses[i];
          if (typeof hyp !== 'object' || hyp === null || Array.isArray(hyp)) {
            errors.push(`result.rankedHypotheses[${i}] must be an object`);
          } else {
            const hypObj = hyp as Record<string, unknown>;
            if (typeof hypObj.rank !== 'number') {
              errors.push(`result.rankedHypotheses[${i}].rank must be a number`);
            }
            if (typeof hypObj.statement !== 'string' || hypObj.statement.trim().length === 0) {
              errors.push(`result.rankedHypotheses[${i}].statement must be a non-empty string`);
            }
            if (
              typeof hypObj.likelihood !== 'string' ||
              !['Primary', 'Plausible alternative', 'Unlikely'].includes(hypObj.likelihood)
            ) {
              errors.push(
                `result.rankedHypotheses[${i}].likelihood must be "Primary", "Plausible alternative", or "Unlikely"`,
              );
            }
            if (!Array.isArray(hypObj.supportingCitationIds)) {
              errors.push(`result.rankedHypotheses[${i}].supportingCitationIds must be an array`);
            } else {
              for (let j = 0; j < hypObj.supportingCitationIds.length; j++) {
                if (typeof hypObj.supportingCitationIds[j] !== 'string') {
                  errors.push(`result.rankedHypotheses[${i}].supportingCitationIds[${j}] must be a string`);
                }
              }
            }
          }
        }
      }

      // 5. verificationChecks (array of strings)
      if (!Array.isArray(res.verificationChecks)) {
        errors.push('result.verificationChecks must be an array');
      } else {
        for (let i = 0; i < res.verificationChecks.length; i++) {
          if (typeof res.verificationChecks[i] !== 'string') {
            errors.push(`result.verificationChecks[${i}] must be a string`);
          }
        }
      }

      // 6. recommendedInterventions (array of { interventionId: string, rationale: string, keyRisk: string })
      if (!Array.isArray(res.recommendedInterventions)) {
        errors.push('result.recommendedInterventions must be an array');
      } else {
        for (let i = 0; i < res.recommendedInterventions.length; i++) {
          const rec = res.recommendedInterventions[i];
          if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
            errors.push(`result.recommendedInterventions[${i}] must be an object`);
          } else {
            const recObj = rec as Record<string, unknown>;
            if (typeof recObj.interventionId !== 'string') {
              errors.push(`result.recommendedInterventions[${i}].interventionId must be a string`);
            }
            if (typeof recObj.rationale !== 'string') {
              errors.push(`result.recommendedInterventions[${i}].rationale must be a string`);
            }
            if (typeof recObj.keyRisk !== 'string') {
              errors.push(`result.recommendedInterventions[${i}].keyRisk must be a string`);
            }
          }
        }
      }

      // 7. alternativeExplanations (array of { explanation: string, whyLessLikely: string, citationIds: string[] })
      if (!Array.isArray(res.alternativeExplanations)) {
        errors.push('result.alternativeExplanations must be an array');
      } else {
        for (let i = 0; i < res.alternativeExplanations.length; i++) {
          const alt = res.alternativeExplanations[i];
          if (typeof alt !== 'object' || alt === null || Array.isArray(alt)) {
            errors.push(`result.alternativeExplanations[${i}] must be an object`);
          } else {
            const altObj = alt as Record<string, unknown>;
            if (typeof altObj.explanation !== 'string') {
              errors.push(`result.alternativeExplanations[${i}].explanation must be a string`);
            }
            if (typeof altObj.whyLessLikely !== 'string') {
              errors.push(`result.alternativeExplanations[${i}].whyLessLikely must be a string`);
            }
            if (!Array.isArray(altObj.citationIds)) {
              errors.push(`result.alternativeExplanations[${i}].citationIds must be an array`);
            }
          }
        }
      }

      // 8. missingInformation (array of strings)
      if (!Array.isArray(res.missingInformation)) {
        errors.push('result.missingInformation must be an array');
      } else {
        for (let i = 0; i < res.missingInformation.length; i++) {
          if (typeof res.missingInformation[i] !== 'string') {
            errors.push(`result.missingInformation[${i}] must be a string`);
          }
        }
      }

      // 9. stakeholderUpdate (string)
      if (typeof res.stakeholderUpdate !== 'string') {
        errors.push('result.stakeholderUpdate must be a string');
      }

      // 10. provenance & metadata fields consumed by UI headers/banners
      if (typeof res.sourceBadgeLabel !== 'string' || res.sourceBadgeLabel.trim().length === 0) {
        errors.push('result.sourceBadgeLabel must be a non-empty string');
      }
      if (typeof res.isPreviewMock !== 'boolean') {
        errors.push('result.isPreviewMock must be a boolean');
      }
      if (typeof res.sourceMode !== 'string' || res.sourceMode.trim().length === 0) {
        errors.push('result.sourceMode must be a non-empty string');
      }
      if (typeof res.modelVersion !== 'string') {
        errors.push('result.modelVersion must be a string');
      }
      if (typeof res.promptVersion !== 'string') {
        errors.push('result.promptVersion must be a string');
      }
      if (typeof res.generatedAtIso !== 'string' || isNaN(Date.parse(res.generatedAtIso))) {
        errors.push('result.generatedAtIso must be a valid ISO date string');
      }

      // ONLY invoke typed shared validator if the essential structure and types are valid,
      // preventing unhandled TypeErrors (e.g. .trim() on undefined)
      if (errors.length === 0) {
        const citationValidation = validateAnalysisResult(res as unknown as AnalysisResult, snapshot);
        if (!citationValidation.valid) {
          errors.push(...citationValidation.errors);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Normalizes an unknown response into an AnalyzeIncidentResponse.
 * If validation fails, produces an honest invalid_output fallback response without throwing.
 */
export function normalizeValidatedResponse(
  raw: unknown,
  expected: ExpectedCanonicalState,
  snapshot: Snapshot,
): AnalyzeIncidentResponse {
  const validation = validateUnknownResponse(raw, expected, snapshot);
  if (validation.valid) {
    return raw as AnalyzeIncidentResponse;
  }

  return {
    status: 'invalid_output',
    incidentId: expected.incidentId,
    checkpoint: expected.checkpoint,
    selectedInterventionId:
      expected.checkpoint === 'outcome' ? expected.selectedInterventionId : null,
    cacheHit: false,
    isMockProvider: false,
    reasonCode: 'client_validation_failed',
    message: `Malformed or mismatched AI response rejected: ${validation.errors.join('; ')}`,
    result: undefined,
    serverTimeIso: new Date().toISOString(),
  };
}
