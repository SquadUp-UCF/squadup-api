/**
 * End-to-end smoke test for the core flows, run against a real (in-memory)
 * MongoDB via `mongodb-memory-server`. Exercises the full HTTP stack — routing,
 * JWT guards, in-service DTO validation, and Mongoose persistence — without any
 * mocks and without touching a real database.
 *
 * `MONGO_URI` is pointed at the ephemeral server before the app module is
 * initialized, and `PWNED_PASSWORD_CHECK` is disabled so no outbound HIBP call
 * is made during tests.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('SquadUp API (e2e)', () => {
  let app: INestApplication;
  let mongod: MongoMemoryServer;

  const password = 'Str0ng#Pass';
  const alice = {
    first_name: 'Alice',
    last_name: 'Ng',
    username: 'alice_ng',
    email: 'alice@school.edu',
    password,
  };
  const bob = {
    first_name: 'Bob',
    last_name: 'Ito',
    username: 'bob_ito',
    email: 'bob@school.edu',
    password,
  };

  let aliceToken: string;
  let bobToken: string;
  let gameId: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    // Must be set before AppModule is initialized (MongooseModule reads it).
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

  const server = () => app.getHttpServer();

  it('registers two users and returns tokens', async () => {
    const a = await request(server())
      .post('/api/auth/register')
      .send(alice)
      .expect(201);
    expect(a.body.token).toBeDefined();
    aliceToken = a.body.token;

    const b = await request(server())
      .post('/api/auth/register')
      .send(bob)
      .expect(201);
    bobToken = b.body.token;
  });

  it('rejects a password that violates the policy with 400', async () => {
    await request(server())
      .post('/api/auth/register')
      .send({ ...alice, email: 'weak@school.edu', username: 'weak', password: 'weak' })
      .expect(400);
  });

  it('rejects a duplicate email with 409', async () => {
    await request(server())
      .post('/api/auth/register')
      .send(alice)
      .expect(409);
  });

  it('lets Alice host a game (she is auto-added to the roster)', async () => {
    const res = await request(server())
      .post('/api/games')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        sport: 'soccer',
        location: 'North Field',
        start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        latitude: 40.7128,
        longitude: -74.006,
        min_players: 2,
        max_players: 4,
      })
      .expect(201);

    expect(res.body.status).toBe('open');
    expect(res.body.participants).toHaveLength(1);
    gameId = res.body._id ?? res.body.id;
    expect(gameId).toBeDefined();
  });

  it('requires a token for protected routes', async () => {
    await request(server()).get('/api/games/mine').expect(401);
  });

  it('shows the game under Alice\'s "my games"', async () => {
    const res = await request(server())
      .get('/api/games/mine')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(String(res.body[0]._id ?? res.body[0].id)).toBe(String(gameId));
  });

  it('lets Bob join, confirming the game at min_players', async () => {
    const res = await request(server())
      .post(`/api/games/${gameId}/join`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(201);

    // Roster hit min_players (2) → status flips to confirmed.
    expect(res.body.status).toBe('confirmed');
    const activeCount = res.body.participants.filter(
      (p: { status: string }) => p.status === 'joined',
    ).length;
    expect(activeCount).toBe(2);
  });

  it('exposes Prometheus metrics including the breach-check counter', async () => {
    const res = await request(server()).get('/api/metrics').expect(200);
    expect(res.text).toContain('squadup_pwned_password_checks_total');
    // e2e runs with PWNED_PASSWORD_CHECK=false, so registers record "disabled".
    expect(res.text).toMatch(/outcome="disabled"/);
  });
});
