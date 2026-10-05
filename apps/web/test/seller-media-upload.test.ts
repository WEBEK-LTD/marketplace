import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_ACCEPT,
  authorizeUpload,
  checkChosenFile,
  confirmUpload,
  putBytes,
  runUpload,
} from '../src/components/seller-media-upload';
import { APP_DIR } from './support/next-server.js';

/**
 * The media upload's logic, without a browser (Phase 6-E).
 *
 * The three steps are pure functions over an injected `fetch`, so every decision they make is testable exactly:
 * which files are refused before anything leaves the page, what is sent, which URL the bytes go to, and what is
 * reported back.
 *
 * The properties that matter most here:
 *
 *   * **the browser composes no destination** — the authorization body carries three values and no path, and the
 *     PUT goes only to the URL the server returned;
 *   * **no session travels to storage** — the upload is `credentials: 'omit'`, so no cookie of this site's is
 *     ever attached to a storage request;
 *   * **nothing is reported as uploaded until the server confirms it** — a failed PUT never reaches the
 *     confirmation, so the state a form displays can only come from the server;
 *   * **the signed URL is confined to one call** — asserted against the component source as well as here.
 */

const FILE = { type: 'image/webp', size: 1024 };
const OBJECT_PATH = 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp';
const SIGNED_URL = 'https://provider.invalid/storage/v1/object/upload/sign/seller-media/x?token=signed-token';

const UPLOAD = {
  mediaKind: 'logo',
  uploadUrl: SIGNED_URL,
  objectPath: OBJECT_PATH,
  expiresAt: '2026-09-25T22:00:00.000Z',
  maxByteSize: 5_242_880,
};

interface Call {
  readonly path: string;
  readonly method: string | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly body: string | undefined;
  readonly contentType: string | null;
}

function responder(
  status: number,
  payload: unknown,
  calls: Call[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method,
      credentials: init?.credentials,
      body: typeof init?.body === 'string' ? init.body : undefined,
      contentType: new Headers(init?.headers as HeadersInit).get('content-type'),
    });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const problem = (code: string) => ({
  type: 'about:blank',
  title: 'Refused',
  status: 409,
  detail: 'A sentence the API owns.',
  instance: '/v1/sellers/me/media',
  code,
});

describe('choosing a file', () => {
  it('offers the four types the bucket allows, and no others', () => {
    expect(MEDIA_ACCEPT).toBe('image/jpeg,image/png,image/webp,image/avif');
    expect(MEDIA_ACCEPT).not.toContain('svg');
    expect(MEDIA_ACCEPT).not.toContain('pdf');
    expect(MEDIA_ACCEPT).not.toContain('*');
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])('accepts %s', (type) => {
    const checked = checkChosenFile({ type, size: 1024 });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.contentType).toBe(type);
  });

  it.each(['image/svg+xml', 'application/pdf', 'text/html', 'image/gif', '', 'IMAGE/WEBP'])(
    'refuses %s on type',
    (type) => {
      const checked = checkChosenFile({ type, size: 1024 });
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      expect(checked.reason).toBe('type');
    },
  );

  it('refuses nothing chosen', () => {
    const checked = checkChosenFile(null);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toBe('missing');
  });

  it.each([0, -1, 5_242_881, 1.5, Number.NaN])('refuses a size of %s', (size) => {
    const checked = checkChosenFile({ type: 'image/webp', size });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toBe('size');
  });

  it('accepts exactly the ceiling', () => {
    expect(checkChosenFile({ type: 'image/webp', size: 5_242_880 }).ok).toBe(true);
  });
});

