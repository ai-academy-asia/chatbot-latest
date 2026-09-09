require('dotenv').config()

const express = require('express')
const cors = require('cors')
const path = require('node:path')
const { readFile } = require('node:fs/promises')
const { randomUUID: uuidv4 } = require('node:crypto')
const { classifyIntent, warmIntentClassifier } = require('./intent-classifier')
const {
  initializeDatabase,
  getOrCreateConversation,
  recordConversationMessage,
  recordThreadMessage,
} = require('./database')

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
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN
const META_API_VERSION = process.env.META_API_VERSION || 'v25.0'
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://ai-academy.asia/chatbot-api').replace(/\/$/, '')

const SILENT_MESSAGES = new Set([
  'AI Agents хөтөлбөр яг юу заах вэ?',
  'AI for Business хөтөлбөр ямар бодит үр дүн өгөх вэ?',
  'Сургалт ямар хуваарьтай, ямар форматаар хичээллэх вэ? IT эсвэл код бичих урьдчилсан мэдлэг шаардлагатай юу?',
])

const BROCHURES = new Map([
  ['AI-Agents-brochure.pdf', path.join(__dirname, '..', 'AI-Agents-brochure.pdf')],
  ['AI-for-Business-brochure.pdf', path.join(__dirname, '..', 'AI-for-Business-brochure.pdf')],
])

const PROGRAM_BROCHURES = {
  PROGRAM_AI_AGENTS: 'AI-Agents-brochure.pdf',
  PROGRAM_AI_BUSINESS: 'AI-for-Business-brochure.pdf',
}

const BROCHURE_INTENTS = new Set([
  'surgaltiin_medeelel',
  'result',
  'curriculum',
  'program_recommendation',
])
const BROCHURE_INTRO = '📄 Та дараах брошуртай танилцана уу.'

const brochureAttachmentIds = new Map()

const MAIN_MENU_OPTIONS = [
  { title: '🤖 AI Agents', payload: 'PROGRAM_AI_AGENTS' },
  { title: '💼 AI for Business', payload: 'PROGRAM_AI_BUSINESS' },
  { title: '✨ Бусад мэдээлэл', payload: 'MORE_OPTIONS' },
]

const MORE_MENU_OPTIONS = [
  { title: '💳 Төлбөр', payload: 'PAYMENT' },
  { title: '📍 Хаяг байршил', payload: 'LOCATION' },
  { title: '📝 Бүртгүүлэх', payload: 'REGISTER' },
]

const PROGRAM_ACTION_OPTIONS = [
  { title: '💳 Төлбөр', payload: 'PAYMENT' },
  { title: '📝 Бүртгүүлэх', payload: 'REGISTER' },
  { title: '🏠 Үндсэн цэс', payload: 'MAIN_MENU' },
]

const DETAIL_ACTION_OPTIONS = [
  { title: '📝 Бүртгүүлэх', payload: 'REGISTER' },
  { title: '🏠 Үндсэн цэс', payload: 'MAIN_MENU' },
]

