const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

const RETENTION_DAYS = 3
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

    CREATE INDEX IF NOT EXISTS conversation_messages_conversation_created_idx
      ON conversation_messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS conversations_last_activity_idx
      ON conversations (last_activity_at);
    CREATE INDEX IF NOT EXISTS conversations_reminder_due_idx
      ON conversations (last_incoming_at)
      WHERE reminder_sent_at IS NULL AND last_incoming_at IS NOT NULL;
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

  console.log(`Conversation database ready (${RETENTION_DAYS}-day inactivity retention)`)
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
     RETURNING id, channel, user_id, last_incoming_at`,
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

module.exports = {
  initializeDatabase,
  getOrCreateConversation,
  recordConversationMessage,
  recordThreadMessage,
  claimDueReminderConversations,
  clearReminderSent,
  DEFAULT_REMINDER_HOURS,
}
