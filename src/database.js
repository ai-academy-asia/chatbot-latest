const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

const RETENTION_DAYS = 3
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

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

    CREATE INDEX IF NOT EXISTS conversation_messages_conversation_created_idx
      ON conversation_messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS conversations_last_activity_idx
      ON conversations (last_activity_at);
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

  const id = randomUUID()
  const result = await pool.query(
    `INSERT INTO conversations (id, channel, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel, user_id)
     DO UPDATE SET last_activity_at = NOW()
     RETURNING id`,
    [id, channel, String(userId)],
  )

  return result.rows[0].id
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

module.exports = {
  initializeDatabase,
  getOrCreateConversation,
  recordConversationMessage,
  recordThreadMessage,
}