describe('step one: authorizing', () => {
  it('posts the three values to this origin with the session cookie', async () => {
    const calls: Call[] = [];
    const result = await authorizeUpload('logo', FILE, responder(201, { upload: UPLOAD }, calls));

    expect(result.ok).toBe(true);
    expect(calls[0]?.path).toBe('/api/sellers/me/media/uploads');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      mediaKind: 'logo',
      contentType: 'image/webp',
      byteSize: 1024,
    });
  });

  it('sends no path, bucket, slug or file name', async () => {
    const calls: Call[] = [];
    await authorizeUpload('banner', FILE, responder(201, { upload: UPLOAD }, calls));

    const body = JSON.parse(calls[0]?.body ?? '{}');
    for (const absent of ['objectPath', 'bucket', 'slug', 'fileName', 'path', 'userId']) {
      expect(Object.keys(body), absent).not.toContain(absent);
    }
  });

  it('returns only the two values the next steps need', async () => {
    const calls: Call[] = [];
    const result = await authorizeUpload('logo', FILE, responder(201, { upload: UPLOAD }, calls));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.target).sort()).toEqual(['objectPath', 'uploadUrl']);
    expect(result.target.objectPath).toBe(OBJECT_PATH);
    expect(result.target.uploadUrl).toBe(SIGNED_URL);
  });

  it('refuses a file the checks reject without asking the server', async () => {
    const calls: Call[] = [];
    const result = await authorizeUpload(
      'logo',
      { type: 'image/svg+xml', size: 1024 },
      responder(201, { upload: UPLOAD }, calls),
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [403, 'unavailable'],
    [404, 'unavailable'],
    [429, 'unavailable'],
    [500, 'unavailable'],
  ])('reads a %i as %s', async (status, kind) => {
    const calls: Call[] = [];
    const result = await authorizeUpload('logo', FILE, responder(status, problem('ANY'), calls));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome.kind).toBe(kind);
  });

  it('reads a 409 not-editable as its own outcome, and an unknown 409 as unavailable', async () => {
    const calls: Call[] = [];
    const editable = await authorizeUpload(
      'logo',
      FILE,
      responder(409, problem('SELLER_PROFILE_NOT_EDITABLE'), calls),
    );
    expect(editable.ok).toBe(false);
    if (!editable.ok) expect(editable.outcome.kind).toBe('not_editable');

    const unknown = await authorizeUpload('logo', FILE, responder(409, problem('SOMETHING_NEW'), calls));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.outcome.kind).toBe('unavailable');
  });

  it('reads a drifted or unparsable body as unavailable', async () => {
    const calls: Call[] = [];
    for (const payload of [
      'not json',
      { upload: { mediaKind: 'logo' } },
      { upload: { ...UPLOAD, uploadUrl: 'not-a-url' } },
      {},
    ]) {
      const result = await authorizeUpload('logo', FILE, responder(201, payload, calls));
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      if (!result.ok) expect(result.outcome.kind).toBe('unavailable');
    }
  });

  it('reads a network failure as unavailable', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await authorizeUpload('logo', FILE, failing);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.kind).toBe('unavailable');
  });
});

describe('step two: the bytes', () => {
  it('PUTs to the URL it was given, with no credentials attached', async () => {
    const calls: Call[] = [];
    const sent = await putBytes(SIGNED_URL, new ArrayBuffer(8), 'image/webp', responder(200, {}, calls));

    expect(sent).toBe(true);
    expect(calls[0]?.path).toBe(SIGNED_URL);
    expect(calls[0]?.method).toBe('PUT');
    // The signed URL is the authorization; no cookie of this site's may ride along with it.
    expect(calls[0]?.credentials).toBe('omit');
    expect(calls[0]?.contentType).toBe('image/webp');
  });

  it('reports a refused upload as a failure rather than throwing', async () => {
    const calls: Call[] = [];
    expect(await putBytes(SIGNED_URL, new ArrayBuffer(8), 'image/webp', responder(403, {}, calls))).toBe(false);
    expect(await putBytes(SIGNED_URL, new ArrayBuffer(8), 'image/webp', responder(500, {}, calls))).toBe(false);
  });

  it('reports a network failure as a failure', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await putBytes(SIGNED_URL, new ArrayBuffer(8), 'image/webp', failing)).toBe(false);
  });
});

describe('step three: confirming', () => {
  it('posts the kind and the path back to this origin', async () => {
    const calls: Call[] = [];
    const outcome = await confirmUpload(
      'logo',
      OBJECT_PATH,
      responder(200, { media: { hasLogo: true, hasBanner: false } }, calls),
    );

    expect(outcome.kind).toBe('uploaded');
    expect(calls[0]?.path).toBe('/api/sellers/me/media');
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ mediaKind: 'logo', objectPath: OBJECT_PATH });
  });

  it('reports the state the server returned', async () => {
    const calls: Call[] = [];
    const outcome = await confirmUpload(
      'banner',
      OBJECT_PATH,
      responder(200, { media: { hasLogo: false, hasBanner: true } }, calls),
    );

    expect(outcome).toEqual({ kind: 'uploaded', hasLogo: false, hasBanner: true });
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [404, 'unavailable'],
    [500, 'unavailable'],
  ])('reads a %i as %s', async (status, kind) => {
    const calls: Call[] = [];
    expect((await confirmUpload('logo', OBJECT_PATH, responder(status, problem('ANY'), calls))).kind).toBe(kind);
  });

  it('reads a drifted body as unavailable', async () => {
    const calls: Call[] = [];
    for (const payload of ['not json', { media: { hasLogo: true } }, {}]) {
      expect(
        (await confirmUpload('logo', OBJECT_PATH, responder(200, payload, calls))).kind,
        JSON.stringify(payload),
      ).toBe('unavailable');
    }
  });
});