const MENU_RESPONSES = {
  PROGRAM_AI_AGENTS: `🧡 AI AGENTS

“2 өдөр хийдэг ажлаа 3 минутад хийдэг болгоно.”

🎯 ХӨТӨЛБӨРИЙН ЗОРИЛГО

AI Agents хөтөлбөрөөр та AI-г зүгээр нэг асуулт асуудаг хэрэгсэл биш, харин таны ажлыг өөрөө гүйцэтгэдэг AI туслах системийг бүтээж сурна.

PDF, Excel, тайлан, имэйл, маягттай холбоотой давтагддаг ажлуудаа автоматжуулна.

🛠 ЭЗЭМШИХ УР ЧАДВАР

• Баримт бичиг уншиж, дүн шинжилгээ хийх
• Excel дата цэвэрлэх, нэгтгэх, шалгах
• Давтагддаг ажлаа Skill болгон хувиргах
• Өдөр бүр автоматаар ажиллах AI Agent бүтээх
• Олон PDF, Excel файл дээр ажиллах скрипт бүтээх
• Форм, имэйлээс мэдээлэл цуглуулах автомат урсгал үүсгэх
• Өөрийн хэрэгцээнд тохирсон AI workflow бүтээх
• Бүтээсэн системээ Capstone төслөөр хамгаалах

🌱 Суурь мэдлэг

Кодчилолын суурь мэдлэг шаардалагагүй.

🏆 ТӨГСӨХДӨӨ

Өдөр тутмын ажилдаа шууд ашиглах AI Agent-ийг бүтээж сурна.

📌 СУРГАЛТЫН МЭДЭЭЛЭЛ

📅 Эхлэх: 2026.09.25
⏱ 6 долоо хоног · 12 хичээл
🗓 Даваа, Лхагва · 12:00–13:30
💻 Танхим + онлайн хосолсон
💰 2,880,000₮

${BROCHURE_INTRO}`,
  PROGRAM_AI_BUSINESS: `💚 AI FOR BUSINESS

Сошиал контент, чат, захиалгын 24/7 автомат систем бүтээх хөтөлбөр.

🎯 Эзэмших ур чадвар

• Facebook контент бэлтгэх
• Хэрэглэгчийн чатад автоматаар хариулах
• Захиалга бүртгэх
• Бүтэн цикл бүхий автомат систем угсрах
• Удирдлагын админ самбар бүтээх

🛠 АШИГЛАХ ТЕХНОЛОГИ ХЭРЭГСЛҮҮД

Facebook API · Meta for Developers · n8n · Supabase · Vibe Coding

🗓 Мягмар, Пүрэв · 07:30–09:00
🎥 12 лайв хичээл
🏫 Офлайн воркшоп

💡 23:41 цагт ирсэн чат маргааш өглөөг хүлээхгүй — таны борлуулалтын систем 24/7 ажиллана.

${BROCHURE_INTRO}`,
  PAYMENT: `💳 СУРГАЛТЫН ТӨЛБӨР

💰 20% хөнгөлөлттэй үнэ: 2,880,000₮
🛍 Storepay-ээр хуваан төлөх боломжтой.`,
  LOCATION: `📍 ХАЯГ, БАЙРШИЛ

СБД, 1-р хороо,
Олимпийн гудамж-15,
ITC Tower, 11 давхар

☎️ Утас: 7505-1055`,
  REGISTER: `📝 БҮРТГЭЛ

Бүртгүүлэх холбоос:
https://www.ai-academy.asia/ai-acceleration.html#register`,
}

if (!VERIFY_TOKEN) {
  console.error('FB_VERIFY_TOKEN is not set — webhook verification will fail')
}

async function validateInstagramConnection() {
  if (!IG_ACCESS_TOKEN) {
    console.error('Instagram startup check failed: IG_ACCESS_TOKEN is not set')
    return
  }

  const headers = { Authorization: `Bearer ${IG_ACCESS_TOKEN}` }
  const [identityResponse, subscriptionsResponse] = await Promise.all([
    fetch(`https://graph.instagram.com/${META_API_VERSION}/me?fields=id,username`, { headers }),
    fetch(`https://graph.instagram.com/${META_API_VERSION}/me/subscribed_apps`, { headers }),
  ])

  const identity = await identityResponse.json()
  const subscriptions = await subscriptionsResponse.json()

  if (!identityResponse.ok) {
    console.error('Instagram token validation failed:', {
      status: identityResponse.status,
      code: identity.error?.code || null,
      message: identity.error?.message || 'Unknown error',
    })
    return
  }

  if (!subscriptionsResponse.ok) {
    console.error('Instagram subscription check failed:', {
      status: subscriptionsResponse.status,
      code: subscriptions.error?.code || null,
      message: subscriptions.error?.message || 'Unknown error',
    })
    return
  }

  const subscribedFields = [
    ...new Set((subscriptions.data || []).flatMap(item => item.subscribed_fields || [])),
  ]

  console.log('Instagram connection ready:', {
    accountId: identity.id,
    username: identity.username || null,
    subscribedFields,
    postbacksEnabled: subscribedFields.includes('messaging_postbacks'),
  })
}

function getChannelConfig(object) {
  if (object === 'page') {
    return {
      accessToken: FB_PAGE_ACCESS_TOKEN,
      apiBase: 'https://graph.facebook.com',
    }
  }

  if (object === 'instagram') {
    return {
      accessToken: IG_ACCESS_TOKEN,
      apiBase: 'https://graph.instagram.com',
    }
  }

  return null
}

