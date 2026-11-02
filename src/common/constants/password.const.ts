/**
 * Password policy (H4).
 *
 * The platform previously accepted any 6-character string, and login is only IP-throttled, so
 * credential stuffing against a leaked list was cheap. New and reset passwords now need 10+
 * characters with at least one letter and one digit, must not be a well-known password, and are
 * capped at 72 bytes (bcrypt silently truncates beyond that, which would make the extra
 * characters meaningless).
 *
 * This applies to password CREATION and CHANGE only. `LoginDto` deliberately keeps no length
 * rule: existing accounts must still be able to sign in, and a rejected-length error there
 * would leak whether a password is even plausible.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;

/** At least one letter and one digit, no whitespace-only padding around the rule. */
export const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).+$/;
export const PASSWORD_MESSAGE =
  'Password must be at least 10 characters long and include at least one letter and one number.';

/**
 * A small offline denylist of the credentials that show up first in every breach corpus.
 * A real breached-password check (HIBP k-anonymity) is the production follow-up; this catches
 * the obvious cases without a network dependency.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd',
  'p@ssw0rd',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwerty123',
  'azerty',
  'azerty123',
  'admin',
  'admin123',
  'admin1234',
  'administrator',
  'welcome',
  'welcome123',
  'letmein',
  'iloveyou',
  'abc123',
  'abc12345',
  '123123',
  '111111',
  '000000',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'superman',
  'batman',
  'test1234',
  'changeme',
  'motdepasse',
  'motdepasse123',
  'imraaah',
  'imraaah123',
  'algeria123',
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
