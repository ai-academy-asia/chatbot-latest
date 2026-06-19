const express = require('express')
const cors = require('cors')
const { v4: uuidv4 } = require('uuid')
require('dotenv').config()

const app = express()

app.use(cors({
  origin: ['https://www.ai-academy.asia', 'https://ai-academy.asia'],
}))

// Facebook sends raw JSON — keep this BEFORE express.json() for webhook POST
app.use('/webhook', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf
  },
}))

app.use(express.json())

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN

// ── Health ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

// ── Facebook Webhook VERIFY (Meta "Verify and save") ─
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  console.log('Webhook verify:', { mode, token })

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified OK')
    return res.status(200).send(challenge)
  }

  console.log('Webhook verify FAILED')
  return res.sendStatus(403)
})

// ── Facebook Webhook EVENTS (incoming messages) ─────
app.post('/webhook', (req, res) => {
  const body = req.body

  // Meta requires 200 quickly — always respond first
  res.sendStatus(200)

  if (body.object !== 'page') return

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message && event.message.text) {
        const senderId = event.sender.id
        const text = event.message.text
        console.log(`Message from ${senderId}: ${text}`)

        // TODO: call your AI logic here, then reply via Graph API
        // replyToUser(senderId, 'Сайн уу!')
      }
    }
  }
})

// ── Your existing chat API (unchanged) ──────────────
app.post('/api/chat/create', (req, res) => {
  res.json({ success: true, threadId: uuidv4() })
})

app.post('/api/chat/message', (req, res) => {
  const { message } = req.body
  res.json({
    success: true,
    response: {
      messageId: uuidv4(),
      content: `Та "${message}" гэж бичлээ.`,
    },
  })
})

const port = process.env.PORT || 8010
app.listen(port, '0.0.0.0', () => {
  console.log(`Running on port ${port}`)
})