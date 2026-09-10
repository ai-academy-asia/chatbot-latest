const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { GEMINI_MODEL, OUTPUT_DIMENSION, embedText, embedTexts } = require('./gemini-embeddings')

const CHUNKS_PATH = path.join(__dirname, '..', 'data', 'rag-chunks.json')
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GENERATE_MODEL = process.env.GEMINI_GENERATE_MODEL || 'gemini-2.5-flash'

let pool = null
let indexPromise = null
let cachedIndex = null

function readChunkSource() {
  const raw = fs.readFileSync(CHUNKS_PATH, 'utf8')
  const data = JSON.parse(raw)
  const sourceHash = crypto.createHash('sha256').update(raw).digest('hex')
  if (!Array.isArray(data.chunks) || !data.chunks.length) {
    throw new Error('No RAG chunks found in data/rag-chunks.json')
  }
  return { chunks: data.chunks, sourceHash }
}

function cosineSimilarity(left, right) {
  let score = 0
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index]
  }
  return score
}

function toVectorLiteral(values) {
  return `[${values.join(',')}]`
}

async function initializeRag(dbPool) {
  pool = dbPool
  if (!pool) {
    console.warn('DATABASE_URL is not set — RAG storage is disabled')
    return
  }

  let usePgvector = false
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    usePgvector = true
  } catch (error) {
    console.warn(`pgvector unavailable (${error.message}) — storing embeddings as float arrays`)
  }

  if (usePgvector) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        program TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding vector(${OUTPUT_DIMENSION}) NOT NULL,
        source_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  } else {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        program TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding DOUBLE PRECISION[] NOT NULL,
        source_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS rag_chunks_category_idx ON rag_chunks (category);
    CREATE INDEX IF NOT EXISTS rag_chunks_program_idx ON rag_chunks (program);
  `)

  pool.__ragUsePgvector = usePgvector
}

async function loadIndexFromDb(sourceHash) {
  const result = await pool.query(
    `SELECT id, category, program, title, content, embedding, source_hash, model
     FROM rag_chunks
     ORDER BY id`,
  )

  if (!result.rows.length) return null

  const allMatch = result.rows.every(row =>
    row.source_hash === sourceHash && row.model === GEMINI_MODEL)

  if (!allMatch) return null

  return {
    sourceHash,
    model: GEMINI_MODEL,
    usePgvector: Boolean(pool.__ragUsePgvector),
    items: result.rows.map(row => ({
      id: row.id,
      category: row.category,
      program: row.program,
      title: row.title,
      content: row.content,
      embedding: Array.isArray(row.embedding)
        ? row.embedding.map(Number)
        : String(row.embedding)
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(Number),
    })),
  }
}

async function rebuildIndex(chunks, sourceHash) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const texts = chunks.map(chunk => `${chunk.title}\n${chunk.content}`)
  const vectors = await embedTexts(texts, apiKey, 'RETRIEVAL_DOCUMENT')
  const usePgvector = Boolean(pool.__ragUsePgvector)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM rag_chunks')

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      const embedding = vectors[index]

      if (usePgvector) {
        await client.query(
          `INSERT INTO rag_chunks
            (id, category, program, title, content, embedding, source_hash, model)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
          [
            chunk.id,
            chunk.category,
            chunk.program,
            chunk.title,
            chunk.content,
            toVectorLiteral(embedding),
            sourceHash,
            GEMINI_MODEL,
          ],
        )
      } else {
        await client.query(
          `INSERT INTO rag_chunks
            (id, category, program, title, content, embedding, source_hash, model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            chunk.id,
            chunk.category,
            chunk.program,
            chunk.title,
            chunk.content,
            embedding,
            sourceHash,
            GEMINI_MODEL,
          ],
        )
      }
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return {
    sourceHash,
    model: GEMINI_MODEL,
    usePgvector,
    items: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: vectors[index],
    })),
  }
}

async function ensureIndex() {
  if (!pool) throw new Error('RAG is not initialized')

  if (!indexPromise) {
    indexPromise = (async () => {
      const { chunks, sourceHash } = readChunkSource()
      const existing = await loadIndexFromDb(sourceHash)
      cachedIndex = existing || await rebuildIndex(chunks, sourceHash)
      return cachedIndex
    })().catch(error => {
      indexPromise = null
      cachedIndex = null
      throw error
    })
  }

  return indexPromise
}

const REFUSAL_SNIPPET = 'нарийн мэдээлэл алга'

function formatChunkAnswer(hits) {
  const top = hits.slice(0, 2)
  if (top.length === 1) return top[0].content
  return top.map(hit => hit.content).join('\n\n')
}

function isRefusalAnswer(text) {
  return typeof text === 'string' && text.toLowerCase().includes(REFUSAL_SNIPPET)
}

async function retrieveRag(text, options = {}) {
  const topK = Number(options.topK || process.env.RAG_TOP_K || 4)
  const minimumScore = Number(options.minScore || process.env.RAG_MIN_SIMILARITY || 0.5)
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const index = await ensureIndex()
  const queryEmbedding = await embedText(text, apiKey, 'RETRIEVAL_QUERY')

  const ranked = index.items
    .map(item => ({
      id: item.id,
      category: item.category,
      program: item.program,
      title: item.title,
      content: item.content,
      score: cosineSimilarity(queryEmbedding, item.embedding),
    }))
    .sort((left, right) => right.score - left.score)

  return ranked.filter(item => item.score >= minimumScore).slice(0, topK)
}

async function generateRagAnswer(question, hits) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const context = hits
    .map((hit, index) => `[${index + 1}] ${hit.title}\n${hit.content}`)
    .join('\n\n')

  const prompt = `Та AI Academy Asia-ийн Messenger чатбот.
Доорх CONTEXT-д байгаа холбоотой мэдээллийг ашиглаж QUESTION-д товч, найрсаг монгол хариулт өг.
CONTEXT-ийн мэдээллийг шууд ашигла — үнэ, хуваарь, хаяг, ур чадвар зэргийг орхигдуулж болохгүй.
URL байвал хариултад үлдээ.
Зөвхөн CONTEXT-тай ОГТ холбоогүй асуултад л дараах өгүүлбэрийг хэл:
"Энэ талаар нарийн мэдээлэл алга. Цэснээс сонгох эсвэл 7505-1055 руу холбогдоорой."

QUESTION:
${question}

CONTEXT:
${context}`

  const response = await fetch(
    `${GEMINI_API_BASE}/models/${GENERATE_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      }),
      signal: AbortSignal.timeout(30000),
    },
  )

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`Gemini generate failed (${response.status}): ${details}`)
  }

  const data = await response.json()
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter(part => part.text && !part.thought)
    ?.map(part => part.text)
    .join('')
    .trim()

  if (!text) {
    return formatChunkAnswer(hits)
  }

  return text
}

async function answerWithRag(question) {
  const hits = await retrieveRag(question)
  if (!hits.length) return null

  const chunkAnswer = formatChunkAnswer(hits)
  const trustChunks = hits[0].score >= Number(process.env.RAG_TRUST_SCORE || 0.58)

  let answer
  try {
    answer = await generateRagAnswer(question, hits)
    // Model sometimes refuses even when retrieval is clearly relevant — use chunks.
    if (isRefusalAnswer(answer) && trustChunks) {
      answer = chunkAnswer
    }
  } catch (error) {
    console.error('RAG generate failed, falling back to chunks:', error.message)
    answer = chunkAnswer
  }

  return {
    answer,
    hits: hits.map(hit => ({
      id: hit.id,
      title: hit.title,
      score: hit.score,
      category: hit.category,
      program: hit.program,
    })),
  }
}

function warmRag() {
  if (!pool) return Promise.resolve()
  return ensureIndex()
}

module.exports = {
  initializeRag,
  ensureIndex,
  retrieveRag,
  answerWithRag,
  warmRag,
}
