/** Server side of face v2 (backend only). The browser imports ./guidance and ./messages. */
export { createFaceClient, FaceServiceBadImage, FaceServiceBusy, FaceServiceUnavailable } from './client.js';
export { buildGallery, dot, embeddingToBytes, EMBEDDING_SIZE, hasTemplate, matchGallery, MODEL_VERSION, normalise, toEmbedding } from './gallery.js';
export { checkDuplicate, checkSingleFrame, decideGuidedRegistration, decidePunch, FACE_DEFAULTS, OPEN_SHIFT_MAX_MIN, rollingToDelete, shouldLearn, turnSign } from './decide.js';
export { createPunchSession } from './session.js';
export { messageFor, MESSAGE_CODES } from './messages.js';
