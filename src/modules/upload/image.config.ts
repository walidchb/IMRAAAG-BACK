const MB = 1024 * 1024;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Vercel Functions reject a total request body above 4.5 MB before the function runs. Keep
 * every limit below that ceiling with headroom for multipart boundaries and headers. The
 * browser compresses to ~700 KB per image, so these are safety ceilings, not targets. A
 * larger upload would need a direct-to-R2 flow.
 */
const VERCEL_SAFE_REQUEST_BYTES = 4 * MB;

const maxTotalUploadBytes = Math.min(
  intFromEnv('UPLOAD_MAX_TOTAL_BYTES', VERCEL_SAFE_REQUEST_BYTES),
  VERCEL_SAFE_REQUEST_BYTES,
);
const maxFileSize = Math.min(
  intFromEnv('UPLOAD_MAX_FILE_BYTES', maxTotalUploadBytes),
  maxTotalUploadBytes,
);

export const IMAGE_CONFIG = {
  quality: 80,
  /** Per-file ceiling. Clamped to the aggregate request budget above. */
  maxFileSize,
  /** Aggregate multipart budget for one request (all files + boundaries). */
  maxTotalUploadBytes,
  /** Maximum files in one multipart request. */
  maxFilesPerRequest: intFromEnv('UPLOAD_MAX_FILES', 10),
  /** Files processed at once. Bounds sharp CPU/memory on Vercel Functions. */
  processingConcurrency: Math.min(
    Math.max(intFromEnv('UPLOAD_CONCURRENCY', 2), 1),
    4,
  ),
  /** Decompression-bomb guard passed to every sharp instance. */
  maxInputPixels: intFromEnv('UPLOAD_MAX_INPUT_PIXELS', 40_000_000),
  /** Per-store uploads allowed in a rolling day (H7). Bounds storage abuse by one tenant. */
  dailyUploadLimitPerStore: 500,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const,

  maxWidths: {
    product: 1600,
    box: 1600,
    storeLogo: 512,
    storeCover: 1920,
    profileAvatar: 256,
    category: 800,
    plan: 512,
  } as const,

  variants: {
    product: [
      { suffix: 'thumb', width: 300, height: 300, fit: 'cover' as const },
      { suffix: 'medium', width: 600, height: 600, fit: 'inside' as const },
      { suffix: 'large', width: 1200, height: 1200, fit: 'inside' as const },
    ],
    storeLogo: [
      { suffix: 'small', width: 256, height: 256, fit: 'cover' as const },
      { suffix: 'medium', width: 512, height: 512, fit: 'cover' as const },
    ],
    storeCover: [
      { suffix: 'medium', width: 960, height: 540, fit: 'cover' as const },
      { suffix: 'large', width: 1920, height: 1080, fit: 'cover' as const },
    ],
    profileAvatar: [
      { suffix: 'small', width: 128, height: 128, fit: 'cover' as const },
      { suffix: 'medium', width: 256, height: 256, fit: 'cover' as const },
    ],
  } as const,

  folders: {
    product: 'products',
    box: 'boxes',
    storeLogo: 'stores/logos',
    storeCover: 'stores/covers',
    profileAvatar: 'profiles',
    category: 'categories',
    plan: 'plans',
  } as const,
} as const;
