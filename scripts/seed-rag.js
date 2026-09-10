require('dotenv').config()

const { initializeDatabase } = require('../src/database')
const { ensureIndex, retrieveRag } = require('../src/rag')

async function main() {
  await initializeDatabase()
  const index = await ensureIndex()
  console.log(`RAG indexed ${index.items.length} chunks (model=${index.model})`)

  const probe = process.argv[2] || 'төлбөр хэд вэ'
  const hits = await retrieveRag(probe)
  console.log('Probe:', probe)
  console.log(hits.map(hit => ({
    id: hit.id,
    score: Number(hit.score.toFixed(3)),
    title: hit.title,
  })))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
