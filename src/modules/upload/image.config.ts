export const IMAGE_CONFIG = {
  quality: 80,
  maxFileSize: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const,

  maxWidths: {
    product: 1600,
    storeLogo: 512,
    storeCover: 1920,
    profileAvatar: 256,
    category: 800,
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
    storeLogo: 'stores/logos',
    storeCover: 'stores/covers',
    profileAvatar: 'profiles',
  } as const,
} as const;
