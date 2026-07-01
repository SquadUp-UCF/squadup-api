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
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { GamesModule } from './games/games.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    // Make environment variables available app-wide via ConfigService.
    ConfigModule.forRoot({ isGlobal: true }),

    // Connect to MongoDB using the URI from the environment.
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI'),
      }),
    }),

    // Global rate limiting: 60 requests/min per client IP by default. Auth
    // routes tighten this to 10/min (see AuthController). In-memory store — fine
    // for a single process; use a shared store if the API is ever clustered.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),

    MetricsModule,
    AuthModule,
    UsersModule,
    GamesModule,
  ],
  providers: [
    // Apply the throttler to every route (opt out per-route with @SkipThrottle).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
