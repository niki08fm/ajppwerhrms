/**
 * Face detection and recognition live in the face/ folder (@ajpwer/face): the
 * model files, the browser detection used here, and the server-side matching.
 * This file only points the browser at where the models are served.
 */
import { configureFace } from '@ajpwer/face/browser';

// Default: served by our own backend at /face-models. Set VITE_FACE_MODEL_URL to host them elsewhere.
configureFace({ modelUrl: (import.meta.env.VITE_FACE_MODEL_URL as string | undefined) || '/face-models' });

export * from '@ajpwer/face/browser';
