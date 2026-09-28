/** Types for the two import-free XPL2 vocabulary leaves shared with the CLI engine. */
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
