import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export const ResendProvider = {
  provide: 'RESEND',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    return new Resend(config.get<string>('RESEND_API_KEY'));
  },
};