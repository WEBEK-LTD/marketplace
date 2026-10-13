'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { ListingImageVariant, ListingMediaItem } from '@repo/contracts';
import { Badge, Button, FOCUS_RING, TYPE, cx } from '@repo/ui';

/**
 * The photographs of one listing, managed by whoever may manage them (increment 0116).
 *
 * **The resizing happens here, in the browser, by owner decision.** A canvas draws each of the three served
 * sizes and encodes it as WebP, so the platform needs no image pipeline, no worker and no new dependency.
 * Four objects go up per photograph — the seller's original, and the three sizes a page actually uses.
 *
 * **A canvas keeps pixels and nothing else, which is why the owner chose it.** A re-encoded image carries no
 * EXIF, so the location a phone wrote into a photograph does not reach a public bucket. But it is *this code*
 * that drops it, and a server cannot see what a caller uploaded to its own signed target — so
 * `listing_media.metadata_stripped_at` is never set, here or anywhere. The honest claim is the one the
 * database can stand behind, and it cannot stand behind this one.
 *
 * **The original is uploaded untouched, to a private bucket.** `listing-originals` is not publicly readable
 * and nothing in this product serves from it; it exists so a better variant can be generated later without
 * asking a seller to re-upload. It therefore *does* still carry its metadata, and that is a deliberate
 * trade recorded in migration 0114 rather than a gap.
 *
 * **Four objects, one photograph, or nothing.** The server authorizes four, the browser uploads four, and the
 * confirmation records four in one transaction. A failure at any step leaves no row — the worst case is
 * uploaded objects nothing points at, which costs storage and misleads nobody.
 *
 * **Nothing here decides who may do this.** The screen is rendered for a listing the page already resolved,
 * and every one of the four requests is refused by the server for a listing the caller may not manage.
 */

/* ------------------------------------------------------------------------------------------------ */

/**
 * The three served widths, and how they are derived rather than fixed.
 *
 * `listing_media_attach` requires the three widths to be distinct and ascending, which a fixed 320/800/1600
 * cannot promise: a 600-pixel-wide photograph would produce 320/600/600 and be refused. So each size is
 * derived from the one above it, capped by the source, and the smallest useful source is stated outright —
 * a photograph narrower than this is not a photograph of a property, and saying so is kinder than three
 * identical thumbnails.
 */
const MIN_SOURCE_WIDTH = 400;

function widthsFor(sourceWidth: number): readonly [number, number, number] {
  const full = Math.min(1600, sourceWidth);
  const card = Math.min(800, Math.floor((full * 2) / 3));
  const thumb = Math.min(320, Math.floor((card * 2) / 5));
  return [thumb, card, full];
}

/** The five types `listing-originals` admits. The picker offers exactly these. */
const ACCEPTED = 'image/jpeg,image/png,image/webp,image/avif,image/heic';
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic']);
const MAX_ORIGINAL_BYTES = 26_214_400;

export interface ListingPhotoCopy {
  readonly heading: string;
  readonly intro: string;
  readonly add: string;
  readonly working: string;
  readonly none: string;
  readonly primary: string;
  readonly makePrimary: string;
  readonly remove: string;
  readonly unpublished: string;
  readonly wrongType: string;
  readonly tooLarge: string;
  readonly tooSmall: string;
  readonly failed: string;
  readonly unsupported: string;
  readonly photoNumber: (input: { number: number; total: number }) => string;
}

type Phase = 'idle' | 'working' | 'error';

/* ------------------------------------------------------------------------------------------------ */

/** One decoded bitmap of the chosen file, at a size a canvas can draw from. */
async function decode(file: File): Promise<{ width: number; height: number; draw: CanvasImageSource }> {
  // `createImageBitmap` where it exists: it decodes off the main thread and handles orientation, which an
  // `<img>` does not do consistently. The `<img>` path is the fallback, not the preference.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, draw: bitmap };
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('the file could not be decoded'));
      element.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight, draw: image };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One size, drawn and encoded. Null when the browser cannot produce WebP. */
