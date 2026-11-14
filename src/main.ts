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
    console.warn(
      'WARN: FRONTEND_URL is not set. Password-reset and team-invitation links will point at http://localhost:3001. Set FRONTEND_URL to the vendor dashboard origin (e.g. https://vendor.example.com).',
    );
  }

  const app = await NestFactory.create(AppModule);
  
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3000;

  // Set prefix for API routes
  app.setGlobalPrefix('api');

  // H6: behind a load balancer every request otherwise appears to come from the proxy, which
  // collapses all per-IP throttles into one shared bucket. Opt in explicitly with TRUST_PROXY
  // (`1` for a single proxy hop, a subnet/CIDR, or `true`) - never guessed, because trusting a
  // forwarded header without a proxy lets a client spoof its own IP.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const value = /^\d+$/.test(trustProxy)
      ? Number(trustProxy)
      : trustProxy === 'true'
        ? true
        : trustProxy;
    app.getHttpAdapter().getInstance().set('trust proxy', value);
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

  // Enable CORS. `CORS_ORIGINS` adds extra origins (previews, custom domains); otherwise
  // production falls back to the known deployed frontends so a missing variable cannot take the
  // API down. Any `https://*.imraaah.com` subdomain is always accepted (the apex and every
  // frontend we own), and local development additionally accepts any localhost/127.0.0.1
  // origin (never in production).
  const productionOrigins = [
    'https://imraaah.com',
    'https://www.imraaah.com',
    'https://vendor.imraaah.com',
  ];
  const corsOrigins = (process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : isProduction
      ? productionOrigins
      : ['http://localhost:3002', 'http://localhost:3001', 'http://localhost:3000', 'http://127.0.0.1:3002', 'http://127.0.0.1:3001', 'http://127.0.0.1:3000'])
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => {
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
      const isImraaahDomain = /^https:\/\/(?:[a-z0-9-]+\.)*imraaah\.com$/i.test(origin || '');
      if (
        !origin ||
        corsOrigins.includes(origin) ||
        isImraaahDomain ||
        (!isProduction && isLocalhost)
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
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