async function sendMetaMessage(object, recipientId, message) {
  const channel = getChannelConfig(object)

  if (!channel) return
  if (!channel.accessToken) {
    throw new Error(`${object === 'page' ? 'FB_PAGE_ACCESS_TOKEN' : 'IG_ACCESS_TOKEN'} is not set`)
  }

  const body = {
    recipient: { id: recipientId },
    message,
  }

  if (object === 'page') {
    body.messaging_type = 'RESPONSE'
  }

  console.log('Sending Meta reply:', {
    channel: object,
    recipientId,
    type: message.text ? 'text' : message.attachment?.type || 'unknown',
    preview: message.text?.slice(0, 100) || message.attachment?.payload?.template_type || null,
  })

  const response = await fetch(`${channel.apiBase}/${META_API_VERSION}/me/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channel.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`${object} send failed (${response.status}): ${error}`)
  }

  const result = await response.json()
  console.log('Meta reply sent:', {
    channel: object,
    recipientId,
    messageId: result.message_id || null,
  })

  const messageType = message.text
    ? 'text'
    : message.attachment?.payload?.template_type || message.attachment?.type || 'unknown'
  const content = message.text
    || message.attachment?.payload?.elements?.[0]?.title
    || (message.attachment?.type ? `[${message.attachment.type}]` : null)

  await recordConversationMessage({
    channel: object,
    userId: recipientId,
    direction: 'outgoing',
    messageType,
    content,
    metadata: { metaMessageId: result.message_id || null },
  })
}

function splitMessage(text, maxLength = 900) {
  const chunks = []
  let remaining = text.trim()

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt < maxLength / 2) splitAt = remaining.lastIndexOf(' ', maxLength)
    if (splitAt < 1) splitAt = maxLength

    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

async function sendMenuCard(object, recipientId, title, subtitle, options) {
  await sendMetaMessage(object, recipientId, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'generic',
        elements: [{
          title,
          subtitle,
          buttons: options.map(option => ({
            type: 'postback',
            title: option.title,
            payload: option.payload,
          })),
        }],
      },
    },
  })
}

async function sendWelcomeMenu(object, recipientId) {
  await sendMenuCard(
    object,
    recipientId,
    'Та ямар мэдээлэл авахыг хүсэж байна вэ?',
    undefined,
    MAIN_MENU_OPTIONS,
  )
}

async function sendMoreMenu(object, recipientId) {
  await sendMenuCard(
    object,
    recipientId,
    'Нэмэлт мэдээлэл',
    'Доорх сонголтоос сонгоно уу.',
    MORE_MENU_OPTIONS,
  )
}

async function sendProgramActions(object, recipientId) {
  await sendMenuCard(
    object,
    recipientId,
    'Та үргэлжлүүлэн юу мэдэхийг хүсэж байна вэ?',
    undefined,
    PROGRAM_ACTION_OPTIONS,
  )
}

async function sendDetailActions(object, recipientId) {
  await sendMenuCard(
    object,
    recipientId,
    'Бүртгүүлэх эсвэл үндсэн цэс рүү буцна уу.',
    undefined,
    DETAIL_ACTION_OPTIONS,
  )
}

async function uploadFacebookBrochure(filename) {
  const cachedAttachmentId = brochureAttachmentIds.get(filename)
  if (cachedAttachmentId) return cachedAttachmentId
  if (!FB_PAGE_ACCESS_TOKEN) throw new Error('FB_PAGE_ACCESS_TOKEN is not set')

  const brochurePath = BROCHURES.get(filename)
  if (!brochurePath) throw new Error(`Unknown brochure: ${filename}`)

  const file = await readFile(brochurePath)
  const form = new FormData()
  form.set('message', JSON.stringify({
    attachment: {
      type: 'file',
      payload: { is_reusable: true },
    },
  }))
  form.set('filedata', new Blob([file], { type: 'application/pdf' }), filename)

  const response = await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/me/message_attachments`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${FB_PAGE_ACCESS_TOKEN}` },
      body: form,
    },
  )

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Facebook brochure upload failed (${response.status}): ${error}`)
  }

  const result = await response.json()
  if (!result.attachment_id) throw new Error('Facebook brochure upload returned no attachment_id')

  brochureAttachmentIds.set(filename, result.attachment_id)
  return result.attachment_id
}

async function sendProgramBrochure(object, recipientId, payload) {
  const filename = PROGRAM_BROCHURES[payload]
  if (!filename) return

  if (object === 'page') {
    const attachmentId = await uploadFacebookBrochure(filename)
    await sendMetaMessage(object, recipientId, {
      attachment: {
        type: 'file',
        payload: { attachment_id: attachmentId },
      },
    })
    return
  }

  await sendMetaMessage(object, recipientId, {
    attachment: {
      type: 'file',
      payload: {
        url: `${PUBLIC_BASE_URL}/brochures/${encodeURIComponent(filename)}`,
        is_reusable: true,
      },
    },
  })
}

