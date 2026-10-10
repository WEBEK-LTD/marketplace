/**
 * Deriving a full colour scale from one brand colour.
 *
 * **Why this file exists.** The architecture gives the owner exactly two colour slots (D5), and every earlier
 * increment treated that as a reason the product could not have a colour system — two values cannot carry an
 * interface, so the interface stayed grey. That was the wrong conclusion. Two values can carry an interface
 * perfectly well if the system *derives* from them: eleven steps per slot, generated here, so a tinted surface,
 * a hover state, a border and a solid fill are all the same colour at different lightnesses rather than four
 * values somebody picked. The owner still supplies two hexes. The product still hard-codes none.
 *
 * **Why OKLab.** The obvious way to make a scale is to mix the colour with white and with black in sRGB, and it
 * produces the washed-out, muddy ramps that make an interface look cheap: sRGB is not perceptually uniform, so
 * equal numeric steps are not equal visual steps, and mixing a saturated colour toward white desaturates it
 * unevenly through the middle. OKLab is uniform enough that setting a target lightness and keeping hue and
 * chroma gives steps that *look* evenly spaced. The whole difference between a designed ramp and a generated
 * one is in that paragraph.
 *
 * **Chroma follows a curve, not a constant.** A scale that holds full chroma at every lightness is garish at
 * the pale end and unreadable at the dark end. Chroma peaks around the mid steps — where a colour is used as a
 * fill and wants to be itself — and falls away at both ends, where the colour is a wash behind text or a deep
 * ground beneath it.
 *
 * Everything here is pure arithmetic on numbers. No dependency, no runtime cost worth measuring, and the output
 * is frozen into the token set at build time.
 */

export type ScaleStep = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';

export const SCALE_STEPS: readonly ScaleStep[] = [
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950',
];

/**
 * The lightness each step targets, in OKLab's L (0 = black, 1 = white).
 *
 * Chosen so that `500` lands near the lightness of a saturated brand colour as people usually supply one, `50`
 * is a wash that black text sits on comfortably, and `900`/`950` are grounds that white text sits on
 * comfortably. The gaps widen slightly at the light end because the eye discriminates lightness less there.
 */
const LIGHTNESS: Record<ScaleStep, number> = {
  '50': 0.971,
  '100': 0.936,
  '200': 0.885,
  '300': 0.808,
  '400': 0.709,
  '500': 0.606,
  '600': 0.524,
  '700': 0.447,
  '800': 0.378,
  '900': 0.306,
  '950': 0.227,
};

/** How much of the source colour's chroma each step keeps. Peaks where a colour is used as a fill. */
const CHROMA: Record<ScaleStep, number> = {
  '50': 0.26,
  '100': 0.42,
  '200': 0.62,
  '300': 0.82,
  '400': 0.96,
  '500': 1.0,
  '600': 0.98,
  '700': 0.9,
  '800': 0.8,
  '900': 0.68,
  '950': 0.54,
};

/* ------------------------------------------------------------------------------------------------ */
/* sRGB ↔ OKLab                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** Björn Ottosson's OKLab matrices, as published. */
function hexToOklch(hex: string): Oklch {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255);
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255);
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return { l: okL, c: Math.hypot(okA, okB), h: Math.atan2(okB, okA) };
}

function oklchToRgb({ l: okL, c, h }: Oklch): { r: number; g: number; b: number } {
  const okA = c * Math.cos(h);
  const okB = c * Math.sin(h);

  const l = (okL + 0.3963377774 * okA + 0.2158037573 * okB) ** 3;
  const m = (okL - 0.1055613458 * okA - 0.0638541728 * okB) ** 3;
  const s = (okL - 0.0894841775 * okA - 1.291485548 * okB) ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const inGamut = ({ r, g, b }: { r: number; g: number; b: number }): boolean =>
  r >= -0.0001 && r <= 1.0001 && g >= -0.0001 && g <= 1.0001 && b >= -0.0001 && b <= 1.0001;

/**
 * The colour at this lightness and hue, with chroma reduced until it fits in sRGB.
 *
 * A lightness-and-hue pair can ask for more chroma than the display can show — a vivid yellow at L=0.3 does not
 * exist in sRGB. Clamping the channels instead would shift the hue, which is how a generated ramp ends up with
 * one step that is visibly the wrong colour. Binary-searching the chroma down keeps the hue exact and gives up
 * only saturation, which is the right thing to give up.
 */
function toHex(target: Oklch): string {
  let { c } = target;
  if (!inGamut(oklchToRgb(target))) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToRgb({ ...target, c: mid }))) low = mid;
      else high = mid;
    }
    c = low;
  }
  const { r, g, b } = oklchToRgb({ ...target, c });
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The step whose lightness the given colour sits closest to — the scale's anchor.
 *
 * This is where the owner's own hex belongs in its own ramp. A brand colour is chosen at one particular
 * lightness, and that lightness is part of the choice: `#123B35` is a *dark* emerald and means something
 * different from the same hue at `500`.
 */
function nearestStep(lightness: number): ScaleStep {
  let best = SCALE_STEPS[0] as ScaleStep;
  for (const step of SCALE_STEPS) {
    if (Math.abs(LIGHTNESS[step] - lightness) < Math.abs(LIGHTNESS[best] - lightness)) best = step;
  }
  return best;
}

