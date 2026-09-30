/**
 * Strong random site-tablet passwords, used by the server and by the HR form's
 * "Generate" button. No look-alike characters (0/O/o, 1/l/I), and always at
 * least one letter and one digit so it passes the password rule.
 */
export const SITE_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function randomIndex(n) {
  // Rejection sampling over a uint32 keeps every character equally likely.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function generateSitePassword(length = 12) {
  for (;;) {
    let out = '';
    for (let i = 0; i < length; i++) out += SITE_PASSWORD_ALPHABET[randomIndex(SITE_PASSWORD_ALPHABET.length)];
    if (/[A-Za-z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}