async function sendIntentAnswer(object, recipientId, prediction) {
  if (prediction.intentId === 'greeting') {
    await sendWelcomeMenu(object, recipientId)
    return
  }

  const answer = BROCHURE_INTENTS.has(prediction.intentId)
    ? prediction.answer.replace(
      /\n\n📄 (?:Мөн хөтөлбөрүүдийн брошуртай танилцаарай\.|Та дараах брошуртай танилцана уу\.)[\s\S]*$/,
      `\n\n${BROCHURE_INTRO}`,
    )
    : prediction.answer

  for (const chunk of splitMessage(answer)) {
    await sendMetaMessage(object, recipientId, { text: chunk })
  }

  if (BROCHURE_INTENTS.has(prediction.intentId)) {
    await sendProgramBrochure(object, recipientId, 'PROGRAM_AI_AGENTS')
    await sendProgramBrochure(object, recipientId, 'PROGRAM_AI_BUSINESS')
  }
}

async function handleMessagingEvent(object, event) {
  if (!event.sender) {
    console.warn('Messaging event ignored: missing sender', { channel: object })
    return
  }

  const message = event.message || event.message_edit
  const eventType = event.message_edit
    ? 'message_edit'
    : message
      ? message.is_echo
      ? 'echo'
      : message.is_deleted
        ? 'message_deleted'
        : 'message'
    : event.postback
      ? 'postback'
      : event.read
        ? 'read'
        : event.delivery
          ? 'delivery'
          : event.reaction
            ? 'reaction'
            : 'unknown'

  if (message?.is_echo) {
    console.log('Messaging event ignored: echo', {
      channel: object,
      senderId: event.sender.id,
    })
    return
  }

  if (!message && !event.postback) {
    console.log('Messaging event ignored: no actionable message', {
      channel: object,
      senderId: event.sender.id,
      eventType,
      eventKeys: Object.keys(event),
    })
    return
  }

  if (message?.is_deleted) {
    console.log('Messaging event ignored: deleted message', {
      channel: object,
      senderId: event.sender.id,
    })
    return
  }

  if (event.message_edit) {
    console.log('Messaging event ignored: message edit does not open reply window', {
      channel: object,
      senderId: event.sender.id,
      editCount: event.message_edit.num_edit ?? null,
      hasText: Boolean(event.message_edit.text),
    })
    return
  }

  const senderId = event.sender.id
  const payload = message?.quick_reply?.payload || event.postback?.payload

  console.log('Incoming user message:', {
    channel: object,
    senderId,
    eventType,
    text: message?.text || null,
    editCount: event.message_edit?.num_edit ?? null,
    payload: payload || null,
    attachments: message?.attachments?.map(attachment => attachment.type) || [],
    referral: event.referral || message?.referral || null,
    timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : null,
  })

  const incomingType = message?.text
    ? 'text'
    : event.postback
      ? 'postback'
      : message?.attachments?.[0]?.type || eventType
  const incomingContent = message?.text || payload || `[${incomingType}]`

  await recordConversationMessage({
    channel: object,
    userId: senderId,
    direction: 'incoming',
    messageType: incomingType,
    content: incomingContent,
    metadata: {
      metaMessageId: message?.mid || null,
      timestamp: event.timestamp || null,
      editCount: event.message_edit?.num_edit ?? null,
      attachmentTypes: message?.attachments?.map(attachment => attachment.type) || [],
    },
  })

  if (SILENT_MESSAGES.has(message?.text)) {
    console.log('Message intentionally ignored:', { channel: object, senderId })
    return
  }

  if (payload === 'MAIN_MENU' || payload === 'WELCOME_MESSAGE') {
    await sendWelcomeMenu(object, senderId)
    return
  }

  if (payload === 'MORE_OPTIONS') {
    await sendMoreMenu(object, senderId)
    return
  }

  if (payload && MENU_RESPONSES[payload]) {
    for (const chunk of splitMessage(MENU_RESPONSES[payload])) {
      await sendMetaMessage(object, senderId, { text: chunk })
    }

    if (payload === 'PROGRAM_AI_AGENTS' || payload === 'PROGRAM_AI_BUSINESS') {
      await sendProgramBrochure(object, senderId, payload)
      await sendProgramActions(object, senderId)
    } else if (payload === 'PAYMENT' || payload === 'LOCATION') {
      await sendDetailActions(object, senderId)
    }
    return
  }

  if (message?.text) {
    try {
      const prediction = await classifyIntent(message.text)

      if (prediction) {
        console.log('Intent detected:', {
          intent: prediction.intentId,
          score: prediction.score.toFixed(3),
          margin: prediction.margin.toFixed(3),
          matchedExample: prediction.matchedExample,
        })
        await sendIntentAnswer(object, senderId, prediction)
        return
      }
    } catch (error) {
      console.error('Intent classification failed:', error.message)
    }
  }

  if (message || event.postback) {
    await sendWelcomeMenu(object, senderId)
  }
}

