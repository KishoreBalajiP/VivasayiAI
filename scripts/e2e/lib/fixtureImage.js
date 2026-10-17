// Generated images for the hermetic e2e harness (ADR-024): no binary fixtures are committed.
//   fixtureJpeg({ seed, width, height })  a JPEG of seeded colour noise over a green/brown field gradient.
//                                         A different seed gives different bytes, so evidence fingerprints
//                                         differ between photos and between tests.
//   greyTilePng()                         the 256x256 grey map tile the control server answers /tiles with.
import sharp from "sharp";

// mulberry32: a small deterministic PRNG.
const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const seedNumber = (seed) => {
  const text = String(seed ?? "1");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
};

export const MAX_FIXTURE_EDGE = 2000;
const clampEdge = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 16 ? Math.min(n, MAX_FIXTURE_EDGE) : fallback;
};

export const fixtureJpeg = async ({ seed = "1", width = 800, height = 600, quality = 82 } = {}) => {
  const w = clampEdge(width, 800);
  const h = clampEdge(height, 600);
  const random = prng(seedNumber(seed));
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    const field = y / h; // green canopy at the top, muddy water towards the bottom
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const noise = random() * 60 - 30;
      pixels[i] = Math.max(0, Math.min(255, 60 + field * 70 + noise));
      pixels[i + 1] = Math.max(0, Math.min(255, 140 - field * 40 + noise));
      pixels[i + 2] = Math.max(0, Math.min(255, 40 + field * 50 + noise));
    }
  }
  return sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer();
};

let tile = null;
export const greyTilePng = async () => {
  if (!tile) tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
  return tile;
};

export default { fixtureJpeg, greyTilePng, MAX_FIXTURE_EDGE };
