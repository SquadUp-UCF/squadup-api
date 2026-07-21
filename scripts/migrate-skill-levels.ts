/**
 * One-off migration: fold the legacy `preferred_positions` map into the
 * canonical `skill_levels` map, then drop `preferred_positions` from every
 * user document.
 *
 * Background: `preferred_positions` is a misleadingly named legacy field that
 * actually stored a user's per-sport *skill level* before the product moved to
 * `skill_levels`. Clients already read `skill_levels` first and only fell back
 * to `preferred_positions` for un-migrated profiles. This script performs that
 * fold once at the data layer so the field (and the fallback code) can be
 * removed for good.
 *
 * Merge rule: `skill_levels` wins. `preferred_positions` only fills in sports
 * that `skill_levels` does not already have, so no currently-canonical value is
 * ever overwritten — the change is purely additive.
 *
 * Safety:
 *   - Refuses to APPLY against a non-local database unless ALLOW_NONLOCAL=1
 *     (same gate as seed-dev.ts), so it can't write to production by accident.
 *   - DRY_RUN=1 reports exactly what would change and writes nothing; being
 *     read-only, it runs against any database without needing the gate.
 *   - Idempotent: once run, no document has `preferred_positions`, so a second
 *     run matches nothing and is a no-op.
 *
 * IMPORTANT (deploy ordering): run this against an environment BEFORE deploying
 * the code that removes `preferred_positions` from the schema/API. If the code
 * ships first, un-migrated legacy skill data goes dark until this runs.
 *
 *   DRY_RUN=1 npm run db:migrate-skill-levels     # preview, no writes
 *   npm run db:migrate-skill-levels               # apply (local)
 *   ALLOW_NONLOCAL=1 npm run db:migrate-skill-levels   # apply (prod/staging)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';

// Minimal .env reader — the app uses @nestjs/config at runtime, but this
// standalone script needs MONGO_URI without pulling in Nest. (Mirrors seed-dev.)
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

async function main() {
  const env = loadEnv();
  const uri = process.env.MONGO_URI || env.MONGO_URI;
  const dryRun = process.env.DRY_RUN === '1';

  if (!uri) {
    console.error('No MONGO_URI found (checked process.env and .env).');
    process.exit(1);
  }
  // A dry run is read-only, so it is safe against any database and skips the
  // gate. Only an actual apply (which writes) requires ALLOW_NONLOCAL for a
  // non-local target.
  if (!dryRun && !isLocalUri(uri) && process.env.ALLOW_NONLOCAL !== '1') {
    console.error(
      '\nRefusing to APPLY against a non-local database.\n' +
        'MONGO_URI does not look like localhost. Point it at a local Mongo,\n' +
        're-run with DRY_RUN=1 to preview, or set ALLOW_NONLOCAL=1 to apply\n' +
        '(intended for staging/prod runs).\n',
    );
    process.exit(1);
  }

  // Show where we're pointed (credentials stripped) and whether we'll write, so
  // a run against the wrong database is obvious before anything happens.
  const redactedUri = uri.replace(/\/\/[^@/]*@/, '//');
  console.log(`\nTarget:  ${redactedUri}`);
  console.log(`Mode:    ${dryRun ? 'DRY RUN (read-only, no writes)' : 'APPLY (will write)'}`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const users = db.collection('users');

  const withLegacy = { preferred_positions: { $exists: true } };
  const totalUsers = await users.countDocuments({});
  const affected = await users.countDocuments(withLegacy);

  console.log(`\nUsers total:                         ${totalUsers}`);
  console.log(`Users with preferred_positions:      ${affected}`);

  if (affected === 0) {
    console.log('\nNothing to migrate — no document has preferred_positions.');
    await mongoose.disconnect();
    return;
  }

  // Tally how much skill data is actually preserved (a sport present in
  // preferred_positions but missing from skill_levels) vs. merely dropped as a
  // duplicate. Also collect a few concrete before/after samples for the log.
  let usersContributingNewKeys = 0;
  let newSkillKeys = 0;
  const samples: string[] = [];

  const cursor = users.find(withLegacy, {
    projection: { skill_levels: 1, preferred_positions: 1, username: 1 },
  });
  for await (const doc of cursor) {
    const skill: Record<string, string> = doc.skill_levels ?? {};
    const legacy: Record<string, string> = doc.preferred_positions ?? {};
    const added = Object.keys(legacy).filter((sport) => !(sport in skill));
    if (added.length > 0) {
      usersContributingNewKeys += 1;
      newSkillKeys += added.length;
      if (samples.length < 5) {
        const merged = { ...legacy, ...skill };
        samples.push(
          `  @${doc.username ?? doc._id}: skill_levels ${JSON.stringify(skill)} ` +
            `+ legacy ${JSON.stringify(legacy)} -> ${JSON.stringify(merged)}`,
        );
      }
    }
  }

  console.log(`Users gaining skill data from legacy: ${usersContributingNewKeys}`);
  console.log(`New sport keys folded into skill_levels: ${newSkillKeys}`);
  if (samples.length > 0) {
    console.log('\nSample merges:');
    for (const s of samples) console.log(s);
  }

  if (dryRun) {
    console.log('\nDRY_RUN=1 — no writes performed.');
    await mongoose.disconnect();
    return;
  }

  // Single atomic pass: merge with skill_levels taking precedence (it is listed
  // last in $mergeObjects, so its keys overwrite the legacy ones), then unset
  // the legacy field. $ifNull guards documents missing either map entirely.
  const result = await users.updateMany(withLegacy, [
    {
      $set: {
        skill_levels: {
          $mergeObjects: [
            { $ifNull: ['$preferred_positions', {}] },
            { $ifNull: ['$skill_levels', {}] },
          ],
        },
      },
    },
    { $unset: 'preferred_positions' },
  ]);

  const remaining = await users.countDocuments(withLegacy);
  console.log(
    `\nMatched ${result.matchedCount}, modified ${result.modifiedCount}. ` +
      `Documents still carrying preferred_positions: ${remaining}.`,
  );
  if (remaining !== 0) {
    console.error(
      'WARNING: some documents still have preferred_positions — investigate before deploying the field removal.',
    );
  } else {
    console.log('Done. preferred_positions folded into skill_levels and removed.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
