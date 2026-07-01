/**
 * Root application module.
 *
 * Loads environment configuration, opens the MongoDB connection (reusing the
 * same `MONGO_URI` as the legacy Express app, so no data migration is needed),
 * and registers the feature modules.
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { GamesModule } from './games/games.module';

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

    AuthModule,
    UsersModule,
    GamesModule,
  ],
})
export class AppModule {}
