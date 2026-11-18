import { sha256Hex } from '@chaos-room/shared';

export interface SanitizedLogFields {
  event: string;
  incidentId?: string;
  checkpoint?: string;
  selectedInterventionId?: string | null;
  status?: string;
  reasonCode?: string;
  cacheDocId?: string;
  leaseId?: string;
  visitorUid?: string;
  durationMs?: number;
  chargedMicros?: number;
  isEvaluation?: boolean;
}

/**
 * Emits structured JSON logs containing operational metadata only.
 * Hashes visitor UIDs and never logs raw tokens, credentials, headers,
 * raw request bodies, prompts, or full model responses.
 */
export function logSanitizedEvent(fields: SanitizedLogFields): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event: fields.event,
  };

  if (fields.incidentId !== undefined) entry.incidentId = fields.incidentId;
  if (fields.checkpoint !== undefined) entry.checkpoint = fields.checkpoint;
  if (fields.selectedInterventionId !== undefined) {
    entry.selectedInterventionId = fields.selectedInterventionId;
  }
  if (fields.status !== undefined) entry.status = fields.status;
  if (fields.reasonCode !== undefined) entry.reasonCode = fields.reasonCode;
  if (fields.cacheDocId !== undefined) entry.cacheDocId = fields.cacheDocId;
  if (fields.leaseId !== undefined) entry.leaseId = fields.leaseId;
  if (fields.visitorUid !== undefined) {
    entry.visitorHash = sha256Hex(fields.visitorUid).slice(0, 12);
  }
  if (fields.durationMs !== undefined) entry.durationMs = fields.durationMs;
  if (fields.chargedMicros !== undefined) entry.chargedMicros = fields.chargedMicros;
  if (fields.isEvaluation !== undefined) entry.isEvaluation = fields.isEvaluation;

  console.info(JSON.stringify(entry));
}
