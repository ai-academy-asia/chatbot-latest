const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { GEMINI_MODEL, OUTPUT_DIMENSION, embedText, embedTexts } = require('./gemini-embeddings')

const INTENTS_PATH = path.join(__dirname, '..', 'data', 'intents.json')
const INDEX_PATH = path.join(__dirname, '..', 'data', 'intent-embeddings.json')

let indexPromise

function readIntentSource() {
  const raw = fs.readFileSync(INTENTS_PATH, 'utf8')
  const data = JSON.parse(raw)
  const sourceHash = crypto.createHash('sha256').update(raw).digest('hex')
  return { data, sourceHash }
}

function readCachedIndex(sourceHash) {
  if (!fs.existsSync(INDEX_PATH)) return null

  const cached = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
  if (
    cached.sourceHash !== sourceHash ||
    cached.model !== GEMINI_MODEL ||
    cached.dimension !== OUTPUT_DIMENSION
  ) {
    return null
  }

  return cached
}

async function buildIndex(data, sourceHash) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const examples = data.intents.flatMap(intent =>
    intent.examples
      .filter(example => typeof example === 'string' && example.trim())
      .map(example => ({
        intentId: intent.id,
        text: example.trim(),
      }))
  )

  if (!examples.length) {
    throw new Error('No intent examples found in data/intents.json')
  }

  const vectors = await embedTexts(examples.map(example => example.text), apiKey)
  const index = {
    model: GEMINI_MODEL,
    dimension: OUTPUT_DIMENSION,
    sourceHash,
    generatedAt: new Date().toISOString(),
    items: examples.map((example, position) => ({
      ...example,
      embedding: vectors[position],
    })),
  }

  fs.writeFileSync(INDEX_PATH, `${JSON.stringify(index)}\n`)
  return index
}

async function ensureIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const { data, sourceHash } = readIntentSource()
      return readCachedIndex(sourceHash) || buildIndex(data, sourceHash)
    })().catch(error => {
      indexPromise = null
      throw error
    })
  }

  return indexPromise
}

function cosineSimilarity(left, right) {
  let score = 0
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index]
  }
  return score
}

async function classifyIntent(text) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const index = await ensureIndex()
  const queryEmbedding = await embedText(text, apiKey)
  const bestByIntent = new Map()

  for (const item of index.items) {
    const score = cosineSimilarity(queryEmbedding, item.embedding)
    const current = bestByIntent.get(item.intentId)
    if (!current || score > current.score) {
      bestByIntent.set(item.intentId, { score, matchedExample: item.text })
    }
  }

  const ranked = [...bestByIntent.entries()]
    .map(([intentId, match]) => ({ intentId, ...match }))
    .sort((left, right) => right.score - left.score)

  const best = ranked[0]
  const runnerUp = ranked[1]
  if (!best) return null

  const minimumScore = Number(process.env.INTENT_MIN_SIMILARITY || 0.7)
  const minimumMargin = Number(process.env.INTENT_MIN_MARGIN || 0.02)
  const margin = best.score - (runnerUp?.score || 0)

  if (best.score < minimumScore || margin < minimumMargin) return null

  const { data } = readIntentSource()
  const intent = data.intents.find(item => item.id === best.intentId)
  if (!intent?.answers?.default) return null

  return {
    intentId: best.intentId,
    answer: intent.answers.default,
    score: best.score,
    margin,
    matchedExample: best.matchedExample,
  }
}

function warmIntentClassifier() {
  return ensureIndex()
}

module.exports = {
  classifyIntent,
  warmIntentClassifier,
}
