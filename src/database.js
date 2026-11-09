const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')
const { initializeRag } = require('./rag')

const RETENTION_DAYS = 2
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_REMINDER_HOURS = 4
const META_MESSAGING_WINDOW_HOURS = 23

const pool = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : undefined,
  })
  : null

// Separate database for phone leads (e.g. a local Postgres), driven by
// LEADS_DATABASE_URL. Falls back to the main pool when the var is not set, so
// existing deployments keep working. Set LEADS_DB_SSL=true to force SSL.
const leadsPool = process.env.LEADS_DATABASE_URL
  ? new Pool({
    connectionString: process.env.LEADS_DATABASE_URL,
    ssl: process.env.LEADS_DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
  })
  : pool

async function initializeDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL is not set — conversation storage is disabled')
    return
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_incoming_at TIMESTAMPTZ,
      reminder_sent_at TIMESTAMPTZ,
      UNIQUE (channel, user_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id UUID PRIMARY KEY,
      conversation_id UUID NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      message_type TEXT NOT NULL DEFAULT 'text',
      content TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS last_incoming_at TIMESTAMPTZ;
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS program_track TEXT;
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS page_id TEXT;
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS phone_asked_at TIMESTAMPTZ;
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS greeting_sent_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS conversation_messages_conversation_created_idx
      ON conversation_messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS conversations_last_activity_idx
      ON conversations (last_activity_at);
    CREATE INDEX IF NOT EXISTS conversations_reminder_due_idx
      ON conversations (last_incoming_at)
      WHERE reminder_sent_at IS NULL AND last_incoming_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS webhook_events (
      channel TEXT NOT NULL,
      event_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (channel, event_key)
    );
  `)

  await pool.query(`
    UPDATE conversations c
    SET last_incoming_at = sub.max_created
    FROM (
      SELECT conversation_id, MAX(created_at) AS max_created
      FROM conversation_messages
      WHERE direction = 'incoming'
      GROUP BY conversation_id
    ) sub
    WHERE c.id = sub.conversation_id
      AND c.last_incoming_at IS NULL
  `)

  await initializeRag(pool)

  // One conversation per (channel, user_id): merge any duplicates, then enforce uniqueness.
  await pool.query(`
    WITH ranked AS (
      SELECT
        id,
        channel,
        user_id,
        ROW_NUMBER() OVER (
          PARTITION BY channel, user_id
          ORDER BY last_activity_at DESC, created_at DESC
        ) AS rn
      FROM conversations
    ),
    keepers AS (
      SELECT id, channel, user_id FROM ranked WHERE rn = 1
    ),
    dupes AS (
      SELECT r.id AS dupe_id, k.id AS keep_id
      FROM ranked r
      JOIN keepers k
        ON k.channel = r.channel
       AND k.user_id = r.user_id
      WHERE r.rn > 1
    ),
    moved AS (
      UPDATE conversation_messages m
      SET conversation_id = d.keep_id
      FROM dupes d
      WHERE m.conversation_id = d.dupe_id
      RETURNING m.id
    )
    DELETE FROM conversations c
    USING dupes d
    WHERE c.id = d.dupe_id
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_channel_user_id_uidx
      ON conversations (channel, user_id)
  `)

  await deleteExpiredConversations()
  const cleanupTimer = setInterval(() => {
    deleteExpiredConversations().catch(error => {
      console.error('Conversation cleanup failed:', error.message)
    })
  }, CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  await initializeLeadsDatabase()

  console.log(`Conversation database ready (${RETENTION_DAYS}-day inactivity retention)`)
}

// Ensures the phone_leads table and its unique constraint exist in whichever
// database leadsPool points to (the separate leads DB, or the main one as a
// fallback). The ON CONFLICT upsert in savePhoneLead needs the unique index.
async function initializeLeadsDatabase() {
  if (!leadsPool) return

  await leadsPool.query(`
    CREATE TABLE IF NOT EXISTS phone_leads (
      id SERIAL PRIMARY KEY,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      fb_name TEXT,
      phone TEXT NOT NULL,
      program_track TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await leadsPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS phone_leads_channel_user_id_uidx
      ON phone_leads (channel, user_id)
  `)

  console.log('Phone-leads database ready' + (process.env.LEADS_DATABASE_URL ? ' (separate DB)' : ' (shared with main DB)'))
}

async function getOrCreateConversation(channel, userId) {
  if (!pool) return null

  const normalizedUserId = String(userId)
  // Reuse the same conversation for this channel + user forever (until retention deletes it).
  const existing = await pool.query(
    `SELECT id
     FROM conversations
     WHERE channel = $1 AND user_id = $2
     LIMIT 1`,
    [channel, normalizedUserId],
  )

  if (existing.rows[0]) {
    await pool.query(
      `UPDATE conversations
       SET last_activity_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id],
    )
    return existing.rows[0].id
  }

  const id = randomUUID()
  try {
    const result = await pool.query(
      `INSERT INTO conversations (id, channel, user_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [id, channel, normalizedUserId],
    )
    return result.rows[0].id
  } catch (error) {
    // Race: another request created it first — reuse that row.
    if (error.code === '23505') {
      const raced = await pool.query(
        `UPDATE conversations
         SET last_activity_at = NOW()
         WHERE channel = $1 AND user_id = $2
         RETURNING id`,
        [channel, normalizedUserId],
      )
      if (raced.rows[0]) return raced.rows[0].id
    }
    throw error
  }
}

async function recordConversationMessage({
  channel,
  userId,
  direction,
  messageType = 'text',
  content = null,
  metadata = {},
}) {
  if (!pool) return null

  const conversationId = await getOrCreateConversation(channel, userId)
  await pool.query(
    `INSERT INTO conversation_messages
       (id, conversation_id, direction, message_type, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      conversationId,
      direction,
      messageType,
      content,
      JSON.stringify(metadata),
    ],
  )

  if (direction === 'incoming') {
    // New user activity resets the one-time reminder for this silence period.
    await pool.query(
      `UPDATE conversations
       SET last_incoming_at = NOW(),
           reminder_sent_at = NULL
       WHERE id = $1`,
      [conversationId],
    )
  }

  return conversationId
}

