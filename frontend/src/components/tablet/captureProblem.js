import { errorMessage } from '@/services/api';

/** Keep a failed scan actionable without exposing service or camera internals. */
export function captureProblem(error) {
  const code = error?.code;
  const message = errorMessage(error);
  if (code === 'ALREADY_REGISTERED' || code === 'FACE_AUTHORIZATION_USED') return {
    title: 'Your face is already registered', message,
    help: 'Use the punch button. Ask HR for help if face checks keep failing.', action: 'punch',
  };
  if (String(code).startsWith('FACE_AUTHORIZATION_')) return {
    title: 'Check with HR before registering again', message,
    help: 'You can return to the site or choose another employee.', action: 'choose',
  };
  if (code === 'NETWORK' || code === 'OFFLINE') return {
    title: 'Check the connection', message,
    help: 'Reconnect to the internet, then try again. Your site attendance is still available from the site screen.',
  };
  if (/SERVICE_DOWN|FACE_SERVICE|FACE_BUSY/.test(code || '') || /face check is not working|face service|models? could not|failed to fetch/i.test(message)) return {
    title: 'Face check is unavailable', message,
    help: 'Wait a moment and try again. If it continues, ask your site in-charge for help.',
  };
  if (error?.name === 'NotAllowedError' || /camera.*blocked|allow.*camera|camera.*refused/i.test(message)) return {
    title: 'Allow the camera to continue', message,
    help: 'Open the permission icon beside the address, allow Camera, then try again.',
  };
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return {
    title: 'No camera was found', message: 'Connect a camera or use a tablet with a front camera.',
    help: 'Check the camera connection, then try again.',
  };
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return {
    title: 'The camera is in use', message: 'Another app or browser tab may be using this camera.',
    help: 'Close the other camera app, then try again.',
  };
  if (/secure connection|https|mediaDevices|getUserMedia/i.test(message)) return {
    title: 'Open the secure site link', message: 'Camera access needs the secure app link on this device.',
    help: 'Open the HTTPS link provided by HR, then allow the camera and location.',
  };
  if (/location permission|GPS|location service|outside|geofence|accuracy/i.test(message) || /GEOFENCE|LOCATION|GPS|OUTSIDE/.test(code || '')) return {
    title: 'Check your location', message,
    help: 'Allow Location in the browser and use Punch or Register face from inside this site. You can view attendance from anywhere.',
  };
  return { title: 'Let’s try that again', message,
    help: 'Follow the camera prompts. Ask your site in-charge if the problem continues.' };
}
