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
      IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
      META_API_VERSION: process.env.META_API_VERSION || 'v25.0',
    },
  }],
}