async function recordThreadMessage({
  conversationId,
  direction,
  messageType = 'text',
  content = null,
  metadata = {},
}) {
  if (!pool) return

  const result = await pool.query(
    `UPDATE conversations
     SET last_activity_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [conversationId],
  )

  if (result.rowCount === 0) {
    const error = new Error('Conversation not found or expired')
    error.code = 'CONVERSATION_NOT_FOUND'
    throw error
  }

  await pool.query(
    `INSERT INTO conversation_messages
       (id, conversation_id, direction, message_type, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      conversationId,
      direction,
      messageType,
      content,
      JSON.stringify(metadata),
    ],
  )
}

async function deleteExpiredConversations() {
  if (!pool) return 0

  await pool.query(
    `DELETE FROM webhook_events
     WHERE created_at < NOW() - INTERVAL '2 days'`,
  )

  const result = await pool.query(
    `DELETE FROM conversations
     WHERE last_activity_at < NOW() - ($1::double precision * INTERVAL '1 day')`,
    [RETENTION_DAYS],
  )

  if (result.rowCount > 0) {
    console.log(`Deleted ${result.rowCount} expired conversation(s)`)
  }
  return result.rowCount
}

async function claimDueReminderConversations({
  reminderHours = DEFAULT_REMINDER_HOURS,
  limit = 50,
} = {}) {
  if (!pool) return []

  const hours = Number(reminderHours)
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REMINDER_HOURS

  const result = await pool.query(
    `UPDATE conversations
     SET reminder_sent_at = NOW()
     WHERE id IN (
       SELECT id
       FROM conversations
       WHERE reminder_sent_at IS NULL
         AND last_incoming_at IS NOT NULL
         AND channel IN ('page', 'instagram')
         AND last_incoming_at <= NOW() - ($1::double precision * INTERVAL '1 hour')
         AND last_incoming_at > NOW() - ($2::double precision * INTERVAL '1 hour')
       ORDER BY last_incoming_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     )
     RETURNING id, channel, user_id, page_id, last_incoming_at`,
    [safeHours, META_MESSAGING_WINDOW_HOURS, limit],
  )

  return result.rows
}

async function clearReminderSent(conversationId) {
  if (!pool) return

  await pool.query(
    `UPDATE conversations
     SET reminder_sent_at = NULL
     WHERE id = $1`,
    [conversationId],
  )
}

async function releaseWebhookEvent(channel, eventKey) {
  if (!pool || !eventKey) return

  await pool.query(
    'DELETE FROM webhook_events WHERE channel = $1 AND event_key = $2',
    [channel, String(eventKey)],
  )
}

async function claimWebhookEvent(channel, eventKey) {
  if (!pool || !eventKey) return true

  try {
    await pool.query(
      `INSERT INTO webhook_events (channel, event_key)
       VALUES ($1, $2)`,
      [channel, String(eventKey)],
    )
    return true
  } catch (error) {
    if (error.code === '23505') return false
    throw error
  }
}

async function getRecentOutgoingTexts(channel, userId, { limit = 30 } = {}) {
  if (!pool) return []

  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100))
  const result = await pool.query(
    `SELECT m.content
     FROM conversation_messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel = $1
       AND c.user_id = $2
       AND m.direction = 'outgoing'
       AND m.message_type = 'text'
       AND m.content IS NOT NULL
       AND TRIM(m.content) <> ''
     ORDER BY m.created_at DESC
     LIMIT $3`,
    [channel, String(userId), safeLimit],
  )

  return result.rows.map(row => row.content)
}

