import {
  ALL_SCENARIOS,
  ENGINE_VERSION,
  isValidInterventionId,
  type CheckpointId,
  type ScenarioDefinition,
} from '@chaos-room/shared';
import { BACKEND_LIMITS } from './config.js';
import type {
  CallableAuthContext,
  PublicAnalyzeRequest,
  ValidatedCallableAuth,
} from './types.js';

export type ValidationErrorCode =
  | 'UNAUTHENTICATED'
  | 'APP_CHECK_REQUIRED'
  | 'CREDENTIALS_IN_PAYLOAD'
  | 'INVALID_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNKNOWN_FIELD'
  | 'INVALID_SCENARIO'
  | 'INVALID_CHECKPOINT'
  | 'INVALID_INTERVENTION'
  | 'INVALID_REQUEST_ID'
  | 'REQUEST_ID_CONFLICT';

export class RequestValidationError extends Error {
  readonly code: ValidationErrorCode;

  constructor(code: ValidationErrorCode, message: string) {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
    Object.setPrototypeOf(this, RequestValidationError.prototype);
  }
}

const ALLOWED_PUBLIC_KEYS = new Set([
  'incidentId',
  'scenarioVersion',
  'engineVersion',
  'checkpoint',
  'selectedInterventionId',
  'requestId',
]);

const FORBIDDEN_CREDENTIAL_OR_CONTROL_KEYS = new Set([
  'uid',
  'userId',
  'visitorId',
  'auth',
  'token',
  'idToken',
  'appCheck',
  'appCheckToken',
  'apiKey',
  'authorization',
  'credentials',
  'isAdmin',
  'admin',
  'role',
  'evaluation',
  'evaluationMode',
  'bypassCache',
  'forceRefresh',
  'skipQuota',
  'prompt',
  'evidence',
  'visibleEvidence',
  'measures',
  'snapshot',
  'seed',
  'simTimeSeconds',
  'model',
  'modelVersion',
  'promptVersion',
  'schemaVersion',
  'maxTokens',
  'temperature',
]);

