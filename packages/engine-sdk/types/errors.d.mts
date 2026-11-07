export type OutcomeClass = 'REVISION_CONFLICT' | 'OPERATION_ID_REUSE' | 'OUTCOME_UNKNOWN';
export declare const OUTCOME_CLASSES: readonly OutcomeClass[];
export declare const OUTCOME_CLASS_BY_CODE: Readonly<Record<string, OutcomeClass>>;
export declare const OUTCOME_CLASS_BY_STATUS: Readonly<Record<string, OutcomeClass>>;
export declare function outcomeClassOf(input?: { code?: string | null; status?: string | null }): OutcomeClass | null;
export declare class SingularityFlowError extends Error {
  readonly exitCode: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly outcomeClass?: OutcomeClass;
  constructor(message: string, options?: { exitCode?: number; code?: string | null; details?: unknown;
    cause?: unknown; outcomeClass?: OutcomeClass | null });
  toJSON(): { name: string; message: string; exitCode: number; code?: string; outcomeClass?: OutcomeClass; details?: unknown };
}
