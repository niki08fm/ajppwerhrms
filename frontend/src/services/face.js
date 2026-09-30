/**
 * Face v2 in the browser is guidance only (face/INTEGRATION.md §4): the Tiny Face
 * Detector says "come closer", "one person", "more light", and the camera frame is
 * captured as a JPEG. Recognition, the live-face check and every decision happen on
 * the server. This file only points the browser at where the detector model is served.
 */
import { configureGuidance } from '@ajpwer/face/guidance';

// Default: served by our own backend at /face-models. Set VITE_FACE_MODEL_URL to host it elsewhere.
configureGuidance({ modelUrl: import.meta.env.VITE_FACE_MODEL_URL || '/face-models' });

export * from '@ajpwer/face/guidance';
export { messageFor } from '@ajpwer/face/messages';
