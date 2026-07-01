/**
 * Generate the committed OpenAPI spec at `docs/swagger.yaml`.
 *
 * Boots the Nest app in **preview mode** so the module graph is built (and the
 * route metadata is available to Swagger) without instantiating providers —
 * meaning no MongoDB connection is opened. The document is serialized from the
 * exact same `buildSwaggerConfig()` used at runtime in `main.ts`, then written
 * as YAML.
 *
 * Run with: `npm run swagger:generate`
 */
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { dump } from 'js-yaml';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { buildSwaggerConfig } from '../src/swagger.config';

async function generate(): Promise<void> {
  // preview: true builds the graph without instantiating providers (no DB).
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  // Match the runtime `/api` prefix so documented paths line up with reality.
  app.setGlobalPrefix('api');

  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());

  const outDir = join(process.cwd(), 'docs');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'swagger.yaml');
  writeFileSync(outFile, dump(document), 'utf8');

  await app.close();
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outFile}`);
}

generate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
