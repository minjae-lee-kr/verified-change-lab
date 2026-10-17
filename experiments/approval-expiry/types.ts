import type { CapturedState, OperationReceipt, StatePlan } from '../../src/state-envelope.ts';
import type { Approval, Candidate, Evidence, ProcessResult, Transcript } from '../../src/types.ts';
import type { Event } from './barrier.ts';

export const CASE_IDS = ['expiry-before-final-check', 'expiry-after-final-check'] as const;
export type ExpiryCase = {
  id: (typeof CASE_IDS)[number];
  candidate: Candidate;
  evidence: Evidence;
  approval: Approval;
  receipt: OperationReceipt;
  logicalFresh: number;
  logicalExpired: number;
  initial: CapturedState;
  prepared: Extract<StatePlan, { code: 'PREPARED' }> | null;
  whilePrepared: CapturedState | null;
  final: CapturedState | null;
  process: ProcessResult | null;
  acknowledgement: unknown;
  events: Event[];
  transcript: Transcript;
  executionError: string | null;
};
