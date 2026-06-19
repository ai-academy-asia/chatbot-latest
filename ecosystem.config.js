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
      },
    }],
  }