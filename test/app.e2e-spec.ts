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
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AccountStatus, User } from '../src/users/schemas/user.schema';

describe('SquadUp API (e2e)', () => {
  let app: INestApplication;
  let mongod: MongoMemoryServer;
  let userModel: Model<User>;

  const password = 'Str0ng#Pass';
  const alice = {
    first_name: 'Alice',
    last_name: 'Ng',
    username: 'alice_ng',
    email: 'alice@ucf.edu',
    password,
  };
  const bob = {
    first_name: 'Bob',
    last_name: 'Ito',
    username: 'bob_ito',
    email: 'bob@ucf.edu',
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
    userModel = moduleRef.get<Model<User>>(getModelToken(User.name));
  });

  /**
   * Registration issues a token but leaves the account `pending` until the
   * emailed code is entered, and JwtStrategy refuses a pending account — so
   * every registered user has to be activated here before their token opens
   * anything. Flipping the flag directly keeps the suite off the mail path.
   */
  async function activateAllUsers() {
    await userModel
      .updateMany({}, { $set: { account_status: AccountStatus.Active } })
      .exec();
  }

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

    await activateAllUsers();
  });

  it('rejects a password that violates the policy with 400', async () => {
    await request(server())
      .post('/api/auth/register')
      .send({ ...alice, email: 'weak@ucf.edu', username: 'weak', password: 'weak' })
      .expect(400);
  });

  it('rejects a non-UCF email with 400', async () => {
    await request(server())
      .post('/api/auth/register')
      .send({ ...alice, email: 'someone@gmail.com', username: 'outsider' })
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

  describe('notifications', () => {
    // Notifications are dispatched fire-and-forget, so the HTTP response can
    // land before the row is written — poll rather than assert immediately.
    async function waitFor(
      token: string,
      predicate: (rows: any[]) => boolean,
      label: string,
    ): Promise<any[]> {
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await request(server())
          .get('/api/notifications')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        if (predicate(res.body)) return res.body;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    }

    const ofType = (rows: any[], type: string) =>
      rows.filter((n: { type: string }) => n.type === type);

    it('collapses repeated joins into one unread row for the host', async () => {
      const carol = {
        first_name: 'Carol',
        last_name: 'Diaz',
        username: 'carol_diaz',
        email: 'carol@ucf.edu',
        password,
      };
      const registered = await request(server())
        .post('/api/auth/register')
        .send(carol)
        .expect(201);
      await activateAllUsers();

      await request(server())
        .post(`/api/games/${gameId}/join`)
        .set('Authorization', `Bearer ${registered.body.token}`)
        .expect(201);

      // Bob joined earlier and Carol just did — two joins, one row.
      const rows = await waitFor(
        aliceToken,
        (list) => ofType(list, 'player_joined').length > 0,
        'the host to be told someone joined',
      );
      expect(ofType(rows, 'player_joined')).toHaveLength(1);
    });

    it('collapses repeated edits into one row carrying the latest change', async () => {
      await request(server())
        .patch(`/api/games/${gameId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ start_time: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() })
        .expect(200);

      await waitFor(
        bobToken,
        (list) => ofType(list, 'game_updated').length > 0,
        'the first edit notification',
      );

      await request(server())
        .patch(`/api/games/${gameId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ location: 'South Field' })
        .expect(200);

      const rows = await waitFor(
        bobToken,
        (list) => ofType(list, 'game_updated').some((n) => n.body.includes('location')),
        'the second edit to fold into the first',
      );
      expect(ofType(rows, 'game_updated')).toHaveLength(1);
    });

    it('starts a fresh row once the previous one has been read', async () => {
      await request(server())
        .patch('/api/notifications/read-all')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);

      await request(server())
        .patch(`/api/games/${gameId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ location: 'East Field' })
        .expect(200);

      const rows = await waitFor(
        bobToken,
        (list) => ofType(list, 'game_updated').some((n) => !n.read),
        'a new edit notification after the old one was read',
      );

      // The read row is kept as history; the new event stands on its own.
      const updates = ofType(rows, 'game_updated');
      expect(updates).toHaveLength(2);
      expect(updates.filter((n) => !n.read)).toHaveLength(1);
    });

    it('deletes a single row, leaving the rest of the history alone', async () => {
      const before = await waitFor(
        bobToken,
        (list) => list.length > 1,
        'Bob to have more than one notification to thin out',
      );
      const target = before[0];

      await request(server())
        .delete(`/api/notifications/${target._id ?? target.id}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(204);

      const after = await request(server())
        .get('/api/notifications')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);

      expect(after.body).toHaveLength(before.length - 1);
      expect(
        after.body.some(
          (n: any) => String(n._id ?? n.id) === String(target._id ?? target.id),
        ),
      ).toBe(false);
    });

    it('will not let one user delete another user\'s notification', async () => {
      const alices = await waitFor(
        aliceToken,
        (list) => list.length > 0,
        'Alice to have a notification of her own',
      );
      const target = alices[0];

      // Scoped by owner, so this is a silent no-op rather than an error.
      await request(server())
        .delete(`/api/notifications/${target._id ?? target.id}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(204);

      const after = await request(server())
        .get('/api/notifications')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(
        after.body.some(
          (n: any) => String(n._id ?? n.id) === String(target._id ?? target.id),
        ),
      ).toBe(true);
    });

    it('clears the whole history for the caller only', async () => {
      await request(server())
        .delete('/api/notifications')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(204);

      const bobs = await request(server())
        .get('/api/notifications')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);
      expect(bobs.body).toHaveLength(0);

      // Alice's history is untouched.
      const alices = await request(server())
        .get('/api/notifications')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(alices.body.length).toBeGreaterThan(0);
    });
  });

  describe('guests', () => {
    it('lets a joined player (not just the host) bring a guest', async () => {
      const me = await request(server())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);
      const bobId = String(me.body._id ?? me.body.id);

      const res = await request(server())
        .post(`/api/games/${gameId}/guests`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ name: "Bob's friend" })
        .expect(201);

      const guest = res.body.participants.find(
        (p: { name?: string }) => p.name === "Bob's friend",
      );
      expect(guest).toBeDefined();
      // Stamped with Bob, which is what lets him remove them again.
      expect(String(guest.added_by)).toBe(bobId);
    });

    it('lets the player who added a guest remove them again', async () => {
      const before = await request(server())
        .get(`/api/games/${gameId}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);

      const index = before.body.participants.findIndex(
        (p: { name?: string }) => p.name === "Bob's friend",
      );
      expect(index).toBeGreaterThan(-1);

      const res = await request(server())
        .delete(`/api/games/${gameId}/guests/${index}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);

      expect(
        res.body.participants.some(
          (p: { name?: string }) => p.name === "Bob's friend",
        ),
      ).toBe(false);
    });

    it('refuses a guest from someone who is not on the roster', async () => {
      const dave = {
        first_name: 'Dave',
        last_name: 'Roy',
        username: 'dave_roy',
        email: 'dave@ucf.edu',
        password,
      };
      const registered = await request(server())
        .post('/api/auth/register')
        .send(dave)
        .expect(201);
      await activateAllUsers();

      await request(server())
        .post(`/api/games/${gameId}/guests`)
        .set('Authorization', `Bearer ${registered.body.token}`)
        .send({ name: 'Nobody' })
        .expect(403);
    });
  });

  it('exposes Prometheus metrics including the breach-check counter', async () => {
    const res = await request(server()).get('/api/metrics').expect(200);
    expect(res.text).toContain('squadup_pwned_password_checks_total');
    // e2e runs with PWNED_PASSWORD_CHECK=false, so registers record "disabled".
    expect(res.text).toMatch(/outcome="disabled"/);
  });
});
