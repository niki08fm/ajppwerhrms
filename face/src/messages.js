/**
 * Every sentence the tablet shows about a punch, in one place. Plain words for
 * people at a site gate; the backend and the browser both use these.
 */
const MESSAGES = {
  // Guidance while the camera looks (browser only, before anything is sent)
  NO_FACE: 'Look at the tablet. Keep your face inside the oval.',
  MULTIPLE_FACES: 'Only one person in front of the tablet, please.',
  TOO_FAR: 'Come a little closer.',
  TOO_CLOSE: 'Move back a little.',
  OFF_CENTRE: 'Move so your face is in the middle of the oval.',
  TOO_DARK: 'It is too dark. Face the light, or turn on a light.',
  TOO_BRIGHT: 'Too much light behind or on you. Move out of direct sun.',
  BLURRY: 'Hold still for a moment.',
  HOLD_STILL: 'Hold still…',
  LOOK_STRAIGHT: 'Look straight at the tablet.',
  TURN_LEFT: 'Now slowly turn your head to your left.',
  TURN_RIGHT: 'Now slowly turn your head to your right.',

  // Replies from the server
  CHECKING: 'Checking…',
  BUSY: 'Still checking — one moment…',
  IDENTIFIED: 'Is this you?',
  NOT_LIVE: 'We could not confirm a live face. Take off sunglasses or a cap and try again.',
  CHALLENGE_FAILED: 'We did not see your head turn. Try again and turn when asked.',
  NO_MATCH: 'We did not recognise you. Try again, looking straight at the tablet.',
  NOT_ME: 'Sorry about that. Try again.',
  CHALLENGE_EXPIRED: 'That took too long. Try again.',
  BLOCKED: 'We could not recognise you after {tries} tries. Enter your employee ID and name, and HR will check your punch.',
  NOT_REGISTERED: 'Your face is not registered yet. Use "Register face" on this tablet, then punch.',
  PUNCHED_IN: 'Punched in at {time}. Have a good day, {name}.',
  PUNCHED_OUT: 'Punched out at {time}. Thank you, {name}.',
  ALREADY_IN_HERE: 'You are already punched in here since {time}.',
  ALREADY_IN_ELSEWHERE: 'You are punched in at {site} since {time}. Use "Change site" there, or punch out there first.',
  REPEAT: 'This punch was already recorded at {time}.',
  SITE_CHANGED: 'Punched out here at {time}. Punch in at {site} when you arrive; your travel time counts if you do it today.',
  MANUAL_SENT: 'Sent to HR. They will check it and add your punch.',
  REGISTERED: 'Face registered, {name}. You can punch now.',
  ALREADY_REGISTERED: 'This person already has a registered face. Ask HR if it needs to be registered again.',
  DUPLICATE_FACE: 'This face is already registered to another person. Ask HR.',
  UNKNOWN_EMPLOYEE: 'No active employee matches that ID and name. Check them, or ask your site in-charge.',
  SERVICE_DOWN: 'Face check is not working right now. Tell your site in-charge.',
  OFFLINE: 'No network. Punch is not possible right now. Tell your site in-charge.',
  CAMERA_BLOCKED: 'The camera is blocked. Allow the camera for this site in the browser settings.',
};

export function messageFor(code, params = {}) {
  const text = MESSAGES[code] ?? code;
  return text.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined || params[k] === null ? '' : String(params[k])));
}

export const MESSAGE_CODES = Object.keys(MESSAGES);
