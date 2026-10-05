import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handleAuthorizeMessageAttachment,
  handleMessageAttachmentLink,
  handleRecordMessageAttachment,
} from '../src/server/bff/messaging';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of conversation attachments (0104).
 *
 * What matters at this boundary:
 *
 *   * **the upload request is rebuilt from two fields**, so a page that added a path, a bucket or a filename has
 *     it refused here before the hop;
 *   * **the confirmation's path is forwarded verbatim** — this layer does not build it, normalise it or check it
 *     against a namespace, because the database re-derives it and a weaker second copy here is exactly what
 *     must not exist;
 *   * **no signed URL is ever cached**, and the link route sets `no-store`;
 *   * a cross-site write is refused before the session is read, and an ended session before the hop;
 *   * every upstream status becomes one answer a page can render, and an unexpected one becomes the generic
 *     outage rather than a success.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-attachments-canary-credential-not-real',
});

const SESSION_TOKEN = 'session-token-canary-value-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const ATTACHMENT = '44444444-4444-4444-8444-444444444444';
const OBJECT_PATH = `message-attachments/${CONVERSATION}/${MESSAGE}/55555555-5555-4555-8555-555555555555.png`;

const UPLOAD = {
  upload: {
    uploadUrl: 'https://storage.test/upload/opaque',
    objectPath: OBJECT_PATH,
    expiresAt: '2026-10-04T12:02:00.000Z',
    maxByteSize: 10_485_760,
  },
};

const RECORDED = { attachmentId: ATTACHMENT, attachmentCount: 1 };
const LINK = { url: 'https://storage.test/read/opaque', expiresAt: '2026-10-04T12:10:00.000Z' };

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

const unreachable = (async () => {
  throw new Error('the API is unreachable');
}) as unknown as typeof fetch;

function write(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://web.test/api/messaging/x', {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function read(headers: Record<string, string> = { cookie: COOKIE }): Request {
  return new Request('https://web.test/api/messaging/x', { method: 'GET', headers });
}

const UPLOAD_BODY = { contentType: 'image/png', byteSize: 1000 } as const;
const RECORD_BODY = { objectPath: OBJECT_PATH, contentType: 'image/png', byteSize: 1000 } as const;

/* ------------------------------------------------------------------------------------------------ */

