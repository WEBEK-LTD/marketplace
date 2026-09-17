/**
 * Next.js instrumentation hook, Node.js runtime only. Reads only NEXT_RUNTIME, which Next.js sets.
 * 1. Validates the server configuration (owner decision R4-B). If it is invalid, Next.js 16 logs the error
 *    (variable names only) and answers every request with HTTP 500; the local `start` script's preflight
 *    stops earlier with exit code 1.
 * 2. Registers the tracer provider so that Next.js built-in spans are created (O8-11): no export, no
 *    propagator, strict attribute allowlist with URLs reduced to their path.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateServerConfigAtStartup } = await import('./server/config');
    validateServerConfigAtStartup();
    const { initTelemetry } = await import('@repo/telemetry');
    initTelemetry({ serviceName: 'admin' });
  }
}
