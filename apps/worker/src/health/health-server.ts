import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROBLEM_JSON_MEDIA_TYPE, type HealthResponse, type ProblemDetails, type ReadinessResponse } from '@repo/contracts';

export type ReadinessProbe = () => Promise<ReadinessResponse>;

function send(res: ServerResponse, status: number, body: unknown, contentType: string): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/** Internal health server (Node's built-in http). Only GET /health and GET /ready exist. */
export class HealthServer {
  private readonly server: Server;

  constructor(private readonly readiness: ReadinessProbe) {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.keepAliveTimeout = 5_000;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === '/health') {
      const body: HealthResponse = { status: 'ok' };
      send(res, 200, body, 'application/json');
      return;
    }
    if (req.method === 'GET' && path === '/ready') {
      let body: ReadinessResponse;
      try {
        body = await this.readiness();
      } catch {
        body = { status: 'not_ready', checks: [] };
      }
      send(res, body.status === 'ready' ? 200 : 503, body, 'application/json');
      return;
    }
    const problem: ProblemDetails = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'The requested resource was not found.',
      instance: path,
      code: 'NOT_FOUND',
    };
    send(res, 404, problem, PROBLEM_JSON_MEDIA_TYPE);
  }

  listen(host: string, port: number): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