const memoryTracks = new Map()

async function setProgramTrack(channel, userId, track) {
  const key = `${channel}:${userId}`
  memoryTracks.set(key, track)
  if (memoryTracks.size > 10000) memoryTracks.delete(memoryTracks.keys().next().value)
  if (!pool) return

  const conversationId = await getOrCreateConversation(channel, userId)
  await pool.query(
    'UPDATE conversations SET program_track = $2 WHERE id = $1',
    [conversationId, track],
  )
}

// Remembers which Facebook page a conversation belongs to (needed to pick the right token for reminders).
const memoryPages = new Map()

async function setConversationPage(channel, userId, pageId) {
  const key = `${channel}:${userId}`
  if (memoryPages.get(key) === pageId) return
  memoryPages.set(key, pageId)
  if (memoryPages.size > 10000) memoryPages.delete(memoryPages.keys().next().value)
  if (!pool) return

  await pool.query(
    'UPDATE conversations SET page_id = $3 WHERE channel = $1 AND user_id = $2',
    [channel, String(userId), pageId],
  )
}

async function getProgramTrack(channel, userId) {
  const key = `${channel}:${userId}`
  if (memoryTracks.has(key)) return memoryTracks.get(key)
  if (!pool) return null

  const result = await pool.query(
    `SELECT program_track FROM conversations
     WHERE channel = $1 AND user_id = $2
     LIMIT 1`,
    [channel, String(userId)],
  )
  const track = result.rows[0]?.program_track || null
  if (track) memoryTracks.set(key, track)
  return track
}

// Atomically claims the one-time "ask for phone number" prompt for a user.
// Returns true for the FIRST call only; every later call returns false, so the
// question is sent exactly once per (channel, user) even across restarts and
// concurrent messages. When there is no database, falls back to an in-memory set
// (best-effort, per-process).
const memoryPhoneAsked = new Set()

async function claimPhoneAsk(channel, userId) {
  const key = `${channel}:${userId}`
  if (!pool) {
    if (memoryPhoneAsked.has(key)) return false
    memoryPhoneAsked.add(key)
    if (memoryPhoneAsked.size > 10000) memoryPhoneAsked.delete(memoryPhoneAsked.values().next().value)
    return true
  }

  const conversationId = await getOrCreateConversation(channel, userId)
  if (!conversationId) return false

  const result = await pool.query(
    `UPDATE conversations
     SET phone_asked_at = NOW()
     WHERE id = $1 AND phone_asked_at IS NULL
     RETURNING id`,
    [conversationId],
  )
  return result.rowCount > 0
}

// Atomically claims the one-time greeting for a user. Returns true for the FIRST
// call only, so the greeting text is sent exactly once per (channel, user), even
// across restarts and concurrent messages. In-memory fallback when there is no DB.
const memoryGreetingSent = new Set()

async function claimGreetingSent(channel, userId) {
  const key = `${channel}:${userId}`
  if (!pool) {
    if (memoryGreetingSent.has(key)) return false
    memoryGreetingSent.add(key)
    if (memoryGreetingSent.size > 10000) memoryGreetingSent.delete(memoryGreetingSent.values().next().value)
    return true
  }

  const conversationId = await getOrCreateConversation(channel, userId)
  if (!conversationId) return false

  const result = await pool.query(
    `UPDATE conversations
     SET greeting_sent_at = NOW()
     WHERE id = $1 AND greeting_sent_at IS NULL
     RETURNING id`,
    [conversationId],
  )
  return result.rowCount > 0
}

// Saves a phone-number lead. Upserts on (channel, user_id): a later submission
// overwrites the stored number and program for that user. fb_name is optional.
async function savePhoneLead({ channel, userId, phone, programTrack = null, fbName = null }) {
  if (!leadsPool) return false

  await leadsPool.query(
    `INSERT INTO phone_leads (channel, user_id, phone, program_track, fb_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel, user_id)
     DO UPDATE SET
       phone = EXCLUDED.phone,
       program_track = COALESCE(EXCLUDED.program_track, phone_leads.program_track),
       fb_name = COALESCE(EXCLUDED.fb_name, phone_leads.fb_name),
       updated_at = NOW()`,
    [channel, String(userId), phone, programTrack, fbName],
  )
  return true
}

module.exports = {
  initializeDatabase,
  setProgramTrack,
  getProgramTrack,
  claimPhoneAsk,
  claimGreetingSent,
  savePhoneLead,
  setConversationPage,
  getOrCreateConversation,
  recordConversationMessage,
  recordThreadMessage,
  claimDueReminderConversations,
  clearReminderSent,
  claimWebhookEvent,
  releaseWebhookEvent,
  getRecentOutgoingTexts,
  DEFAULT_REMINDER_HOURS,
}
