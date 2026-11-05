const app = require('./src/app');
const env = require('./src/config/env');

if (require.main === module) {
  app.listen(env.port, () => console.log(JSON.stringify({ level: 'info', event: 'server_started', port: env.port, environment: env.nodeEnv })));
}

module.exports = app;
