/**
 * Verifies rate limiting end-to-end: auth routes are capped at 10 requests/min
 * per IP, so the 11th rapid attempt is rejected with 429. Uses its own app
 * instance (fresh in-memory throttler state) against an ephemeral MongoDB.
 *
 * Also covers the tracker: authenticated requests are bucketed per account, so
 * two users behind one address (supertest is always 127.0.0.1, which is the
 * shared-NAT case) don't spend each other's budget.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AccountStatus, User } from '../src/users/schemas/user.schema';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;
  let mongod: MongoMemoryServer;
  let userModel: Model<User>;

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
    userModel = moduleRef.get<Model<User>>(getModelToken(User.name));
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  /** Register a user and activate them, returning a usable bearer token. */
  async function signUp(username: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        first_name: 'Test',
        last_name: 'User',
        username,
        email: `${username}@ucf.edu`,
        password: 'Str0ng#Pass',
      })
      .expect(201);
    // Registration leaves the account pending, and JwtStrategy rejects those.
    await userModel
      .updateMany({}, { $set: { account_status: AccountStatus.Active } })
      .exec();
    return res.body.token;
  }

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

  it('gives two accounts on the same IP independent budgets', async () => {
    const [alice, bob] = [await signUp('rl_alice'), await signUp('rl_bob')];
    const poll = (token: string) =>
      request(app.getHttpServer())
        .get('/api/notifications')
        .set('Authorization', `Bearer ${token}`);

    // Spend Alice's whole per-minute allowance on this handler.
    for (let i = 0; i < 60; i += 1) {
      expect((await poll(alice)).status).toBe(200);
    }
    expect((await poll(alice)).status).toBe(429);

    // Bob is on the same address and untouched by Alice exhausting hers —
    // the point of tracking by account rather than by IP.
    expect((await poll(bob)).status).toBe(200);
  });

  it('does not let an unsigned token buy its way out of the IP bucket', async () => {
    // Each request carries a different `sub`. If the tracker trusted the
    // payload without verifying it, every one would mint a fresh bucket and
    // nothing would ever be throttled.
    const forged = (sub: string) =>
      `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.nope`;

    const hit = (sub: string) =>
      request(app.getHttpServer())
        .get('/api/games/pending-ratings')
        .set('Authorization', `Bearer ${forged(sub)}`);

    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      statuses.push((await hit(`attacker-${i}`)).status);
    }

    // The throttler is a global guard, so it counts before the JWT guard
    // rejects the token — hence 401 until the shared IP bucket runs out.
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});
