require('dotenv').config()

module.exports = {
  apps: [{
    name: 'chatbot-backend',
    script: 'src/index.js',
    cwd: '/var/www/chatbot-backend',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 8010,
      FB_VERIFY_TOKEN: process.env.FB_VERIFY_TOKEN,
      FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN,
      IG_PAGE_ACCESS_TOKEN: process.env.IG_PAGE_ACCESS_TOKEN,
      META_API_VERSION: process.env.META_API_VERSION || 'v25.0',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      INTENT_MIN_SIMILARITY: process.env.INTENT_MIN_SIMILARITY || '0.70',
      INTENT_MIN_MARGIN: process.env.INTENT_MIN_MARGIN || '0.02',
      RAG_MIN_SIMILARITY: process.env.RAG_MIN_SIMILARITY || '0.50',
      RAG_TOP_K: process.env.RAG_TOP_K || '4',
      RAG_TRUST_SCORE: process.env.RAG_TRUST_SCORE || '0.58',
      GEMINI_GENERATE_MODEL: process.env.GEMINI_GENERATE_MODEL || 'gemini-2.5-flash',
    },
  }],
}