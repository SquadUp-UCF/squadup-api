/**
 * Anonymize a LOCAL copy of the database so it carries prod's structure and
 * volume without real user PII.
 *
 * Intended to run right after a prod dump has been restored into the local
 * container (see `scripts/clone-prod.sh`). It rewrites every user's identifying
 * fields to deterministic fake values and replaces the password hash with a
 * single known dev password, so testers can actually log in as any cloned user.
 *
 * SAFETY: this is a destructive, local-only operation. It refuses to run against
 * anything that is not localhost/127.0.0.1 unless `ALLOW_NONLOCAL=1` is set —
 * this is the guardrail that stops it from ever scrubbing production.
 *
 * Usage:
 *   LOCAL_DB_URI=mongodb://localhost:27017/squadup_dev npm run db:anonymize
 */
import mongoose from 'mongoose';
import * as argon2 from 'argon2';

/** Every anonymized user is given this password (meets the register policy). */
export const DEV_PASSWORD = 'Passw0rd!';

/** True only for connection strings that clearly point at the local machine. */
export function isLocalUri(uri: string): boolean {
  return /(?:\/\/|@)(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$|\?)/.test(uri);
}

export async function anonymize(uri: string): Promise<number> {
  if (!isLocalUri(uri) && process.env.ALLOW_NONLOCAL !== '1') {
    throw new Error(
      `Refusing to anonymize a non-local database: "${uri}". ` +
        `This is a destructive, local-only operation. ` +
        `Set ALLOW_NONLOCAL=1 only if you are absolutely sure.`,
    );
  }

  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    const devHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
    const users = connection.collection('users');

    const cursor = users.find({}, { projection: { _id: 1 } });
    let count = 0;
    for await (const doc of cursor) {
      count += 1;
      // Sequential values keep the unique email/username indexes satisfied.
      await users.updateOne(
        { _id: doc._id },
        {
          $set: {
            first_name: `User${count}`,
            last_name: 'Test',
            username: `user${count}`,
            email: `user${count}@example.test`,
            password: devHash,
          },
        },
      );
    }
    return count;
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  const uri = process.env.LOCAL_DB_URI || 'mongodb://localhost:27017/squadup_dev';
  anonymize(uri)
    .then((count) => {
      // eslint-disable-next-line no-console
      console.log(
        `Anonymized ${count} user(s) in ${uri}. ` +
          `All cloned users now log in with password "${DEV_PASSWORD}".`,
      );
      process.exit(0);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(String(error?.message ?? error));
      process.exit(1);
    });
}
