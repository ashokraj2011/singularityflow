import type {Engine} from '../index.mjs';
import type {SourceControlReader} from '../source-control.mjs';
import type {NamespaceSourceRetentionOptions} from './namespace-source-retention.mjs';
export interface NamespaceSourceControlOptions extends NamespaceSourceRetentionOptions {readonly sourceControlReaders?:readonly SourceControlReader[]}
/** Accept or acknowledge observations for the exact retained authored generation; never publish. */
export declare function createNamespaceSourceControlEngine(options:NamespaceSourceControlOptions):Engine;
