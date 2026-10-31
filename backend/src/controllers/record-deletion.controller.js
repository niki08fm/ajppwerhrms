import { prisma } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { who } from '../utils/audit.js';
import { deletionPreview, deleteNamedRecord } from '../services/record-deletion.service.js';
import { invalidateFaceCache } from '../services/face.service.js';
export const previewDeletion = kind => asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const data = await deletionPreview(prisma, kind, req.params.id);
  if (kind !== 'employee' && !req.admin.permissions.has('people.read')) data.employees = [];
  res.json({
    data
  });
});
export const removeRecord = kind => asyncHandler(async (req, res) => {
  const result = await prisma.$transaction(tx => deleteNamedRecord(tx, kind, req.params.id, req.body, who(req)), {
    timeout: 20000
  });
  if (kind === 'employee') invalidateFaceCache();
  res.json({
    data: result
  });
});
