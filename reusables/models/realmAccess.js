// Availability only. Membership, privacy and identity authority remain separate.


// Fixed code-owned SQL aliases only. Roots use their already-selected state;
// a child resolves its ancestors in this query, without another round trip.
function activeRealmSQL(alias) {
  return `(${alias}.is_active = TRUE AND ${alias}.deletion_requested_at IS NULL
    AND CASE WHEN ${alias}.parent_id IS NULL THEN TRUE ELSE EXISTS (
      WITH RECURSIVE ancestry AS (
        SELECT id,parent_id,is_active,deletion_requested_at FROM community_realm WHERE id=${alias}.parent_id
        UNION SELECT p.id,p.parent_id,p.is_active,p.deletion_requested_at FROM ancestry a
        JOIN community_realm p ON p.id=a.parent_id WHERE a.parent_id IS NOT NULL
      ) SELECT COUNT(*) FROM ancestry HAVING COUNT(*)>0
        AND SUM(CASE WHEN is_active=TRUE AND deletion_requested_at IS NULL THEN 0 ELSE 1 END)=0
        AND SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END)>0
    ) END)`;
}

function evaluateRealmRows(rows, startID) {
  const nodes = new Map(rows.map(row => [String(row.id), row]));
  let current = nodes.get(String(startID));
  if (!current) return { allowed: false, found: false, reason: 'not_found', rootID: null };
  const seen = new Set();
  const chain = [];
  let reason = null;
  while (current) {
    const id = String(current.id);
    if (seen.has(id)) break;
    seen.add(id); chain.push(id);
    if (current.is_active !== true || current.deletion_requested_at != null) {
      reason ||= id === String(startID)
        ? (current.deletion_requested_at != null ? 'deleting' : 'inactive') : 'parent_inactive';
    }
    if (current.parent_id == null) return { allowed: reason == null, found: true, reason, rootID: id, chain };
    current = nodes.get(String(current.parent_id));
  }
  return { allowed: false, found: true, reason: 'invalid_hierarchy', rootID: null, chain };
}

async function realmAccess(client, identifier) {
  const { rows } = await client.query(`WITH RECURSIVE ancestry AS (
    SELECT id AS start_id, id, parent_id, is_active, deletion_requested_at FROM community_realm
      WHERE id = $1 OR realm_id = $1 OR entity_id = $1 OR slug = $1
    UNION
    SELECT chain.start_id, parent.id, parent.parent_id, parent.is_active, parent.deletion_requested_at
      FROM ancestry chain JOIN community_realm parent ON parent.id = chain.parent_id
  ) SELECT * FROM ancestry`, [String(identifier)]);
  if (!rows.length) return evaluateRealmRows([], identifier);
  const starts = [...new Set(rows.map(row => String(row.start_id)))];
  if (starts.length !== 1) return { allowed: false, found: true, reason: 'invalid_hierarchy', rootID: null };
  return evaluateRealmRows(rows, starts[0]);
}

async function effectiveRealmAccess(client, realm) {
  if (!realm.parent_id) return evaluateRealmRows([realm], realm.id);
  return realmAccess(client, realm.id);
}

async function realmScopeBatch(client, identifiers) {
  if (!identifiers.length) return [];
  const { rows } = await client.query(`WITH RECURSIVE ancestry AS (
    SELECT wanted.identifier AS lookup_id, r.id AS start_id, r.id, r.parent_id, r.is_active, r.deletion_requested_at
    FROM unnest($1::text[]) AS wanted(identifier) JOIN community_realm r
      ON r.id = wanted.identifier OR r.realm_id = wanted.identifier
      OR r.entity_id = wanted.identifier OR r.slug = wanted.identifier
    UNION
    SELECT chain.lookup_id, chain.start_id, parent.id, parent.parent_id, parent.is_active, parent.deletion_requested_at
    FROM ancestry chain JOIN community_realm parent ON parent.id = chain.parent_id
  ) SELECT * FROM ancestry`, [identifiers]);
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.lookup_id)) groups.set(row.lookup_id, []);
    groups.get(row.lookup_id).push(row);
  }
  return [...groups].map(([id, chain]) => {
    const starts = new Set(chain.map(row => String(row.start_id)));
    if (starts.size !== 1) throw unavailable();
    return { id, ...evaluateRealmRows(chain, [...starts][0]) };
  });
}

function unavailable() {
  return Object.assign(new Error('This realm is unavailable.'), { status: 403, code: 'REALM_UNAVAILABLE' });
}

// The caller owns BEGIN/COMMIT on this pinned client. Never acquire a second
// connection while a source/destination transaction is holding scope locks.
async function lockActiveRealmScopes(client, realmIDs, { requireActive = true, requiredRealmIDs = [] } = {}) {
    const identifiers = [...new Set([...realmIDs,...requiredRealmIDs].filter(Boolean).map(String))];
    const scopes = await realmScopeBatch(client, identifiers);
    if (requiredRealmIDs.some(id => !scopes.some(scope => scope.id === String(id)))) throw unavailable();
    for (const state of scopes) {
      if ((requireActive && !state.allowed) || !state.rootID) throw unavailable();
    }
    scopes.sort((a, b) => a.rootID.localeCompare(b.rootID) || a.chain.length - b.chain.length || a.id.localeCompare(b.id));
    const held = new Set();
    for (const scope of scopes) {
      for (const id of [...scope.chain].reverse()) {
        if (held.has(id)) continue;
        await client.query('SELECT id FROM community_realm WHERE id = $1 FOR SHARE', [id]);
        held.add(id);
      }
    }
    if (!scopes.length) return; // Personal identities have no lifecycle scope.
    const fresh = await realmScopeBatch(client, identifiers);
    if (fresh.length !== scopes.length) throw unavailable();
    for (const current of fresh) {
      if ((requireActive && !current.allowed) || !current.found || !current.rootID || current.chain.some(id => !held.has(id))) throw unavailable();
    }
}

async function withRealmScopeRead(pool, realmIDs, callback, { requireActive = false, requiredRealmIDs = [] } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockActiveRealmScopes(client, realmIDs, { requireActive, requiredRealmIDs });
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function withActiveRealmWrite(pool, realmIDs, callback, options = {}) {
  return withRealmScopeRead(pool, realmIDs, callback, { ...options, requireActive: true });
}

module.exports = { activeRealmSQL, evaluateRealmRows, realmAccess, effectiveRealmAccess, lockActiveRealmScopes, withActiveRealmWrite, withRealmScopeRead, unavailable };
