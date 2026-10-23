const pool = require('../database/postgres');
const defaultPaths = new Set([
  'api', 'assets', 'conference', 'contacts', 'delete-account', 'design',
  'edits', 'explore', 'invite', 'login', 'mapfeed', 'messages', 'moderation',
  'moments', 'notes', 'notifications', 'pages', 'post', 'privacy', 'realms',
  'register', 'scenes', 'servers', 'settings', 'setup', 'share', 'studio',
  'studios', 'support', 'terms', 'topics', 'user', 'verification',
]);
const RESERVED_PATH_MESSAGE = 'That link name is reserved by Chatterloop. Choose another name.';
const normalize = value => value.normalize('NFKC').trim().toUpperCase().toLowerCase().replace(/ß/g, 'ss');
const malformed = value => typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || /[/\\%?#]/.test(normalize(value)) || ['.', '..'].includes(normalize(value));

async function getReservedProfilePaths() {
  try {
    const {rows} = await pool.query('SELECT value FROM core_variable WHERE key = $1', ['reserved_profile_paths']);
    const paths = rows[0]?.value?.paths;
    if (!Array.isArray(paths) || paths.some(path => malformed(path) || !normalize(path))) return defaultPaths;
    return new Set(paths.map(normalize));
  } catch {
    return defaultPaths;
  }
}

async function validateProfilePath(value, field = 'slug') {
  if (value == null || value === '') return;
  // Use the same Unicode normalization as Django and the webapp.
  const invalid = malformed(value);
  const reserved = !invalid && (await getReservedProfilePaths()).has(normalize(value));
  if (invalid || reserved) {
    const error = new Error(invalid ? 'Use a link name without URL separators or escapes.' : RESERVED_PATH_MESSAGE);
    Object.assign(error, {status: 400, code: invalid ? 'INVALID_PROFILE_PATH' : 'RESERVED_PATH', field});
    throw error;
  }
}

module.exports = { validateProfilePath, getReservedProfilePaths };