describe('authorizing an upload', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleAuthorizeMessageAttachment(write(UPLOAD_BODY), CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: api(200, UPLOAD, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(UPLOAD);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}/attachments/uploads`,
    );
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  /** The wall this layer owns. A page that invented a destination never reaches the API with one. */
  it('rebuilds the body from the two fields the contract names', async () => {
    const seen: Seen[] = [];
    await handleAuthorizeMessageAttachment(
      write({
        ...UPLOAD_BODY,
        objectPath: '../../etc/passwd',
        bucket: 'listing-variants',
        originalFilename: 'x.png',
        userId: '99999999-9999-4999-8999-999999999999',
      }),
      CONVERSATION,
      MESSAGE,
      { env: ENV, fetch: api(200, UPLOAD, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual({ contentType: 'image/png', byteSize: 1000 });
    expect(seen[0]!.body).not.toContain('etc/passwd');
    expect(seen[0]!.body).not.toContain('listing-variants');
    expect(seen[0]!.body).not.toContain('userId');
  });

  it('refuses a type outside the allowlist, SVG included, before the hop', async () => {
    const seen: Seen[] = [];
    for (const contentType of ['image/svg+xml', 'text/html', 'image/avif', 'IMAGE/PNG']) {
      const response = await handleAuthorizeMessageAttachment(
        write({ contentType, byteSize: 1000 }),
        CONVERSATION,
        MESSAGE,
        { env: ENV, fetch: api(200, UPLOAD, seen) },
      );
      expect(response.status, contentType).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a size over ten mebibytes before the hop', async () => {
    const seen: Seen[] = [];
    const response = await handleAuthorizeMessageAttachment(
      write({ contentType: 'image/png', byteSize: 10_485_761 }),
      CONVERSATION,
      MESSAGE,
      { env: ENV, fetch: api(200, UPLOAD, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('refuses a malformed conversation or message identifier', async () => {
    const seen: Seen[] = [];
    for (const [conversation, message] of [
      ['not-a-uuid', MESSAGE],
      [CONVERSATION, 'not-a-uuid'],
      [undefined, MESSAGE],
      [CONVERSATION, undefined],
    ] as Array<[string | undefined, string | undefined]>) {
      const response = await handleAuthorizeMessageAttachment(write(UPLOAD_BODY), conversation, message, {
        env: ENV,
        fetch: api(200, UPLOAD, seen),
      });
      expect(response.status, `${conversation} ${message}`).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a cross-site write before reading the session', async () => {
    const seen: Seen[] = [];
    const response = await handleAuthorizeMessageAttachment(
      write(UPLOAD_BODY, { origin: 'https://evil.test' }),
      CONVERSATION,
      MESSAGE,
      { env: ENV, fetch: api(200, UPLOAD, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a write with no session, before the hop', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/messaging/x', {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify(UPLOAD_BODY),
    });
    const response = await handleAuthorizeMessageAttachment(request, CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: api(200, UPLOAD, seen),
    });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('forwards the API’s refusal so a thread can say what happened', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [409, 'MESSAGING_BLOCKED'],
      [409, 'MESSAGE_ATTACHMENT_LIMIT_REACHED'],
      [400, 'VALIDATION_FAILED'],
    ] as Array<[number, string]>) {
      const response = await handleAuthorizeMessageAttachment(write(UPLOAD_BODY), CONVERSATION, MESSAGE, {
        env: ENV,
        fetch: api(status, { code, status }),
      });
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
  });

  it('reports an unexpected status and an unreachable API as the generic outage', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleAuthorizeMessageAttachment(write(UPLOAD_BODY), CONVERSATION, MESSAGE, {
        env: ENV,
        fetch: api(status, { code: 'SOMETHING' }),
      });
      expect(response.status, String(status)).toBe(503);
    }
    const down = await handleAuthorizeMessageAttachment(write(UPLOAD_BODY), CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: unreachable,
    });
    expect(down.status).toBe(503);
  });

  it('refuses a drifted authorization rather than forwarding it', async () => {
    for (const payload of [
      { upload: { uploadUrl: 'not-a-url', objectPath: OBJECT_PATH, expiresAt: '2026-10-04T12:02:00.000Z', maxByteSize: 1000 } },
      { upload: { uploadUrl: 'https://storage.test/x', objectPath: OBJECT_PATH, expiresAt: '2026-10-04T12:02:00.000Z', maxByteSize: 1000, token: 'secret' } },
      { upload: {} },
      {},
    ]) {
      const response = await handleAuthorizeMessageAttachment(write(UPLOAD_BODY), CONVERSATION, MESSAGE, {
        env: ENV,
        fetch: api(200, payload),
      });
      expect(response.status, JSON.stringify(payload)).toBe(503);
      expect(await response.text()).not.toContain('secret');
    }
  });
});

describe('confirming an upload', () => {
  it('posts to the confirmation path and answers 201', async () => {
    const seen: Seen[] = [];
    const response = await handleRecordMessageAttachment(write(RECORD_BODY), CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: api(201, RECORDED, seen),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(RECORDED);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}/attachments`,
    );
  });

  /**
   * The path is forwarded exactly as the browser sent it.
   *
   * The database rebuilds the expected prefix from the caller's own rows and refuses anything else; a shape
   * check here would be a second, weaker copy of that, and the weaker one is what somebody would trust.
   */
  it('forwards the path verbatim, without normalising or judging it', async () => {
    const seen: Seen[] = [];
    const foreign = `message-attachments/${CONVERSATION}/66666666-6666-4666-8666-666666666666/x.png`;
    await handleRecordMessageAttachment(
      write({ ...RECORD_BODY, objectPath: foreign }),
      CONVERSATION,
      MESSAGE,
      { env: ENV, fetch: api(201, RECORDED, seen) },
    );
    expect(JSON.parse(seen[0]!.body)['objectPath']).toBe(foreign);
  });

  it('drops a filename the contract does not name', async () => {
    const seen: Seen[] = [];
    await handleRecordMessageAttachment(
      write({ ...RECORD_BODY, originalFilename: 'holiday.png', userId: 'x' }),
      CONVERSATION,
      MESSAGE,
      { env: ENV, fetch: api(201, RECORDED, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual(RECORD_BODY);
    expect(seen[0]!.body).not.toContain('holiday');
  });

  it('refuses an absent or absurdly long path, and a type outside the allowlist', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { contentType: 'image/png', byteSize: 1000 },
      { ...RECORD_BODY, objectPath: 'x'.repeat(513) },
      { ...RECORD_BODY, contentType: 'image/svg+xml' },
      { ...RECORD_BODY, byteSize: 10_485_761 },
    ]) {
      const response = await handleRecordMessageAttachment(write(body), CONVERSATION, MESSAGE, {
        env: ENV,
        fetch: api(201, RECORDED, seen),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a cross-site confirmation', async () => {
    const seen: Seen[] = [];
    const response = await handleRecordMessageAttachment(
      write(RECORD_BODY, { origin: 'https://evil.test' }),
      CONVERSATION,
      MESSAGE,
      { env: ENV, fetch: api(201, RECORDED, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('forwards the missing-object refusal, which is the one a client retries into', async () => {
    const response = await handleRecordMessageAttachment(write(RECORD_BODY), CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: api(409, { code: 'MESSAGE_ATTACHMENT_OBJECT_MISSING', status: 409 }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('MESSAGE_ATTACHMENT_OBJECT_MISSING');
  });

  it('treats a 200 where the contract says 201 as drift, not success', async () => {
    const response = await handleRecordMessageAttachment(write(RECORD_BODY), CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: api(200, RECORDED),
    });
    expect(response.status).toBe(503);
  });

  it('refuses a confirmation answer carrying a path', async () => {
    const response = await handleRecordMessageAttachment(write(RECORD_BODY), CONVERSATION, MESSAGE, {
      env: ENV,
      fetch: api(201, { ...RECORDED, objectPath: OBJECT_PATH }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(OBJECT_PATH);
  });
});

describe('the signed read', () => {
  it('reads the link route with the caller’s token and never forwards the cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleMessageAttachmentLink(read(), CONVERSATION, ATTACHMENT, {
      env: ENV,
      fetch: api(200, LINK, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(LINK);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/attachments/${ATTACHMENT}/link`,
    );
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  /** A signed URL is a short-lived authorization, and a cache is a place it outlives the page that asked. */
  it('is never cached', async () => {
    const response = await handleMessageAttachmentLink(read(), CONVERSATION, ATTACHMENT, {
      env: ENV,
      fetch: api(200, LINK),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('needs no Origin header, because it is a read', async () => {
    const response = await handleMessageAttachmentLink(
      new Request('https://web.test/api/messaging/x', { method: 'GET', headers: { cookie: COOKIE } }),
      CONVERSATION,
      ATTACHMENT,
      { env: ENV, fetch: api(200, LINK) },
    );
    expect(response.status).toBe(200);
  });

  it('refuses a request with no session, before the hop', async () => {
    const seen: Seen[] = [];
    const response = await handleMessageAttachmentLink(read({}), CONVERSATION, ATTACHMENT, {
      env: ENV,
      fetch: api(200, LINK, seen),
    });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses a malformed identifier', async () => {
    const seen: Seen[] = [];
    expect(
      (
        await handleMessageAttachmentLink(read(), 'not-a-uuid', ATTACHMENT, {
          env: ENV,
          fetch: api(200, LINK, seen),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await handleMessageAttachmentLink(read(), CONVERSATION, 'not-a-uuid', {
          env: ENV,
          fetch: api(200, LINK, seen),
        })
      ).status,
    ).toBe(400);
    expect(seen).toEqual([]);
  });

  it('forwards a 404 for an attachment the caller may not see', async () => {
    const response = await handleMessageAttachmentLink(read(), CONVERSATION, ATTACHMENT, {
      env: ENV,
      fetch: api(404, { code: 'NOT_FOUND', status: 404 }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses a drifted link and reports an unreachable API as unavailable', async () => {
    for (const payload of [
      { url: OBJECT_PATH, expiresAt: '2026-10-04T12:10:00.000Z' },
      { url: 'https://storage.test/x', expiresAt: '2026-10-04T12:10:00.000Z', objectPath: OBJECT_PATH },
      {},
    ]) {
      const response = await handleMessageAttachmentLink(read(), CONVERSATION, ATTACHMENT, {
        env: ENV,
        fetch: api(200, payload),
      });
      expect(response.status, JSON.stringify(payload)).toBe(503);
      expect(await response.text()).not.toContain(OBJECT_PATH);
    }

    const down = await handleMessageAttachmentLink(read(), CONVERSATION, ATTACHMENT, {
      env: ENV,
      fetch: unreachable,
    });
    expect(down.status).toBe(503);
  });
});

describe('the module’s own shape', () => {
  const SOURCE = readFileSync(
    join(import.meta.dirname, '..', 'src', 'server', 'bff', 'messaging.ts'),
    'utf8',
  );
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('composes no object path and names no bucket', () => {
    expect(CODE).not.toContain('message-attachments/');
    expect(CODE).not.toContain("'message-attachments'");
  });

  it('logs nothing, because every value passing through names a file or a person', () => {
    expect(CODE).not.toContain('console.');
    expect(CODE).not.toContain('logger');
  });

  it('talks to no storage provider of its own', () => {
    expect(CODE).not.toContain('storage/v1');
    expect(CODE).not.toContain('createClient');
    expect(CODE).not.toContain('SUPABASE');
  });
});
