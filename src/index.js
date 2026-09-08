const express = require('express')
const cors = require('cors')
const { randomUUID: uuidv4 } = require('node:crypto')
const { classifyIntent, warmIntentClassifier } = require('./intent-classifier')
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
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN
const META_API_VERSION = process.env.META_API_VERSION || 'v25.0'

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
  PROGRAM_AI_AGENTS: `2 өдөр хийдэг ажлыг 3 минутад хийдэг болго.

Өдөр бүр PDF, Excel, тайлан, имэйл, маягттай ажиллаж, ижил үйлдлүүдийг дахин дахин хийсээр байна уу?

200 PDF-ээс мэдээлэл гаргах, 15 Excel нэгтгэх, хоёр жагсаалт харьцуулж зөрүү олох, сар бүрийн тайлан бэлтгэх зэрэг ажлууд таны цагийг их авдаг ч заавал гараар хийх шаардлагагүй.

AI Agents хөтөлбөрөөр AI-г зүгээр нэг асуулт асуудаг хэрэгсэл биш, таны ажлыг өөрөө гүйцэтгэдэг AI туслах систем болгон ашиглаж сурна.

6 долоо хоногийн хугацаанд та өөрийн бодит ажил, жинхэнэ файл дээр ажиллаж:

→ Баримт бичиг уншиж, дүн шинжилгээ хийх
→ Excel дата цэвэрлэх, нэгтгэх, шалгах
→ Давтагддаг ажлаа Skill болгон хувиргах
→ Өдөр бүр автоматаар ажилладаг AI Agent бүтээх
→ PDF, Excel зэрэг олон файл дээр ажиллах скрипт бүтээх
→ Форм, имэйлээс мэдээлэл цуглуулах автомат урсгал үүсгэх
→ Өөрийн ажлын хэрэгцээнд тохирсон AI workflow бүтээх
→ Бүтээсэн системээ capstone төслөөр хамгаалах

Хамгийн гол нь — код бичих шаардлагагүй.

Юу хийхийг энгийн үгээр хэлж, AI-аар шийдлээ бүтээж, гарсан үр дүнг зөв шалгаж сурна.

Сургалтын төгсгөлд та зөвхөн мэдлэгтэй үлдэхгүй. Өдөр тутмын ажилдаа шууд ашиглах AI орчин, автоматжуулсан Skill, AI Agent, ажлын урсгал-тай болно.

AI ашиглаж сурахаас нэг алхам цааш.
Өөрийн AI системийг бүтээж сур.

📅 Эхлэх: 2026.09.25
⏱ 6 долоо хоног · 12 хичээл
🗓 Даваа, Лхагва · 12:00–13:30
💻 Танхим + онлайн хосолсон
💰 2,880,000₮

AI Academy Asia — AI Agents`,
  PROGRAM_AI_BUSINESS: `AI for Business: Сошиал контент, чат, захиалгыг 24/7 автоматаар ажиллуулах систем бүтээх хөтөлбөр.

Үндсэн хэрэгсэл: Facebook API, Meta for Developers, n8n, Supabase, Vibe Coding

Гол үр дүн: Facebook-ийн контент бэлтгэх, чатаар хариулах, захиалга бүртгэх бүрэн циклийн систем ба админ самбар угсарна.

Хичээлийн хуваарь: Мягмар, Пүрэв | 07:30–09:00 (12 лайв хичээл + офлайн воркшоп)

💡 23:41 цагт ирсэн чат маргааш өглөөг хүлээхгүй — 24/7 тасралтгүй борлуулалт.`,
  PAYMENT: 'Төлбөр: 2,880,000₮ (20% хөнгөлөлттэй | Storepay боломжтой)',
  LOCATION: `Хаяг: СБД, 1-р хороо, Олимпийн гудамж-15, ITC Tower, 11 давхар
☎️ 75051055`,
  REGISTER: 'Бүртгүүлэх холбоос: https://www.ai-academy.asia/ai-acceleration.html#register',
}

if (!VERIFY_TOKEN) {
  console.error('FB_VERIFY_TOKEN is not set — webhook verification will fail')
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
    console.error(`${object === 'page' ? 'FB_PAGE_ACCESS_TOKEN' : 'IG_ACCESS_TOKEN'} is not set`)
    return
  }

  const body = {
    recipient: { id: recipientId },
    message,
  }

  if (object === 'page') {
    body.messaging_type = 'RESPONSE'
  }

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
    'Дараагийн алхам',
    'Та үргэлжлүүлэн юу мэдэхийг хүсэж байна вэ?',
    PROGRAM_ACTION_OPTIONS,
  )
}

async function sendDetailActions(object, recipientId) {
  await sendMenuCard(
    object,
    recipientId,
    'Дараагийн алхам',
    'Бүртгүүлэх эсвэл үндсэн цэс рүү буцна уу.',
    DETAIL_ACTION_OPTIONS,
  )
}

async function sendIntentAnswer(object, recipientId, prediction) {
  if (prediction.intentId === 'greeting') {
    await sendWelcomeMenu(object, recipientId)
    return
  }

  for (const chunk of splitMessage(prediction.answer)) {
    await sendMetaMessage(object, recipientId, { text: chunk })
  }

  if (prediction.intentId === 'surgaltiin_medeelel') {
    await sendProgramActions(object, recipientId)
  } else if (prediction.intentId !== 'register') {
    await sendDetailActions(object, recipientId)
  }
}

async function handleMessagingEvent(object, event) {
  if (!event.sender || event.message?.is_echo) return

  const senderId = event.sender.id
  const payload = event.message?.quick_reply?.payload || event.postback?.payload

  if (payload === 'MAIN_MENU') {
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
      await sendProgramActions(object, senderId)
    } else if (payload === 'PAYMENT' || payload === 'LOCATION') {
      await sendDetailActions(object, senderId)
    }
    return
  }

  if (event.message?.text) {
    try {
      const prediction = await classifyIntent(event.message.text)

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

  if (event.message || event.postback) {
    await sendWelcomeMenu(object, senderId)
  }
}

// ── Health ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true })
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

  if (!['page', 'instagram'].includes(body.object)) return

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      console.log(`${body.object} message from ${event.sender?.id || 'unknown'}`)
      handleMessagingEvent(body.object, event).catch(error => {
        console.error('Webhook event handling failed:', error.message)
      })
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

warmIntentClassifier().catch(error => {
  console.error('Intent classifier warmup failed:', error.message)
})