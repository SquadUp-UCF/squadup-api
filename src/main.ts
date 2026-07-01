/**
 * Application entry point.
 *
 * Boots the NestJS app and wires up the cross-cutting concerns that every
 * request relies on: a global `/api` route prefix, CORS, and the Swagger
 * documentation UI.
 *
 * There is intentionally no global `ValidationPipe`: each service validates its
 * own payloads explicitly (see `common/validation/validate-dto.ts`).
 */
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildSwaggerConfig } from './swagger.config';

/** Parse the TRUST_PROXY env value into what Express `trust proxy` expects. */
function parseTrustProxy(value: string): boolean | number | string {
  if (/^\d+$/.test(value)) return Number(value); // hop count, e.g. "1"
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value; // e.g. "loopback", a subnet, or a comma-list
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // In production the API sits behind a reverse proxy (e.g. nginx), so the
  // socket IP is the proxy's. Trusting the proxy makes Express use the real
  // client IP from X-Forwarded-For — which the rate limiter keys on, so limits
  // are per client rather than shared across everyone behind the proxy.
  // Config-driven: set TRUST_PROXY=1 in prod; unset (dev/direct) trusts nobody.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set('trust proxy', parseTrustProxy(trustProxy));
  }

  // All routes are served under `/api` (keeps URLs like `/api/auth/login`).
  app.setGlobalPrefix('api');

  // Allow browser clients (the mobile/web app) to call the API.
  app.enableCors();

  // Swagger / OpenAPI docs served at `/api/docs`. `addBearerAuth` lets the UI
  // attach a JWT so protected endpoints can be exercised from the browser. The
  // committed `docs/swagger.yaml` is generated from this same config via
  // `npm run swagger:generate`.
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 5000;
  await app.listen(port);
  console.log(`Server on :${port} (docs at /api/docs)`);
}

bootstrap();
