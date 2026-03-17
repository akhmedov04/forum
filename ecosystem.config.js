module.exports = {
  apps: [{
    name: 'plovchan',
    script: 'server.js',
    cwd: 'C:\\plovchan',
    env: {
      NODE_ENV: 'production',
      PORT: 4000,
      SESSION_SECRET: 'plovchan_secret_key_2026_random'
    },
    restart_delay: 5000,
    max_restarts: 10
  }]
};