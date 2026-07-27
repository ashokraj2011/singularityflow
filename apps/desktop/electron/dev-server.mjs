const DEFAULT_DESKTOP_PORT = 5173;

export function desktopDevServerOptions(env = process.env) {
  const configured = String(env.SINGULARITY_FLOW_DESKTOP_PORT ?? '').trim();
  const explicit = configured.length > 0;
  const port = Number.parseInt(explicit ? configured : String(DEFAULT_DESKTOP_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SINGULARITY_FLOW_DESKTOP_PORT must be a valid TCP port.');
  }
  return {
    host: '127.0.0.1',
    port,
    // An explicitly selected port is a contract (and is useful in CI). For the normal local
    // command, let Vite advance to the next free port so an abandoned dev window cannot prevent
    // another checkout from opening.
    strictPort: explicit
  };
}

export function listeningDesktopPort(server, requestedPort) {
  const address = server.httpServer?.address();
  return typeof address === 'object' && address && Number.isInteger(address.port)
    ? address.port
    : requestedPort;
}
