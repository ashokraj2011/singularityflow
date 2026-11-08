export interface ArtifactTemplateVariables { readonly id?: string; readonly title?: string;
  readonly workType?: string; readonly inputs?: string }
export interface ArtifactTemplatePhase { readonly id: string; readonly label?: string }
export declare const ARTIFACT_TEMPLATE_TOKENS: Readonly<{ workId: '{{work.id}}'; workTitle: '{{work.title}}';
  workType: '{{work.type}}'; phaseId: '{{phase.id}}'; phaseLabel: '{{phase.label}}'; inputs: '{{inputs}}' }>;
export declare function normalizeArtifactTemplateCompatibility(text: string, variables: ArtifactTemplateVariables): string;
export declare function validateArtifactTemplateText(text: string, variables?: ArtifactTemplateVariables, phaseId?: string): string;
export declare function renderArtifactTemplateText(text: string, phase: ArtifactTemplatePhase, variables: ArtifactTemplateVariables): string;
