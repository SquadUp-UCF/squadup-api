/**
 * Single source of truth for the OpenAPI/Swagger document metadata.
 *
 * Shared by the runtime docs (`main.ts`, served at `/api/docs`) and the
 * `swagger:generate` script that writes the committed `docs/swagger.yaml`, so
 * the two never drift.
 */
import { DocumentBuilder } from '@nestjs/swagger';

export function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('SquadUp API')
    .setDescription(
      'Authentication, user, and games endpoints for the SquadUp sports social app.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
}
