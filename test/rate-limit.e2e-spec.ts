/**
 * Verifies rate limiting end-to-end: auth routes are capped at 10 requests/min
 * per IP, so the 11th rapid attempt is rejected with 429. Uses its own app
 * instance (fresh in-memory throttler state) against an ephemeral MongoDB.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongod.getUri();
    process.env.JWT_SECRET = 'e2e-test-secret';
    process.env.JWT_EXPIRES_IN = '1d';
    process.env.PWNED_PASSWORD_CHECK = 'false';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  it('throttles auth routes after 10 requests/min per IP (11th → 429)', async () => {
    const login = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'nobody@school.edu', password: 'whatever' });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await login();
      statuses.push(res.status);
    }

    // First 10 reach the handler (401 for unknown credentials); the 11th is
    // blocked by the throttler.
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
