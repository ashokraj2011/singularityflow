type ExplainerIcon = 'capability' | 'collection' | 'impact' | 'refresh' | 'search' | 'skill' | 'visual' | 'workflow';
export const CX_STYLE: string;
export const CODE_EXPLAINER_SCRIPT: string;
export const CODE_EXPLAINER_RUNTIME: string;
export function codeExplainerMarkup(icon: (name: ExplainerIcon, options: { size: 14 }) => string, escapedNonce?: string | null): string;
