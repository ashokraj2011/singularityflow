/** Types for the import-free XPL2 leaves (vocabulary, reasons, comparison) shared with the CLI engine. */
declare module '*/comprehension/xpl2/vocabulary.mjs' {
  export const XPL2_SUBJECTS: readonly string[];
  export const XPL2_AUDIENCES: readonly string[];
  export const XPL2_RELATIONSHIPS: Readonly<Record<string, Readonly<{
    granularity: string;
    style: string;
    means: string;
    notImplied: string;
  }>>>;
}

declare module '*/comprehension/xpl2/reasons.mjs' {
  export const XPL2_REASONS: Readonly<Record<string, string>>;
  export const XPL2_REASON_CODES: readonly string[];
  export const XPL2_AVAILABILITY: readonly string[];
  export function xpl2Reason(code: string): string;
  export function xpl2ReasonText(code: string): string;
}

declare module '*/comprehension/xpl2/compare.mjs' {
  export const XPL2_COMPARISON_LIMIT: number;
  export const XPL2_COMPARISON_PROJECTION: string;
  type UnitBrief = { unitId: string; path: string; digest: string };
  export function xpl2ComparisonProjection(view: unknown): unknown;
  export function compareXpl2Views(older: unknown, newer: unknown): {
    sameSet: boolean;
    unitsUnavailable: string | null;
    units: { kept: number; added: UnitBrief[]; removed: UnitBrief[]; addedCount: number; removedCount: number } | null;
    sources: { changed: string[]; changedCount: number };
    statements: { older: number; newer: number };
  } | null;
}