// ── Health ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

// ── Public brochures used by Meta file attachments ──
app.get('/brochures/:filename', (req, res) => {
  const brochurePath = BROCHURES.get(req.params.filename)

  if (!brochurePath) return res.sendStatus(404)

  res.sendFile(brochurePath)
})

// ── Facebook Webhook VERIFY (Meta "Verify and save") ─
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  console.log('Webhook verify:', {
    mode,
    tokenSet: Boolean(token),
    envTokenSet: Boolean(VERIFY_TOKEN),
    tokenMatch: token === VERIFY_TOKEN,
  })

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified OK')
    return res.status(200).send(String(challenge))
  }

  console.log('Webhook verify FAILED', {
    reason: !VERIFY_TOKEN ? 'missing env token' : mode !== 'subscribe' ? 'bad mode' : 'token mismatch',
  })
  return res.sendStatus(403)
})

// ── Facebook and Instagram webhook events ───────────
app.post('/webhook', (req, res) => {
  const body = req.body

  // Meta requires 200 quickly — always respond first
  res.sendStatus(200)

  const entries = Array.isArray(body.entry) ? body.entry : []
  const messagingEventCount = entries.reduce(
    (count, entry) => count + (Array.isArray(entry.messaging) ? entry.messaging.length : 0),
    0,
  )

  console.log('Webhook delivery received:', {
    object: body.object || null,
    entryCount: entries.length,
    messagingEventCount,
  })

  if (!['page', 'instagram'].includes(body.object)) {
    console.warn('Webhook delivery ignored: unsupported object', {
      object: body.object || null,
    })
    return
  }

  for (const entry of entries) {
    for (const event of entry.messaging || []) {
      console.log(
        `${body.object} ${entry.id || 'unknown-page'} message from ${event.sender?.id || 'unknown'}`,
      )
      handleMessagingEvent(body.object, event).catch(error => {
        console.error('Webhook event handling failed:', error.message)
      })
    }
  }
})

// ── Website chat API ────────────────────────────────
app.post('/api/chat/create', async (req, res) => {
  try {
    const userId = req.body.userId || uuidv4()
    const conversationId = await getOrCreateConversation('web', userId)
    res.json({
      success: true,
      threadId: conversationId || uuidv4(),
      userId,
    })
  } catch (error) {
    console.error('Conversation creation failed:', error.message)
    res.status(500).json({ success: false, error: 'Could not create conversation' })
  }
})

app.post('/api/chat/message', async (req, res) => {
  const { threadId, message } = req.body

  if (!threadId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: 'threadId and message are required',
    })
  }

  try {
    await recordThreadMessage({
      conversationId: threadId,
      direction: 'incoming',
      content: message.trim(),
    })

    const response = {
      messageId: uuidv4(),
      content: `Та "${message.trim()}" гэж бичлээ.`,
    }

    await recordThreadMessage({
      conversationId: threadId,
      direction: 'outgoing',
      content: response.content,
      metadata: { messageId: response.messageId },
    })

    res.json({ success: true, response })
  } catch (error) {
    if (error.code === 'CONVERSATION_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: 'Conversation not found or expired',
      })
    }
    console.error('Conversation message storage failed:', error.message)
    res.status(500).json({ success: false, error: 'Could not save message' })
  }
})

const port = process.env.PORT || 8010
async function start() {
  await initializeDatabase()
  app.listen(port, '0.0.0.0', () => {
    console.log(`Running on port ${port}`, {
      metaApiVersion: META_API_VERSION,
      verifyTokenSet: Boolean(VERIFY_TOKEN),
      facebookTokenSet: Boolean(FB_PAGE_ACCESS_TOKEN),
      instagramTokenSet: Boolean(IG_ACCESS_TOKEN),
    })

    validateInstagramConnection().catch(error => {
      console.error('Instagram startup check failed:', error.message)
    })
  })

  warmIntentClassifier().catch(error => {
    console.error('Intent classifier warmup failed:', error.message)
  })
}

start().catch(error => {
  console.error('Application startup failed:', error.message)
  process.exit(1)
})