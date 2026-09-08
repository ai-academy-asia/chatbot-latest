const GEMINI_MODEL = 'gemini-embedding-001'
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const OUTPUT_DIMENSION = 768
const BATCH_SIZE = 100

function normalizeVector(values) {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!magnitude) return values
  return values.map(value => value / magnitude)
}

async function geminiRequest(path, body, apiKey, attempt = 0) {
  const response = await fetch(`${GEMINI_API_BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })

  if (!response.ok) {
    const details = await response.text()
    const canRetry = response.status === 429 || response.status >= 500

    if (canRetry && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)))
      return geminiRequest(path, body, apiKey, attempt + 1)
    }

    throw new Error(`Gemini embedding failed (${response.status}): ${details}`)
  }

  return response.json()
}

function embeddingRequest(text) {
  return {
    model: `models/${GEMINI_MODEL}`,
    content: {
      parts: [{ text }],
    },
    taskType: 'CLASSIFICATION',
    outputDimensionality: OUTPUT_DIMENSION,
  }
}

async function embedText(text, apiKey) {
  const data = await geminiRequest(
    `models/${GEMINI_MODEL}:embedContent`,
    embeddingRequest(text),
    apiKey,
  )

  return normalizeVector(data.embedding.values)
}

async function embedTexts(texts, apiKey) {
  const embeddings = []

  for (let index = 0; index < texts.length; index += BATCH_SIZE) {
    const batch = texts.slice(index, index + BATCH_SIZE)
    const data = await geminiRequest(
      `models/${GEMINI_MODEL}:batchEmbedContents`,
      { requests: batch.map(embeddingRequest) },
      apiKey,
    )

    embeddings.push(...data.embeddings.map(item => normalizeVector(item.values)))
  }

  return embeddings
}

module.exports = {
  GEMINI_MODEL,
  OUTPUT_DIMENSION,
  embedText,
  embedTexts,
}
