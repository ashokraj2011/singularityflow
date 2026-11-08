export interface ArtifactTemplateVariables { readonly id?: string; readonly title?: string;
  readonly workType?: string; readonly inputs?: string }
export interface ArtifactTemplatePhase { readonly id: string; readonly label?: string }
export declare const ARTIFACT_TEMPLATE_TOKENS: Readonly<{ workId: '{{work.id}}'; workTitle: '{{work.title}}';
  workType: '{{work.type}}'; phaseId: '{{phase.id}}'; phaseLabel: '{{phase.label}}'; inputs: '{{inputs}}' }>;
export declare function normalizeArtifactTemplateCompatibility(text: string, variables: ArtifactTemplateVariables): string;
export declare function validateArtifactTemplateText(text: string, variables?: ArtifactTemplateVariables, phaseId?: string): string;
export declare function renderArtifactTemplateText(text: string, phase: ArtifactTemplatePhase, variables: ArtifactTemplateVariables): string;

export interface ArtifactContentContract { readonly path?: string; readonly kind?: string;
  readonly minimumBytes?: number; readonly maximumBytes?: number;
  readonly validation?: { readonly requiredHeadings?: readonly string[]; readonly forbiddenPlaceholders?: readonly string[] } }
export interface ArtifactContentPhase { readonly id: string; readonly status: string; readonly generation: number;
  readonly requiredArtifact: ArtifactContentContract;
  readonly authoringBaseline?: { readonly generation?: number | null; readonly fingerprint?: string | null } | null;
  readonly generationIntent?: { readonly generation: number; readonly status: string } | null }
export interface ArtifactContentObservation { readonly source: string; readonly authored: string;
  readonly structure: object; readonly bytes: number; readonly fingerprintText: string }
export interface ArtifactContentFinding { readonly code: string; readonly category: string; readonly path: string;
  readonly line: number | null; readonly value: string | null; readonly bytes: number;
  readonly minimumBytes?: number | null; readonly maximumBytes?: number; readonly fingerprint?: string }
export declare function artifactBytesAreText(bytes: Uint8Array): boolean;
export declare function artifactContentObservation(text: string): ArtifactContentObservation;
export declare function inspectRequiredArtifactObservation(observation: ArtifactContentObservation, phase: ArtifactContentPhase,
  options: { readonly path?: string; readonly generation?: number | null; readonly placeholders?: boolean;
    readonly minimumBytes?: boolean; readonly fingerprint: `sha256:${string}` }): ArtifactContentFinding[];
export declare function inspectBinaryArtifactSize(byteCount: number, phase: Pick<ArtifactContentPhase, 'requiredArtifact'>,
  options?: { readonly path?: string; readonly minimumBytes?: boolean }): ArtifactContentFinding[];
