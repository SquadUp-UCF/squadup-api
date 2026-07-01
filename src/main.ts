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
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildSwaggerConfig } from './swagger.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