/**
 * The anchor's lightness, kept inside its neighbours' so the ramp cannot double back.
 *
 * Moving a step to the source's exact lightness is only safe while it stays between the steps either side of
 * it. A brand colour that sits almost exactly on a boundary would otherwise cross one, and a ramp that is not
 * monotonic is a ramp nobody can reason about — the pinned test says so too.
 */
function anchoredLightness(anchor: ScaleStep, lightness: number): number {
  const index = SCALE_STEPS.indexOf(anchor);
  const lighter = index > 0 ? LIGHTNESS[SCALE_STEPS[index - 1] as ScaleStep] : 1;
  const darker = index < SCALE_STEPS.length - 1 ? LIGHTNESS[SCALE_STEPS[index + 1] as ScaleStep] : 0;
  const margin = 0.012;
  return Math.min(lighter - margin, Math.max(darker + margin, lightness));
}

/**
 * Eleven steps from one hex, keeping its hue throughout, with **the hex itself as one of the steps**.
 *
 * **Why the scale is anchored rather than merely derived.** The first version of this function read only the
 * hue and the chroma from the source and imposed its own lightness ladder on both. That had two consequences,
 * and the second is the serious one:
 *
 *   * the owner's colour appeared nowhere in the product. Every step was *related* to it, none of them *was*
 *     it, so the one value the owner actually chose was the one value nobody could see;
 *   * a dark brand produced a washed-out system. Chroma does not mean the same thing at every lightness:
 *     `#123B35`'s chroma of 0.047 reads as a rich emerald at its own lightness of 0.32 and as a grey-green at
 *     0.61, where a fill lives. Taking that number literally and applying it at mid-scale is how a deliberate,
 *     deep brand colour turns into a button nobody can see.
 *
 * So the step nearest the source's own lightness is pinned *to the source*, and the chroma curve is normalised
 * around that step rather than around `500`. The anchor then renders the owner's hex exactly, and every other
 * step carries the intensity that colour implies at its own position on the ramp. A vivid brand still produces
 * a vivid system and a muted one a muted system — what changes is that "muted" now means muted *relative to
 * where the owner put it*, which is what they meant by choosing it there.
 */
export function deriveColorScale(hex: string): Record<ScaleStep, string> {
  const base = hexToOklch(hex);
  const anchor = nearestStep(base.l);
  const anchorLightness = anchoredLightness(anchor, base.l);
  const out = {} as Record<ScaleStep, string>;
  for (const step of SCALE_STEPS) {
    out[step] = toHex({
      l: step === anchor ? anchorLightness : LIGHTNESS[step],
      // At the anchor this is exactly the source's chroma, so the anchor is exactly the source colour.
      c: (base.c * CHROMA[step]) / CHROMA[anchor],
      h: base.h,
    });
  }
  return out;
}

/**
 * A neutral ramp carrying a trace of the brand's hue.
 *
 * Pure greys (equal R, G and B) are what make an interface look like an admin template: nothing in the physical
 * world is neutral, and a page built from #F7F7F7 and #666666 reads as unfinished rather than as restrained.
 * Giving the neutrals a few percent of the brand's chroma is the oldest trick in interface design and it is the
 * single cheapest way to make a page look considered — the greys stop being grey and start being *the
 * product's* greys, while staying neutral enough to carry text at any size.
 *
 * The chroma here is deliberately tiny — invisible as colour and unmistakable as atmosphere.
 *
 * **It is a fixed amount, not a fraction of the brand's.** Taking a percentage of the source's chroma was the
 * first version, and it fails exactly where the cast matters most: a muted brand like `#123B35` has a chroma
 * of 0.047, six percent of which is 0.003 — small enough to round away to `#F7F7F7` and `#666666` at several
 * steps, which is the pure-grey admin template this function exists to prevent. The *hue* must come from the
 * brand; the *amount* is a property of the technique, so it is stated here and clamped only so that an
 * extremely vivid brand cannot push the greys into being a colour.
 */
export function deriveNeutralScale(hex: string): Record<ScaleStep, string> {
  const base = hexToOklch(hex);
  const chroma = Math.min(0.0062, Math.max(base.c, 0) * 0.5);
  const out = {} as Record<ScaleStep, string>;
  for (const step of SCALE_STEPS) {
    // The pale end keeps a touch more of the cast, where it reads as warmth rather than as colour.
    const weight = LIGHTNESS[step] > 0.8 ? 1.35 : 1;
    out[step] = toHex({ l: LIGHTNESS[step], c: chroma * weight, h: base.h });
  }
  return out;
}

/**
 * A surface tint: the brand's hue at a chosen lightness, with most of its chroma taken out.
 *
 * The `50` step of a scale is a *colour* — it is meant to be recognisable as the brand, for a badge or a
 * highlighted row. A full-width band is a different job: at band scale the same value reads as a wash of mint
 * or lilac, and the page looks like it is advertising something. What a recessed band wants is a surface that
 * is almost white and only warm or cool enough to not be grey, which is a much lower chroma than any step of
 * a scale designed for marks. Hence a separate function rather than reaching for `scale['50']`.
 */
export function tintSurface(hex: string, lightness: number, chromaFactor: number): string {
  const base = hexToOklch(hex);
  return toHex({ l: lightness, c: base.c * chromaFactor, h: base.h });
}

/** `rgb(r g b / alpha)` for the given hex, for overlays that must work on any surface beneath them. */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}
