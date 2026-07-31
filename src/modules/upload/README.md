# Image Upload Pipeline

## Overview

Every uploaded image goes through a processing pipeline before being stored in Cloudflare R2. The original file is never stored — all images are converted to WebP with optimized variants.

## Pipeline

```
User Upload → Validate → Strip Metadata → Resize → WebP Conversion → Variants → R2 Upload → Return URLs
```

## Accepted Formats

| Format | Converted to WebP? |
|--------|-------------------|
| JPEG   | Yes |
| PNG    | Yes |
| WebP   | Yes |
| AVIF   | Yes |
| GIF    | No (rejected) |

## Processing

All images undergo:

1. **Metadata stripping**: EXIF, GPS, camera info, ICC profiles removed via `sharp.withMetadata({ exif: undefined, icc: undefined })`
2. **Auto-orientation**: `sharp.rotate()` corrects orientation based on EXIF before stripping
3. **Max width enforcement**: Images wider than the limit are resized, aspect ratio preserved, never upscaled
4. **WebP conversion**: Quality 80 with optimal compression settings
5. **Variant generation**: Multiple sizes generated in parallel

## Max Dimensions

| Context | Max Width |
|---------|-----------|
| Product image | 1600px |
| Store logo | 512px |
| Store cover/banner | 1920px |
| Profile avatar | 256px |

## Generated Variants

### Products
| Variant | Size | Fit |
|---------|------|-----|
| Main (url) | As processed (≤1600px) | - |
| thumbnail (thumb) | 300×300 | cover |
| medium (medium) | 600×600 | inside |
| large (large) | 1200×1200 | inside |

### Store Logos
| Variant | Size | Fit |
|---------|------|-----|
| small | 256×256 | cover |
| medium (url) | 512×512 | cover |

### Store Cover
| Variant | Size | Fit |
|---------|------|-----|
| medium | 960×540 | cover |
| large (url) | 1920×1080 | cover |

## Storage Structure

All files stored in the configured R2 bucket under UUID-based paths:

```
products/{uuid}.webp          → Main (medium/large)
products/{uuid}-thumb.webp    → Thumbnail
products/{uuid}-medium.webp   → Medium
products/{uuid}-large.webp    → Large

stores/logos/{uuid}.webp      → Main (medium)
stores/logos/{uuid}-small.webp → Small

stores/covers/{uuid}.webp     → Large
stores/covers/{uuid}-medium.webp → Medium
```

## File Naming

- Deterministic UUID (v4) per upload
- No user-provided filenames ever used
- No timestamps
- All names are collision-safe

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload/product-image` | POST | Upload single product image |
| `/upload/product-images` | POST | Upload up to 10 product images |
| `/upload/store-logo` | POST | Upload store logo |
| `/upload/store-cover` | POST | Upload store cover/banner |
| `/upload` | DELETE | Delete image by key |

## Response Format

```json
{
  "url": "https://r2.example.com/products/{uuid}.webp",
  "key": "products/{uuid}.webp",
  "thumbnail": "https://r2.example.com/products/{uuid}-thumb.webp",
  "thumbnailKey": "products/{uuid}-thumb.webp",
  "medium": "https://r2.example.com/products/{uuid}-medium.webp",
  "mediumKey": "products/{uuid}-medium.webp",
  "large": "https://r2.example.com/products/{uuid}-large.webp",
  "largeKey": "products/{uuid}-large.webp"
}
```

## Configuration

All image settings in `image.config.ts` within the upload module.

| Setting | Default |
|---------|---------|
| WebP quality | 80 |
| Max file size | 10MB |
| Allowed MIME types | image/jpeg, image/png, image/webp, image/avif |

## Cleanup

### On Entity Deletion
- **Product deleted**: All associated image variants deleted from R2
- **Store deleted**: Logo and cover deleted from R2

### On Image Replacement
- **Product image updated**: Old main image + variants deleted from R2
- **Store logo/cover updated**: Old image deleted from R2

All cleanup is best-effort — failures are logged but do not block the operation.

## Cache Headers

All uploaded objects have:
```
Cache-Control: public, max-age=31536000, immutable
```
Since object names are unique (UUID), cached assets are effectively immutable.

## Error Handling

- Upload validation errors return clear messages (invalid type, too large, no file)
- R2 failures are logged server-side with user-friendly messages returned
- Processing failures (Sharp errors, corrupted images) caught and returned as AppException
- Delete failures are logged; do not block entity operations
