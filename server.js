'use strict';

/**
 * Запуск сайту локально:  npm start
 * Відкрити з телефона в тій самій Wi-Fi:  HOST=0.0.0.0 npm start
 */

const os = require('os');
const { createApp } = require('./src/app');
const { loadConfig, DEFAULT_ADMIN_PASSWORD } = require('./src/config');

const config = loadConfig();

let app;
try {
  app = createApp({ dataDir: config.dataDir, rootDir: config.rootDir, adminPassword: config.adminPassword });
} catch (err) {
  console.error('\nНе вдалося запустити сайт:', err.message);
  console.error(err.stack);
  process.exit(1);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

function printBanner(port) {
  const { auth, paths } = app.services;
  const wildcard = config.host === '0.0.0.0' || config.host === '::';
  const shownHost = wildcard || config.host === '127.0.0.1' || config.host === '::1' ? 'localhost' : config.host;
  const base = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}`;

  const lines = [
    '',
    '  ANNA FROLOVA TRAVEL — сайт запущено',
    '  ─────────────────────────────────────────────',
    `  Сайт (українською):   ${base}/`,
    `  Сайт (English):       ${base}/en/`,
    `  Адмін-панель:         ${base}/admin/`,
    '',
  ];

  if (auth.mustChangePassword) {
    if (auth.verifyPasswordSync(DEFAULT_ADMIN_PASSWORD)) {
      lines.push(`  Пароль для входу:     ${DEFAULT_ADMIN_PASSWORD}`);
    } else if (config.adminPasswordFromEnv && auth.verifyPasswordSync(config.adminPassword)) {
      lines.push('  Пароль для входу:     той, що задано в ADMIN_PASSWORD');
    } else {
      lines.push('  Пароль для входу:     початковий пароль, заданий під час першого запуску');
    }
    lines.push('  Після входу змініть його в адмінці: розділ «Безпека».', '');
  }

  if (wildcard) {
    const ips = lanAddresses();
    if (ips.length) {
      lines.push('  З телефона (та сама Wi-Fi мережа):');
      for (const ip of ips) lines.push(`    http://${ip}:${port}/`);
      lines.push('');
    }
  } else {
    const hint = process.platform === 'win32'
      ? '$env:HOST="0.0.0.0"; npm start   (PowerShell)'
      : 'HOST=0.0.0.0 npm start';
    lines.push('  Щоб відкрити сайт з телефона в тій самій Wi-Fi мережі,');
    lines.push(`  зупиніть сервер і запустіть так:  ${hint}`, '');
  }

  lines.push(`  Дані сайту:           ${paths.dataDir}`);
  lines.push('  Зупинити сервер:      Ctrl+C', '');
  console.log(lines.join('\n'));
}

const server = app.listen(config.port, config.host, () => {
  printBanner(server.address().port);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nПорт ${config.port} уже зайнятий — можливо, сайт уже запущено в іншому вікні.`);
    console.error(`Закрийте його або запустіть на іншому порту:  PORT=${config.port + 1} npm start\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\nНемає дозволу використовувати порт ${config.port}. Спробуйте інший:  PORT=3000 npm start\n`);
  } else {
    console.error('\nНе вдалося запустити сервер:', err.message);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\nЗупиняю сервер…');
  server.close(() => process.exit(0));
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
