/**
 * Application entry point.
 *
 * Boots the NestJS app and wires up the cross-cutting concerns that every
 * request relies on: a global `/api` route prefix, request validation, CORS,
 * and the Swagger documentation UI.
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // All routes are served under `/api` (keeps URLs like `/api/auth/login`).
  app.setGlobalPrefix('api');

  // Validate every incoming payload against its DTO. `whitelist` strips unknown
  // properties; `transform` coerces payloads into their DTO class instances.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Allow browser clients (the mobile/web app) to call the API.
  app.enableCors();

  // Swagger / OpenAPI docs served at `/api/docs`. `addBearerAuth` lets the UI
  // attach a JWT so protected endpoints can be exercised from the browser.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('SquadUp API')
    .setDescription('Authentication and user endpoints for the SquadUp sports social app.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 5000;
  await app.listen(port);
  console.log(`Server on :${port} (docs at /api/docs)`);
}

bootstrap();
