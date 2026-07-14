/**
 * Upload plumbing for host-supplied game banners.
 *
 * Mirrors `users/avatar-upload.ts`: files land on disk under
 * `uploads/game-banners/` and are served statically at
 * `/uploads/game-banners/...` (see `main.ts`, which already serves all of
 * `uploads/` — no separate `useStaticAssets` call needed). Only the relative
 * URL path is stored on the game row (`photo_url`); this module owns the
 * Multer config that validates and lands the file, `GamesService` owns the DB
 * write and old-file cleanup. `MulterExceptionFilter` is generic (not
 * avatar-specific) and reused as-is from `users/avatar-upload`.
 */
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diskStorage } from 'multer';

/** On-disk directory game banner files are written to. */
export const BANNER_DIR = join(process.cwd(), 'uploads', 'game-banners');
/** URL prefix the files are served under (kept in sync with `main.ts`). */
export const BANNER_URL_PREFIX = '/uploads/game-banners';
/** Multipart field name carrying the image. */
export const BANNER_FIELD = 'photo';
/** Largest accepted upload. */
export const MAX_BANNER_BYTES = 5 * 1024 * 1024; // 5 MB

/** Accepted image MIME types mapped to the extension we store them as. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Multer options: disk storage, size cap, and a MIME-type allowlist. */
export const bannerMulterOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      // Created lazily so a fresh checkout needn't commit an empty folder.
      mkdirSync(BANNER_DIR, { recursive: true });
      cb(null, BANNER_DIR);
    },
    filename: (_req, file, cb) => {
      // Random name + an extension derived from the (already validated) MIME
      // type, so nothing user-controlled ever reaches the filesystem path.
      cb(null, `${randomUUID()}${MIME_EXT[file.mimetype] ?? ''}`);
    },
  }),
  limits: { fileSize: MAX_BANNER_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_EXT[file.mimetype]) {
      cb(
        new BadRequestException('Banner image must be a JPEG, PNG, or WebP image'),
        false,
      );
      return;
    }
    cb(null, true);
  },
};

/** The public URL path stored on the game row for an uploaded banner. */
export function bannerPublicPath(filename: string): string {
  return `${BANNER_URL_PREFIX}/${filename}`;
}
