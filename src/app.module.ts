/**
 * Root application module.
 *
 * Loads environment configuration, opens the MongoDB connection (reusing the
 * same `MONGO_URI` as the legacy Express app, so no data migration is needed),
 * and registers the feature modules.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { createRequestTracker } from './common/throttler/request-tracker';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { GamesModule } from './games/games.module';
import { MetricsModule } from './metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI'),
      }),
    }),
    // 60 requests/minute, bucketed per account rather than per IP so a shared
    // campus/carrier address isn't one budget for everyone on it — see
    // createRequestTracker. Anonymous traffic still buckets by IP, which is
    // what the tighter `/auth` limit relies on.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 60 }],
        getTracker: createRequestTracker(config.get<string>('JWT_SECRET')),
      }),
    }),
    MetricsModule,
    AuthModule,
    UsersModule,
    GamesModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}