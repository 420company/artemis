/**
 * The first, local check of a number before anything else happens: an
 * emergency number is refused here, without asking the owner's server.
 * The server and the platform gateway check again with the full rules
 * (E.164, premium-rate ranges, the operator's country allowlist).
 */

/** Emergency and police / fire / ambulance short numbers, worldwide (as on the platform). */
const EMERGENCY = new Set([
  '000', '100', '101', '102', '103', '104', '108', '110', '111', '112', '113', '114', '115', '117', '118', '119', '120', '122',
  '123', '124', '125', '911', '933', '995', '997', '998', '999', '15', '16', '17', '18', '061', '062', '060',
  '12110', '12119', '12120', '12122', '12395', '1669', '119119',
]);

/** Country codes whose numbers are checked without their trunk zero ("+86 (0)110"). */
const CODES = ['1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '54', '55', '56', '57', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '852', '853', '886'];

export type QuickCheck = { ok: true } | { ok: false; code: 'invalid_number' | 'emergency_number' };

export function quickNumberCheck(raw: string | undefined): QuickCheck {
  const text = String(raw ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (!digits || text.length > 40) return { ok: false, code: 'invalid_number' };
  if (EMERGENCY.has(digits)) return { ok: false, code: 'emergency_number' };
  const international = /^\+/.test(text) || digits.startsWith('00');
  if (international) {
    const rest = digits.startsWith('00') ? digits.slice(2) : digits;
    for (const cc of CODES) {
      if (!rest.startsWith(cc)) continue;
      const national = rest.slice(cc.length);
      if (EMERGENCY.has(national) || EMERGENCY.has(national.replace(/^0/, ''))) return { ok: false, code: 'emergency_number' };
    }
  } else if (EMERGENCY.has(digits.replace(/^0/, ''))) {
    return { ok: false, code: 'emergency_number' };
  }
  return { ok: true };
}
