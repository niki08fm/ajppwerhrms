import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';

/** Where uploaded employee documents are kept on disk. */
export const documentsDir = path.resolve(env.UPLOAD_DIR, 'documents');

/** File uploads for employee documents: PDF or image, up to 10 MB, stored under a random name. */
export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(documentsDir, { recursive: true });
      cb(null, documentsDir);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(application\/pdf|image\/(png|jpeg|webp))$/.test(file.mimetype)),
});

/**
 * Camera frames for the face service: JPEG, in memory only (never written to disk),
 * up to 1.5 MB each. Tablet punches send `front` and `turn`; HR enrolment sends `front`.
 */
export const frames = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1_500_000, files: 2, fields: 10 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
}).fields([
  { name: 'front', maxCount: 1 },
  { name: 'turn', maxCount: 1 },
]);