async function encodeAt(
  source: { width: number; height: number; draw: CanvasImageSource },
  width: number,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const height = Math.max(1, Math.round((source.height / source.width) * width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (context === null) return null;
  // Smoothing on, and high: a downscale without it aliases badly on exactly the kind of detail a building
  // photograph is full of.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source.draw, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/webp', 0.82);
  });
  // A browser that cannot encode WebP hands back a PNG under the name it was asked for, or nothing at all.
  // Either way this is not the file the database was told to expect, so it is a refusal rather than a guess.
  if (blob === null || blob.type !== 'image/webp' || blob.size <= 0) return null;
  return { blob, width, height };
}

/* ------------------------------------------------------------------------------------------------ */

export function ListingPhotoManager({
  slug,
  initial,
  copy,
}: {
  readonly slug: string;
  readonly initial: readonly ListingMediaItem[];
  readonly copy: ListingPhotoCopy;
}) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<readonly ListingMediaItem[]>(initial);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const base = `/api/listings/${encodeURIComponent(slug)}/media`;

  function fail(text: string): void {
    setPhase('error');
    setMessage(text);
  }

  async function add(file: File): Promise<void> {
    // Checked here so somebody is told before they wait for an upload — never instead of the server
    // checking, which it does twice more and independently.
    if (!ACCEPTED_TYPES.has(file.type)) {
      fail(copy.wrongType);
      return;
    }
    if (file.size <= 0 || file.size > MAX_ORIGINAL_BYTES) {
      fail(copy.tooLarge);
      return;
    }

    setPhase('working');
    setMessage(null);

    // The three sizes, drawn and encoded before anything is authorized: a browser that cannot do this at all
    // should find out before the server issues four credentials.
    let sizes: readonly { key: 'thumb' | 'card' | 'full'; blob: Blob; width: number; height: number }[];
    // The original's own dimensions, kept from the one decode: the database stores them for the original
    // row, and decoding a 25 MiB file twice to learn the same two numbers would be work for nothing.
    let original: { width: number; height: number };
    try {
      const source = await decode(file);
      original = { width: source.width, height: source.height };
      if (source.width < MIN_SOURCE_WIDTH) {
        fail(copy.tooSmall);
        return;
      }
      const [thumb, card, full] = widthsFor(source.width);
      const encoded = await Promise.all([
        encodeAt(source, thumb),
        encodeAt(source, card),
        encodeAt(source, full),
      ]);
      if (encoded.some((entry) => entry === null)) {
        fail(copy.unsupported);
        return;
      }
      sizes = (['thumb', 'card', 'full'] as const).map((key, index) => ({
        key,
        ...encoded[index]!,
      }));
    } catch {
      fail(copy.failed);
      return;
    }

    // Step one: the four destinations. The request describes the files and names no path.
    let targets: readonly { variantKey: string; uploadUrl: string; objectPath: string }[];
    try {
      const response = await fetch(`${base}/uploads`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          variants: [
            { variantKey: 'original', contentType: file.type, byteSize: file.size },
            ...sizes.map((size) => ({
              variantKey: size.key,
              contentType: 'image/webp',
              byteSize: size.blob.size,
            })),
          ],
        }),
      });
      if (!response.ok) {
        fail(copy.failed);
        return;
      }
      const body = (await response.json()) as { targets?: unknown };
      if (!Array.isArray(body.targets) || body.targets.length !== 4) {
        fail(copy.failed);
        return;
      }
      targets = body.targets as typeof targets;
    } catch {
      fail(copy.failed);
      return;
    }

    // Step two: the bytes, each to the URL the server named. The only requests here that leave this origin.
    const byKey = new Map<string, { blob: Blob; type: string; width: number; height: number }>([
      ['original', { blob: file, type: file.type, width: 0, height: 0 }],
      ...sizes.map(
        (size) =>
          [size.key, { blob: size.blob, type: 'image/webp', width: size.width, height: size.height }] as const,
      ),
    ]);

    try {
      for (const target of targets) {
        const payload = byKey.get(target.variantKey);
        if (payload === undefined) {
          fail(copy.failed);
          return;
        }
        const uploaded = await fetch(target.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': payload.type },
          body: payload.blob,
        });
        // No row exists yet, so stopping here is safe and retrying changes nothing.
        if (!uploaded.ok) {
          fail(copy.failed);
          return;
        }
      }
    } catch {
      fail(copy.failed);
      return;
    }

    // Step three: the confirmation. The server checks all four objects arrived before it writes.
    //
    // The original carries the source's own dimensions; the three served sizes carry the dimensions this
    // code actually drew.
    try {
      const response = await fetch(base, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          variants: targets.map((target) => {
            const payload = byKey.get(target.variantKey)!;
            const isOriginal = target.variantKey === 'original';
            return {
              variantKey: target.variantKey,
              objectPath: target.objectPath,
              width: isOriginal ? original.width : payload.width,
              height: isOriginal ? original.height : payload.height,
              byteSize: payload.blob.size,
            };
          }),
        }),
      });
      if (!response.ok) {
        fail(copy.failed);
        return;
      }
      const body = (await response.json()) as { items?: unknown };
      if (!Array.isArray(body.items)) {
        fail(copy.failed);
        return;
      }
      setItems(body.items as readonly ListingMediaItem[]);
      setPhase('idle');
      // The listing's own page shows these too, so its cached copy is now out of date.
      router.refresh();
    } catch {
      fail(copy.failed);
    }
  }

  /** The two one-click operations. Both answer with the list as it now stands, so nothing is guessed. */
  async function change(method: 'PUT' | 'DELETE', mediaId: string): Promise<void> {
    if (phase === 'working') return;
    setPhase('working');
    setMessage(null);
    try {
      const url = method === 'PUT' ? `${base}/${mediaId}/primary` : `${base}/${mediaId}`;
      const response = await fetch(url, { method, credentials: 'same-origin' });
      if (!response.ok) {
        fail(copy.failed);
        return;
      }
      const body = (await response.json()) as { items?: unknown };
      if (!Array.isArray(body.items)) {
        fail(copy.failed);
        return;
      }
      setItems(body.items as readonly ListingMediaItem[]);
      setPhase('idle');
      router.refresh();
    } catch {
      fail(copy.failed);
    }
  }

  const working = phase === 'working';

  return (
    <section className="space-y-4">
      <div>
        <h2 className={TYPE.h3}>{copy.heading}</h2>
        <p className={cx('mt-1 max-w-prose', TYPE.meta)}>{copy.intro}</p>
      </div>

      {items.length === 0 ? (
        <p className={TYPE.meta}>{copy.none}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex flex-col overflow-hidden rounded-xl border border-hairline bg-surface-sunken"
            >
              <div className="relative aspect-[4/3] w-full bg-surface-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored variant; see `ListingPhoto`. */}
                <img
                  alt={copy.photoNumber({ number: index + 1, total: items.length })}
                  className="h-full w-full object-cover"
                  decoding="async"
                  loading="lazy"
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  src={smallestOf(item.variants)?.url ?? ''}
                />
              </div>

              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {item.isPrimary ? <Badge tone="solid">{copy.primary}</Badge> : null}
                  {item.isPublished ? null : <Badge tone="outline">{copy.unpublished}</Badge>}
                </div>

                <div className="mt-auto flex flex-wrap gap-2">
                  {item.isPrimary ? null : (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void change('PUT', item.id)}
                      className={cx(
                        'rounded-md border border-edge px-2 py-1 text-xs font-medium text-ink-strong disabled:opacity-60',
                        FOCUS_RING,
                      )}
                    >
                      {copy.makePrimary}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => void change('DELETE', item.id)}
                    className={cx(
                      'rounded-md border border-edge px-2 py-1 text-xs font-medium text-ink-strong disabled:opacity-60',
                      FOCUS_RING,
                    )}
                  >
                    {copy.remove}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={picker}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared before the work, so choosing the same file twice in a row still fires a change.
            event.target.value = '';
            if (file !== undefined) void add(file);
          }}
        />
        <Button type="button" variant="secondary" disabled={working} onClick={() => picker.current?.click()}>
          {working ? copy.working : copy.add}
        </Button>
        {message === null ? null : (
          <span role="alert" className={TYPE.metaSmall}>
            {message}
          </span>
        )}
      </div>
    </section>
  );
}

/** The thumbnail, for a grid of management tiles. The variants arrive smallest first; this does not assume it. */
function smallestOf(variants: readonly ListingImageVariant[]): ListingImageVariant | undefined {
  return [...variants].sort((a, b) => a.width - b.width)[0];
}