const VALID_CHECKPOINTS = new Set<CheckpointId>(['alert', 'evidence', 'outcome']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Enforces Firebase Auth context and App Check context from the verified runtime context
 * and rejects any caller-supplied authorization/credential/control claims inside `rawData`.
 */
export function validateAuthAndAppCheck(
  context: CallableAuthContext | null | undefined,
  rawData: unknown,
): ValidatedCallableAuth {
  if (isPlainObject(rawData)) {
    for (const key of Object.keys(rawData)) {
      if (FORBIDDEN_CREDENTIAL_OR_CONTROL_KEYS.has(key)) {
        throw new RequestValidationError(
          'CREDENTIALS_IN_PAYLOAD',
          `Field "${key}" is forbidden in public request payloads`,
        );
      }
    }
  }

  const uid = context?.auth?.uid;
  if (typeof uid !== 'string' || uid.trim().length === 0 || uid.length > 128) {
    throw new RequestValidationError(
      'UNAUTHENTICATED',
      'Authenticated Firebase context is required',
    );
  }

  const appId = context?.app?.appId;
  if (typeof appId !== 'string' || appId.trim().length === 0 || appId.length > 128) {
    throw new RequestValidationError(
      'APP_CHECK_REQUIRED',
      'Verified App Check context is required',
    );
  }

  return {
    visitorUid: uid.trim(),
    appId: appId.trim(),
  };
}

export type ParsedPublicRequestOutcome =
  | {
      kind: 'valid';
      request: PublicAnalyzeRequest;
      scenario: ScenarioDefinition;
    }
  | {
      kind: 'version_mismatch';
      request: PublicAnalyzeRequest;
      scenario: ScenarioDefinition;
      expectedScenarioVersion: string;
      expectedEngineVersion: string;
    };

/**
 * Validates and bounds public callable input strictly to the 15 canonical states.
 */
export function validatePublicAnalyzeRequest(rawData: unknown): ParsedPublicRequestOutcome {
  if (!isPlainObject(rawData)) {
    throw new RequestValidationError('INVALID_PAYLOAD', 'Request payload must be a plain JSON object');
  }

  let serializedSize = 0;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(rawData), 'utf8');
  } catch {
    throw new RequestValidationError('INVALID_PAYLOAD', 'Request payload must be JSON-serializable');
  }
  if (serializedSize > BACKEND_LIMITS.maxRequestPayloadBytes) {
    throw new RequestValidationError(
      'PAYLOAD_TOO_LARGE',
      `Request payload exceeds ${BACKEND_LIMITS.maxRequestPayloadBytes} bytes`,
    );
  }

  for (const key of Object.keys(rawData)) {
    if (FORBIDDEN_CREDENTIAL_OR_CONTROL_KEYS.has(key)) {
      throw new RequestValidationError(
        'CREDENTIALS_IN_PAYLOAD',
        `Field "${key}" is forbidden in public request payloads`,
      );
    }
    if (!ALLOWED_PUBLIC_KEYS.has(key)) {
      throw new RequestValidationError('UNKNOWN_FIELD', `Unknown request field "${key}"`);
    }
  }

  const {
    incidentId,
    scenarioVersion,
    engineVersion,
    checkpoint,
    selectedInterventionId,
    requestId,
  } = rawData;

  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new RequestValidationError(
      'INVALID_REQUEST_ID',
      'requestId must be an 8-128 character identifier matching [A-Za-z0-9._:-]',
    );
  }

  if (typeof incidentId !== 'string') {
    throw new RequestValidationError('INVALID_SCENARIO', 'incidentId must be a string');
  }
  const scenario = ALL_SCENARIOS.find((item) => item.incidentId === incidentId);
  if (!scenario) {
    throw new RequestValidationError('INVALID_SCENARIO', `Unsupported incidentId "${incidentId}"`);
  }

  if (typeof checkpoint !== 'string' || !VALID_CHECKPOINTS.has(checkpoint as CheckpointId)) {
    throw new RequestValidationError(
      'INVALID_CHECKPOINT',
      `checkpoint must be one of: alert, evidence, outcome`,
    );
  }
  const typedCheckpoint = checkpoint as CheckpointId;

  let normalizedIntervention: string | null = null;
  if (selectedInterventionId !== undefined && selectedInterventionId !== null) {
    if (typeof selectedInterventionId !== 'string' || selectedInterventionId.length > 64) {
      throw new RequestValidationError(
        'INVALID_INTERVENTION',
        'selectedInterventionId must be null or a bounded string',
      );
    }
    normalizedIntervention = selectedInterventionId;
  }

  if (typedCheckpoint === 'alert' || typedCheckpoint === 'evidence') {
    if (normalizedIntervention !== null) {
      throw new RequestValidationError(
        'INVALID_INTERVENTION',
        `Checkpoint "${typedCheckpoint}" requires selectedInterventionId to be null`,
      );
    }
  } else {
    if (!isValidInterventionId(scenario, normalizedIntervention)) {
      throw new RequestValidationError(
        'INVALID_INTERVENTION',
        `Intervention "${String(normalizedIntervention)}" is not valid for scenario "${scenario.incidentId}"`,
      );
    }
  }

  if (typeof scenarioVersion !== 'string' || !VERSION_PATTERN.test(scenarioVersion)) {
    throw new RequestValidationError(
      'INVALID_PAYLOAD',
      'scenarioVersion must be a bounded version string (1-32 chars)',
    );
  }

  let normalizedEngineVersion: string | undefined;
  if (engineVersion !== undefined) {
    if (typeof engineVersion !== 'string' || !VERSION_PATTERN.test(engineVersion)) {
      throw new RequestValidationError(
        'INVALID_PAYLOAD',
        'engineVersion must be a bounded version string (1-32 chars)',
      );
    }
    normalizedEngineVersion = engineVersion;
  }

  const normalizedRequest: PublicAnalyzeRequest = {
    incidentId: scenario.incidentId,
    scenarioVersion,
    ...(normalizedEngineVersion !== undefined ? { engineVersion: normalizedEngineVersion } : {}),
    checkpoint: typedCheckpoint,
    selectedInterventionId: normalizedIntervention,
    requestId,
  };

  if (
    scenarioVersion !== scenario.scenarioVersion ||
    (normalizedEngineVersion !== undefined && normalizedEngineVersion !== ENGINE_VERSION)
  ) {
    return {
      kind: 'version_mismatch',
      request: normalizedRequest,
      scenario,
      expectedScenarioVersion: scenario.scenarioVersion,
      expectedEngineVersion: ENGINE_VERSION,
    };
  }

  return {
    kind: 'valid',
    request: normalizedRequest,
    scenario,
  };
}
