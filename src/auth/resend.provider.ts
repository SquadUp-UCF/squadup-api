/**
 * Resend email client as an injectable provider, so services receive a single
 * configured instance (and tests can swap in a mock via the 'RESEND' token).
 */
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export const RESEND = 'RESEND';

export const ResendProvider = {
  provide: RESEND,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Resend(config.get<string>('RESEND_API_KEY')),
};