describe('all three together', () => {
  it('authorizes, uploads and confirms, in that order', async () => {
    const origin: Call[] = [];
    const storage: Call[] = [];
    let step = 0;
    const originFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      step += 1;
      origin.push({
        path: String(input),
        method: init?.method,
        credentials: init?.credentials,
        body: typeof init?.body === 'string' ? init.body : undefined,
        contentType: null,
      });
      if (step === 1) {
        return new Response(JSON.stringify({ upload: UPLOAD }), { status: 201 });
      }
      return new Response(JSON.stringify({ media: { hasLogo: true, hasBanner: false } }), { status: 200 });
    }) as typeof fetch;

    const outcome = await runUpload(
      'logo',
      { ...FILE, body: new ArrayBuffer(8) },
      { origin: originFetch, storage: responder(200, {}, storage) },
    );

    expect(outcome).toEqual({ kind: 'uploaded', hasLogo: true, hasBanner: false });
    expect(origin.map((call) => call.path)).toEqual([
      '/api/sellers/me/media/uploads',
      '/api/sellers/me/media',
    ]);
    expect(storage[0]?.path).toBe(SIGNED_URL);
  });

  it('never confirms when the bytes were refused, so nothing is reported as uploaded', async () => {
    const origin: Call[] = [];
    const outcome = await runUpload(
      'logo',
      { ...FILE, body: new ArrayBuffer(8) },
      { origin: responder(201, { upload: UPLOAD }, origin), storage: responder(403, {}, []) },
    );

    expect(outcome.kind).toBe('unavailable');
    // One call only: the authorization. The confirmation was never attempted.
    expect(origin).toHaveLength(1);
  });

  it('never uploads when the authorization was refused', async () => {
    const storage: Call[] = [];
    const outcome = await runUpload(
      'logo',
      { ...FILE, body: new ArrayBuffer(8) },
      {
        origin: responder(409, problem('SELLER_PROFILE_NOT_EDITABLE'), []),
        storage: responder(200, {}, storage),
      },
    );

    expect(outcome.kind).toBe('not_editable');
    expect(storage).toHaveLength(0);
  });

  it('never returns the signed URL to its caller', async () => {
    const outcome = await runUpload(
      'logo',
      { ...FILE, body: new ArrayBuffer(8) },
      { origin: responder(201, { upload: UPLOAD }, []), storage: responder(500, {}, []) },
    );

    expect(JSON.stringify(outcome)).not.toContain('signed-token');
    expect(JSON.stringify(outcome)).not.toContain(SIGNED_URL);
  });
});

describe('the form component itself', () => {
  const source = readFileSync(join(APP_DIR, 'src/components/seller-media-form.tsx'), 'utf8');
  /**
   * The code, with comments removed.
   *
   * The absence assertions below have to read the code and not the prose: a doc comment that says "no cropper,
   * no gallery, no deletion" would otherwise fail a test looking for the absence of exactly those words, which
   * would make the comment unwritable rather than the feature absent.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  it('keeps the signed URL out of the component entirely', () => {
    for (const absent of ['uploadUrl', 'objectPath', 'signUpload', 'putBytes', 'confirmUpload']) {
      expect(source, absent).not.toContain(absent);
    }
    // One entry point, which holds the URL for the duration of one call.
    expect(source).toContain('runUpload');
  });

  it('claims a success only after the confirmation returned', () => {
    expect(source).toMatch(/outcome\.kind === 'uploaded'[\s\S]{0,80}setDone\(true\)/);
    expect(source.match(/setDone\(true\)/g) ?? []).toHaveLength(1);
  });

  it('disables submit while an upload is in flight', () => {
    expect(source).toContain('disabled={pending}');
    expect(source).toContain('{pending ? labels.uploading : labels.upload}');
  });

  it('takes copy and nothing else', () => {
    const labels = /export interface SellerMediaFormLabels \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(labels).not.toBe('');
    const members = labels.match(/readonly \w+: [^;]+;/g) ?? [];
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.endsWith(': string;'))).toBe(true);
  });

  it('accepts only the four allowed types, never a wildcard', () => {
    expect(source).toContain('accept={MEDIA_ACCEPT}');
    expect(source).not.toContain('accept="image/*"');
    expect(source).not.toContain("accept='*'");
  });

  it('names no token, identifier or provider, and no bucket as a value', () => {
    for (const absent of ['userId', 'accessToken', 'supabase', 'createClient']) {
      expect(code.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
    // The bucket name is the database's and the adapter's; it is never a literal in a component. The element
    // ids below happen to start with the same words, which is why this looks for the quoted value.
    expect(code).not.toContain("'seller-media'");
    expect(code).not.toContain('"seller-media"');
    expect(code).not.toContain('bucket');
  });

  it('offers no deletion, no cropping and no gallery', () => {
    for (const absent of ['delete', 'remove', 'crop', 'gallery', 'reorder', 'drag']) {
      expect(code.toLowerCase(), absent).not.toContain(absent);
    }
  });

  it('lays out with logical properties', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/);
  });
});
