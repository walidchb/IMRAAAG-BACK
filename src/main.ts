import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ValidationPipe } from './common/pipes/validation.pipe';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import {
  isOriginAllowed,
  normalizeCorsOrigin,
  normalizeSubdomainRoots,
} from './common/cors/allowed-origins';

type TrustProxyValue = number | boolean | string | undefined;

/**
 * Express `trust proxy` accepts a hop count, a trusted CIDR/IP list, or a boolean.
 *
 * Vercel puts exactly one edge proxy in front of each deployment, so `vercel` maps to `1`
 * (one trusted hop). Do not use `true`: it trusts every hop and lets a client spoof its own
 * `X-Forwarded-For` entry. If another proxy (e.g. Cloudflare) is added in front of Vercel,
 * increase the hop count or use that proxy's CIDR list instead.
 */
function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'vercel') return 1;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';

  // Validate critical env vars before any module initialization
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'change-me-in-production-use-a-strong-secret') {
    console.error('FATAL: JWT_SECRET environment variable is not set. Set a strong random value before starting the server.');
    process.exit(1);
  }

  // H8: without this key `encryptRecord`/`decryptRecord` pass values through unchanged, so
  // carrier API keys and tokens are stored (and were served) in plaintext. In production the
  // process must refuse to start rather than silently degrade.
  const deliveryEncryptionKey = process.env.DELIVERY_ENCRYPTION_KEY;
  if (isProduction && !deliveryEncryptionKey) {
    console.error(
      'FATAL: DELIVERY_ENCRYPTION_KEY is required in production. It encrypts carrier API credentials at rest; set a 64-character hex key (32 bytes) generated with `openssl rand -hex 32`.',
    );
    process.exit(1);
  }
  if (deliveryEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(deliveryEncryptionKey)) {
    console.error(
      'FATAL: DELIVERY_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with `openssl rand -hex 32`.',
    );
    process.exit(1);
  }

  // Password-reset and team-invitation emails link back to the vendor dashboard. Without
  // FRONTEND_URL those links point at localhost, which is unreachable from a real inbox.
  if (isProduction && !process.env.FRONTEND_URL) {
    console.error(
      'FATAL: FRONTEND_URL is required in production (the vendor dashboard origin, e.g. https://vendor.imraaah.com). Password-reset and team-invitation links cannot use localhost.',
    );
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error('FATAL: MONGODB_URI is required. Configure the database connection string for this deployment.');
    process.exit(1);
  }

  // CORS is environment-driven. A production deployment must state its own browser origins
  // and store-root domains instead of inheriting a hardcoded default from another environment.
  if (isProduction && !process.env.CORS_ORIGINS?.trim()) {
    console.error(
      'FATAL: CORS_ORIGINS is required in production. Set the comma-separated browser origins for this environment (e.g. https://imraaah.com,https://vendor.imraaah.com for prod; https://dev.imraaah.com,https://vendor.dev.imraaah.com for dev).',
    );
    process.exit(1);
  }
  if (isProduction && !process.env.CORS_SUBDOMAIN_ROOTS?.trim()) {
    console.error(
      'FATAL: CORS_SUBDOMAIN_ROOTS is required in production. Set the store-root domain for this environment (e.g. imraaah.com for prod; dev.imraaah.com for dev).',
    );
    process.exit(1);
  }

  // Uploads return public image URLs. A missing/relative R2_PUBLIC_URL makes every stored
  // image resolve against the storefront host instead of the bucket, so refuse to start in
  // production rather than silently serving broken images.
  const r2PublicUrl = process.env.R2_PUBLIC_URL;
  if (isProduction) {
    if (!r2PublicUrl || !/^https:\/\//i.test(r2PublicUrl)) {
      console.error(
        'FATAL: R2_PUBLIC_URL must be an absolute https:// URL in production (the public bucket/CDN origin, e.g. https://pub-xxxx.r2.dev).',
      );
      process.exit(1);
    }
    for (const key of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      if (!process.env[key]) {
        console.error(`FATAL: ${key} is required in production for image uploads.`);
        process.exit(1);
      }
    }
  } else if (r2PublicUrl && !/^https?:\/\//i.test(r2PublicUrl)) {
    console.warn('WARN: R2_PUBLIC_URL is not an absolute URL; upload URLs will be relative.');
  }

  // View analytics hashes visitor ids with this salt. A fallback to JWT_SECRET silently
  // resets every unique count when the JWT secret is rotated, so require a dedicated stable
  // salt whenever the feature is enabled in a production build (including Vercel previews).
  const analyticsEnabled = process.env.ITEM_VIEW_ANALYTICS_ENABLED === 'true';
  if (isProduction && analyticsEnabled) {
    const salt = process.env.ITEM_VIEW_HASH_SALT;
    if (!salt || salt.trim().length < 16) {
      console.error(
        'FATAL: ITEM_VIEW_HASH_SALT is required when ITEM_VIEW_ANALYTICS_ENABLED=true in production. Generate one with `openssl rand -hex 32`. Changing it resets unique-visitor continuity.',
      );
      process.exit(1);
    }
  }

  // Behind Vercel every request reaches the app through the Vercel edge proxy. The setting
  // must be explicit: without it all clients share the proxy IP (collapsing per-IP throttles
  // and the analytics fallback hash), while `true` lets a client spoof its own address.
  const trustProxyRaw = process.env.TRUST_PROXY;
  if (isProduction && !trustProxyRaw?.trim()) {
    console.error(
      'FATAL: TRUST_PROXY is required in production. On Vercel set TRUST_PROXY=vercel (one trusted edge hop; resolves to Express trust proxy = 1). Use a CIDR/hop count if another proxy is in front of Vercel, or `false` only if the app is truly directly exposed.',
    );
    process.exit(1);
  }
  const trustProxy = parseTrustProxy(trustProxyRaw);
  if (isProduction && trustProxy === true) {
    console.warn(
      'WARN: TRUST_PROXY=true trusts every hop. Prefer TRUST_PROXY=vercel or the exact proxy CIDR so a client cannot spoof X-Forwarded-For.',
    );
  }

  const app = await NestFactory.create(AppModule);
  
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3000;

  // Set prefix for API routes
  app.setGlobalPrefix('api');

  // Apply the explicit trust-proxy decision parsed above. Express then resolves `req.ip` and
  // `req.ips` from the trusted hop only, so the throttler and the analytics beacon see the
  // client address rather than the Vercel edge/egress address.
  if (trustProxy !== undefined) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    console.log(
      `Trust proxy: ${String(trustProxy)}${process.env.VERCEL ? ' (Vercel edge)' : ''}`,
    );
  } else {
    console.log('Trust proxy: disabled (direct connection)');
  }

  // Security headers
  app.use(helmet());

  // Cookie parser (for reading JWT from cookies)
  app.use(cookieParser());

  // The CORS response varies per `Origin`, but shared caches (Vercel's CDN in particular) do
  // not reliably include `Vary: Origin` in their cache key. A response approved for one frontend
  // can then be replayed to another, which the browser rejects with
  // "CORS header 'Access-Control-Allow-Origin' does not match '<other origin>'". Never let a
  // shared cache store an API response; endpoints that need caching set their own headers later.
  // Registered before `enableCors` so preflight (OPTIONS) responses are covered too.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    next();
  });

  // CORS is fully environment-driven; there is no hardcoded origin list or root-domain
  // default. `CORS_ORIGINS` is the exact browser-origin list for this deployment (prod:
  // https://imraaah.com,https://vendor.imraaah.com; dev:
  // https://dev.imraaah.com,https://vendor.dev.imraaah.com). `CORS_SUBDOMAIN_ROOTS` is the
  // store-root domain (prod: imraaah.com; dev: dev.imraaah.com), so every store host under it
  // is accepted without a per-store entry. Local development also accepts any *.localhost /
  // *.127.0.0.1 origin. Both variables are required in production (checked before boot).
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(normalizeCorsOrigin)
    .filter(Boolean);
  const corsSubdomainRoots = normalizeSubdomainRoots(
    process.env.CORS_SUBDOMAIN_ROOTS,
  );
  app.enableCors({
    origin: (origin, callback) => {
      callback(
        null,
        isOriginAllowed(origin, {
          exactOrigins: corsOrigins,
          subdomainRoots: corsSubdomainRoots,
          isProduction,
        }),
      );
    },
    credentials: true,
    maxAge: 86400,
  });

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe());

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global interceptors
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TimeoutInterceptor(),
  );

  // H9: the full API surface, DTOs and example values are not published in production unless
  // explicitly opted in (e.g. a private staging deployment fronted by admin auth).
  const swaggerEnabled = !isProduction || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Imraaah API')
      .setDescription('The Imraaah Multi-Vendor E-Commerce Platform API description')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}/api`);
  if (swaggerEnabled) {
    console.log(`Swagger documentation is available at: http://localhost:${port}/api/docs`);
  }
}
bootstrap();
