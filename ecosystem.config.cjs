module.exports = {
  apps: [
    {
      name: 'rpg-chat',
      script: 'index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'rpg-chat-web',
      script: 'web-server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        // Must match the upstream port in nginx/proxy02-rpgchat.conf.
        WEB_PORT: 3001,
      },
    },
  ],
};
