declare module '*/gal-async-read.mjs' {
  export const GAL_ASYNC_READ_DESCRIPTORS: Readonly<Record<string, Readonly<{
    id: string;
    version: number;
    argv: readonly string[];
    timeoutMs: number;
  }>>>;

  export function executeGalAsyncRead(
    id: string,
    cwd: string,
    options: {
      runner: (
        args: string[],
        options: { cwd: string; timeout: number; signal?: AbortSignal }
      ) => Promise<{ status: number | null; stdout: Buffer; failure: string | null }>;
      signal?: AbortSignal;
    }
  ): Promise<{ ok: true; value: string } | { ok: false; code: string }>;
}
