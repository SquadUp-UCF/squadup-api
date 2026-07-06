/**
 * Local development seed.
 *
 * Inserts a pre-verified (`active`) user plus a few sample games so you can log
 * in and exercise the app without the email-OTP flow — which is unusable
 * locally because Resend's sandbox only delivers to the account owner's inbox.
 *
 * Safety: refuses to run against a non-local database unless ALLOW_NONLOCAL=1,
 * so it can't clobber production data.
 *
 *   npm run seed:dev
 *
 * Then log in with:  test@ucf.edu  /  Test1234!
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import * as argon2 from 'argon2';

// Minimal .env reader — the app uses @nestjs/config at runtime, but this
// standalone script needs MONGO_URI without pulling in Nest.
function loadEnv(): Record<string, string> {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function isLocalUri(uri: string): boolean {
  return /localhost|127\.0\.0\.1/.test(uri);
}

const TEST_EMAIL = 'test@ucf.edu';
const TEST_PASSWORD = 'Test1234!';
const UCF = { latitude: 28.6024, longitude: -81.2001 };

async function main() {
  const env = loadEnv();
  const uri = process.env.MONGO_URI || env.MONGO_URI;

  if (!uri) {
    console.error('No MONGO_URI found (checked process.env and .env).');
    process.exit(1);
  }
  if (!isLocalUri(uri) && process.env.ALLOW_NONLOCAL !== '1') {
    console.error(
      '\nRefusing to seed a non-local database.\n' +
        'MONGO_URI does not look like localhost. Point it at a local Mongo\n' +
        '(mongodb://localhost:27017/squadup_dev) or set ALLOW_NONLOCAL=1 to override.\n',
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const users = db.collection('users');
  const games = db.collection('games');

  // --- User (upsert so re-running is idempotent) -------------------------
  const now = new Date();
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });

  const existing = await users.findOne({ email: TEST_EMAIL });
  let userId: mongoose.Types.ObjectId;

  if (existing) {
    userId = existing._id as mongoose.Types.ObjectId;
    await users.updateOne(
      { _id: userId },
      { $set: { password: passwordHash, account_status: 'active', deleted_at: null, updatedAt: now } },
    );
    console.log(`Updated existing test user (${TEST_EMAIL}).`);
  } else {
    const res = await users.insertOne({
      first_name: 'Test',
      last_name: 'User',
      username: 'tester',
      email: TEST_EMAIL,
      password: passwordHash,
      reputation: 5.0,
      no_show_count: 0,
      is_flaker: false,
      reputation_reports: 0,
      account_status: 'active',
      preferred_positions: {},
      games_created: [],
      games_joined: [],
      deleted_at: null,
      createdAt: now,
      updatedAt: now,
    });
    userId = res.insertedId as mongoose.Types.ObjectId;
    console.log(`Created test user (${TEST_EMAIL}).`);
  }

  // --- Sample games (only if none seeded yet) ----------------------------
  const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);
  const sampleGames = [
    {
      // Started 30 min ago → shows the blinking "live" indicator on the map.
      sport: 'volleyball',
      description: 'Sand volleyball happening right now — hop in!',
      location: 'UCF Sand Volleyball Courts',
      start_time: hours(-0.5),
      min_players: 4,
      max_players: 12,
    },
    {
      sport: 'basketball',
      description: 'Casual 5v5 at the RWC courts. All skill levels welcome.',
      location: 'RWC Basketball Courts, UCF',
      start_time: hours(3),
      min_players: 4,
      max_players: 10,
    },
    {
      sport: 'soccer',
      description: 'Pickup soccer on the intramural fields.',
      location: 'UCF Intramural Fields',
      start_time: hours(26),
      min_players: 6,
      max_players: 14,
    },
    {
      sport: 'tennis',
      description: 'Looking for a doubles partner or two.',
      location: 'UCF Tennis Complex',
      start_time: hours(50),
      min_players: 2,
      max_players: 4,
    },
  ];

  const seededCount = await games.countDocuments({ host: userId });
  if (seededCount === 0) {
    const docs = sampleGames.map((g) => ({
      host: userId,
      ...g,
      latitude: UCF.latitude,
      longitude: UCF.longitude,
      status: 'open',
      participants: [{ user: userId, status: 'joined', joined_at: now }],
      createdAt: now,
      updatedAt: now,
    }));
    const res = await games.insertMany(docs);
    await users.updateOne(
      { _id: userId },
      { $set: { games_created: Object.values(res.insertedIds) } },
    );
    console.log(`Inserted ${docs.length} sample games.`);
  } else {
    console.log(`Test user already hosts ${seededCount} game(s) — skipping game seed.`);
  }

  console.log('\nDone. Log in with:');
  console.log(`  email:    ${TEST_EMAIL}`);
  console.log(`  password: ${TEST_PASSWORD}\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
