import { afterEach, expect, it, vi } from 'vitest';
import { embeddingToBytes, MODEL_VERSION } from '@ajpwer/face';
import { prisma } from '../../src/config/db.js';
import { invalidateFaceCache, loadGallery } from '../../src/services/face.service.js';

afterEach(() => {
  vi.restoreAllMocks();
  invalidateFaceCache();
});

it('a gallery query started before replacement cannot restore retired templates in the shared cache', async () => {
  const employee_id = '00000000-0000-4000-8000-000000000001';
  const oldFace = [1, ...Array(127).fill(0)];
  const newFace = [0, 1, ...Array(126).fill(0)];
  const row = (vector) => ({ employee_id, model_version: MODEL_VERSION, embedding: embeddingToBytes(vector) });
  let finishOldRead;
  const delayed = new Promise((resolve) => { finishOldRead = resolve; });
  const read = vi.spyOn(prisma.employeeFace, 'findMany')
    .mockReturnValueOnce(delayed).mockResolvedValueOnce([row(newFace)]);

  invalidateFaceCache();
  const oldScan = loadGallery();
  expect(read).toHaveBeenCalledTimes(1);

  // Replacement commits while the first database query is still in flight.
  invalidateFaceCache();
  const newScan = await loadGallery();
  expect(Array.from(newScan.byEmployee.get(employee_id)[0])).toEqual(newFace);
  finishOldRead([row(oldFace)]);
  await oldScan;

  const nextScan = await loadGallery();
  expect(Array.from(nextScan.byEmployee.get(employee_id)[0])).toEqual(newFace);
  expect(read).toHaveBeenCalledTimes(2);
});
