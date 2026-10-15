'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTempDataDir, ROOT_DIR } = require('./helpers');
const { sanitizeContent } = require('../src/validate');

const SCRIPT = path.join(ROOT_DIR, 'scripts', 'export-static.js');

let tmp;

before(() => {
  tmp = makeTempDataDir();
  const contentFile = path.join(tmp.dataDir, 'content.json');
  if (!fs.existsSync(contentFile)) fs.writeFileSync(contentFile, JSON.stringify(sanitizeContent({}).content));
  fs.mkdirSync(path.join(tmp.dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(tmp.dataDir, 'uploads', 'export-test.webp'), Buffer.from('RIFF0000WEBP'));
  fs.writeFileSync(path.join(tmp.dataDir, 'uploads', 'notes.txt'), 'not an image');
});

after(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

function runExport(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT_DIR,
    env: { ...process.env, DATA_DIR: tmp.dataDir, ...env },
    encoding: 'utf8',
  });
}

test('npm run export → статичні файли в OUT_DIR з BASE_PATH', () => {
  const outDir = path.join(tmp.root, 'dist');
  const result = runExport({ OUT_DIR: outDir, BASE_PATH: '/PortfolioAnna' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Готово/);
  assert.ok(result.stdout.includes(outDir));

  const uk = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const en = fs.readFileSync(path.join(outDir, 'en', 'index.html'), 'utf8');
  assert.match(uk, /<html[^>]*\slang="uk"/);
  assert.match(en, /<html[^>]*\slang="en"/);
  assert.match(uk, /\/PortfolioAnna\/assets\//, 'шляхи з префіксом BASE_PATH');
  assert.doesNotMatch(uk, /(href|src)="\/(assets|uploads)\//, 'жодних шляхів без префікса');
  assert.doesNotMatch(uk, /action="[^"]*\/api\/lead"/, 'у статичній версії форми немає');

  assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')));
  assert.ok(fs.existsSync(path.join(outDir, 'uploads', 'export-test.webp')));
  assert.ok(!fs.existsSync(path.join(outDir, 'uploads', 'notes.txt')), 'копіюються лише зображення');
  assert.ok(!fs.existsSync(path.join(outDir, 'admin')), 'адмінка не експортується');
  assert.ok(!fs.existsSync(path.join(outDir, 'private')));
  if (fs.existsSync(path.join(ROOT_DIR, 'public', 'css', 'fonts.css'))) {
    assert.ok(fs.existsSync(path.join(outDir, 'assets', 'css', 'fonts.css')));
  }
  assert.ok(fs.existsSync(path.join(outDir, '404.html')), '404.html exported');

  // повторний експорт у ту саму папку дозволено (вона вже містить .nojekyll);
  // сторонні файли (CNAME для власного домену) не зачіпаються, застарілі — прибираються
  fs.writeFileSync(path.join(outDir, 'CNAME'), 'annafrolova.travel\n');
  fs.writeFileSync(path.join(outDir, 'uploads', 'stale.webp'), 'old');
  const again = runExport({ OUT_DIR: outDir, BASE_PATH: '' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /(href|src)="\/assets\//);
  assert.equal(fs.readFileSync(path.join(outDir, 'CNAME'), 'utf8'), 'annafrolova.travel\n');
  assert.ok(!fs.existsSync(path.join(outDir, 'uploads', 'stale.webp')));
});

test('експорт не стирає непорожню сторонню папку', () => {
  const outDir = path.join(tmp.root, 'important');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'keep.txt'), 'keep me');
  const result = runExport({ OUT_DIR: outDir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /не порожня|не знайдено шаблон/i);
  assert.equal(fs.readFileSync(path.join(outDir, 'keep.txt'), 'utf8'), 'keep me');
});

test('експорт відмовляється писати в папку з даними чи корінь проєкту', () => {
  for (const outDir of [tmp.dataDir, ROOT_DIR, path.join(tmp.dataDir, 'uploads', 'dist')]) {
    const result = runExport({ OUT_DIR: outDir });
    assert.notEqual(result.status, 0, outDir);
  }
  assert.ok(fs.existsSync(path.join(tmp.dataDir, 'content.json')));
});
