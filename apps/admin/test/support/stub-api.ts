import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** One request the BFF made to the API, as the API saw it. */
export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly credential: string | null;
  readonly contentType: string | null;
  readonly body: string;
  readonly cookie: string | null;
}

export type StubReply = (request: SeenRequest, response: ServerResponse) => void;

export interface StubApi {
  readonly baseUrl: string;
  readonly seen: SeenRequest[];
  /** What the stub answers with next. Replaced per test. */
  reply(handler: StubReply): void;
  stop(): Promise<void>;
}

/**
 * A stand-in for the NestJS API, so the BFF route can be exercised end to end over real HTTP without
 * a database, Redis or Supabase. It records what the API was actually sent — which is how the tests
 * prove the internal credential travelled and the browser's request never went anywhere else.
 */
export async function startStubApi(): Promise<StubApi> {
  const seen: SeenRequest[] = [];
  let handler: StubReply = (_request, response) => {
    response.writeHead(500).end();
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const record: SeenRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        credential: headerOf(request, 'x-internal-credential'),
        contentType: headerOf(request, 'content-type'),
        body: Buffer.concat(chunks).toString('utf8'),
        cookie: headerOf(request, 'cookie'),
      };
      seen.push(record);
      handler(record, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub API did not bind a port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seen,
    reply(next: StubReply) {
      handler = next;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/** Answers with an RFC 9457 problem, exactly as the API renders one. */
export function problem(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(
    JSON.stringify({
      type: 'about:blank',
      title: 'Error',
      status,
      detail: status === 401 ? 'Authentication failed.' : 'The request could not be processed.',
      instance: '/v1/auth/login',
      code,
    }),
  );
}
