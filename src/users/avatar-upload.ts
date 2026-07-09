/**
 * Upload plumbing for profile pictures.
 *
 * Files are written to the local filesystem under `uploads/avatars/` and served
 * statically at `/uploads/avatars/...` (see `main.ts`). Only the relative URL
 * path is stored on the user row — the service owns the DB write and old-file
 * cleanup; this module owns the Multer config that validates and lands the file.
 */
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diskStorage } from 'multer';
import { MulterError } from 'multer';
import type { Response } from 'express';

/** On-disk directory the avatar files are written to. */
export const AVATAR_DIR = join(process.cwd(), 'uploads', 'avatars');
/** URL prefix the files are served under (kept in sync with `main.ts`). */
export const AVATAR_URL_PREFIX = '/uploads/avatars';
/** Multipart field name carrying the image. */
export const AVATAR_FIELD = 'avatar';
/** Largest accepted upload. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

/** Accepted image MIME types mapped to the extension we store them as. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Multer options: disk storage, size cap, and a MIME-type allowlist. */
export const avatarMulterOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      // Created lazily so a fresh checkout needn't commit an empty folder.
      mkdirSync(AVATAR_DIR, { recursive: true });
      cb(null, AVATAR_DIR);
    },
    filename: (_req, file, cb) => {
      // Random name + an extension derived from the (already validated) MIME
      // type, so nothing user-controlled ever reaches the filesystem path.
      cb(null, `${randomUUID()}${MIME_EXT[file.mimetype] ?? ''}`);
    },
  }),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_EXT[file.mimetype]) {
      cb(
        new BadRequestException(
          'Profile picture must be a JPEG, PNG, or WebP image',
        ),
        false,
      );
      return;
    }
    cb(null, true);
  },
};

/** The public URL path stored on the user row for an uploaded file. */
export function avatarPublicPath(filename: string): string {
  return `${AVATAR_URL_PREFIX}/${filename}`;
}

/**
 * Translate Multer's own errors into proper 4xx responses. Without this a file
 * that trips `LIMIT_FILE_SIZE` would surface as an opaque 500.
 */
@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(error: MulterError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    const status = tooLarge ? 413 : 400;
    res.status(status).json({
      statusCode: status,
      error: tooLarge ? 'Payload Too Large' : 'Bad Request',
      message: tooLarge
        ? 'Profile picture must be 5 MB or smaller'
        : error.message,
    });
  }
}
