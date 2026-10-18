/**
 * Whether Copilot Chat is counted for Singularity Flow reports, from its settings and environment.
 * Kept apart from the VS Code module so it is tested without VS Code.
 */
import path from 'node:path';

// Copilot Chat reads these before its settings; any of them means a setup SFlow must not change.
const OTEL_ENVIRONMENT = [
  'COPILOT_OTEL_ENABLED', 'COPILOT_OTEL_FILE_EXPORTER_PATH', 'COPILOT_OTEL_ENDPOINT', 'COPILOT_OTEL_EXPORTER_TYPE',
  'COPILOT_OTEL_CAPTURE_CONTENT', 'OTEL_EXPORTER_OTLP_ENDPOINT'
];

export interface CopilotChatOtelSettings {
  enabled?: unknown;
  outfile?: unknown;
  exporterType?: unknown;
  otlpEndpoint?: unknown;
  captureContent?: unknown;
}

export type CopilotChatCounting = 'on' | 'off' | 'other-setup';

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/**
 * `on` when Copilot Chat writes SFlow's file with content capture off; `other-setup` when anyone
 * configured Copilot Chat's OpenTelemetry otherwise (settings or environment), which SFlow leaves
 * alone; `off` when nothing is configured.
 */
export function copilotChatCounting(
  settings: CopilotChatOtelSettings, env: Record<string, string | undefined>, file: string
): CopilotChatCounting {
  if (settings.enabled === true && typeof settings.outfile === 'string'
      && path.resolve(settings.outfile) === path.resolve(file) && settings.captureContent !== true
      && !given(settings.otlpEndpoint) && (!given(settings.exporterType) || settings.exporterType === 'file')
      && !OTEL_ENVIRONMENT.some((name) => given(env[name]))) return 'on';
  if (OTEL_ENVIRONMENT.some((name) => given(env[name]))
      || [settings.enabled, settings.outfile, settings.exporterType, settings.otlpEndpoint].some(given)
      || settings.captureContent === true) return 'other-setup';
  return 'off';
}
