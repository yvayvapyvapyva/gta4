// build-deploy.js — сборка деплой-версии: всё (кроме editor) в один deploy/index.html.
// Запуск из корня проекта: node build-deploy.js  (нужен установленный terser)
// Модель auto/car.glb копируется рядом отдельным файлом (бинарник не инлайнится).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'deploy');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gta4-deploy-'));
const MODULES = ['default-map.js', 'map.js', 'mirror.js', 'drive-control.js', 'sounds.js', 'replay.js', 'tts.js'];

function minifyJS(code, name) {
  const tmp = path.join(TMP, `bundle_${name}.js`);
  const out = path.join(TMP, `bundle_${name}.min.js`);
  fs.writeFileSync(tmp, code);
  execSync(`terser ${tmp} -c -m --toplevel -o ${out}`, { stdio: 'pipe' });
  const min = fs.readFileSync(out, 'utf8');
  execSync(`node --check ${out}`, { stdio: 'pipe' });
  return min;
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// --- инлайн-скрипты (без src): [0] основной, [1] tgFullscreen-хвост
const inlineMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const inlineScripts = inlineMatches.map(m => m[1]);
if (inlineScripts.length !== 2) throw new Error('inline scripts: ' + inlineScripts.length);
// оригиналы выкидываем — их содержимое уезжает в бандл ниже (иначе дубль и SyntaxError)
html = html.replace(inlineMatches[0][0], '');
html = html.replace(inlineMatches[1][0], '');

// --- основной бандл: порядок как в документе (лексическая область общая!)
const bundleSrc = inlineScripts[0]
  + '\n;\n' + MODULES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n')
  + '\n;\n' + inlineScripts[1];
const bundleMin = minifyJS(bundleSrc, 'main');

// --- report.js отдельным скриптом (как в исходнике — в head)
const reportSrc = fs.readFileSync(path.join(ROOT, 'report.js'), 'utf8');
const reportMin = minifyJS(reportSrc, 'report');

// --- стили: склеить, вырезать комментарии, схлопнуть пробелы
const styleBlocks = [...html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)];
let css = styleBlocks.map(m => m[2]).join('\n');
css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '').trim();

// --- замены в HTML
html = html.replace('<script src="report.js"></script>', () => '<script>' + reportMin + '</script>');
let styleIdx = 0;
html = html.replace(/<style([^>]*)>[\s\S]*?<\/style>/g, () => (++styleIdx === 1 ? '<style>' + css + '</style>' : ''));
const tailRe = /<script src="default-map\.js\?v=\d+"><\/script>[\s\S]*?<script src="tts\.js\?v=\d+"><\/script>/;
if (!tailRe.test(html)) throw new Error('tail block not found');
html = html.replace(tailRe, () => '<script>' + bundleMin + '</script>');
if (/src="(default-map|map|mirror|drive-control|sounds|replay|tts|report)\.js/.test(html)) {
  throw new Error('остались локальные src!');
}

fs.mkdirSync(path.join(OUT, 'auto'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.copyFileSync(path.join(ROOT, 'auto', 'car.glb'), path.join(OUT, 'auto', 'car.glb'));
// Надстройки моделей (<модель>.cfg.js) грузятся рантаймом отдельно — копируем как есть.
for (const f of fs.readdirSync(path.join(ROOT, 'auto'))) {
  if (/\.cfg\.js$/i.test(f)) fs.copyFileSync(path.join(ROOT, 'auto', f), path.join(OUT, 'auto', f));
}

// --- видео-упражнения: манифест video/list.json (нужен и в исходниках для
// dev-запуска, и в deploy) + копия json-файлов в deploy
const videoSrc = path.join(ROOT, 'video');
const videoOut = path.join(OUT, 'video');
if (fs.existsSync(videoSrc)) {
  // Порядок упражнений в меню (остальные файлы — после, по алфавиту)
  const EX_ORDER = ['разворот', 'парковка', 'гараж', 'горка'];
  const orderOf = (f) => {
    const base = f.replace(/\.json$/i, '');
    const i = EX_ORDER.indexOf(base);
    return i < 0 ? EX_ORDER.length : i;
  };
  const files = fs.readdirSync(videoSrc)
    .filter(f => /\.json$/i.test(f) && f !== 'list.json')
    .sort((a, b) => (orderOf(a) - orderOf(b)) || a.localeCompare(b, 'ru'));
  const meta = files.map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(videoSrc, f), 'utf8'));
      if (!d || !Array.isArray(d.frames) || !d.frames.length) return null;
      const frames = d.frames;
      return {
        file: f,
        name: f.replace(/\.json$/i, '').replace(/["<>]+/g, ''),
        duration: Math.round((frames[frames.length - 1].t || 0) * 10) / 10,
        frames: frames.length,
        msgs: Array.isArray(d.messages) ? d.messages.length : 0,
      };
    } catch (e) { return null; }
  }).filter(Boolean);
  const manifest = JSON.stringify({ files: meta });
  fs.writeFileSync(path.join(videoSrc, 'list.json'), JSON.stringify({ files: meta }, null, 2));
  fs.mkdirSync(videoOut, { recursive: true });
  fs.writeFileSync(path.join(videoOut, 'list.json'), manifest);
  for (const f of files) fs.copyFileSync(path.join(videoSrc, f), path.join(videoOut, f));
  console.log('video :', meta.length, 'упражнений');
}

const kb = n => (n / 1024).toFixed(0) + ' КБ';
console.log('bundle js :', kb(bundleSrc.length), '->', kb(bundleMin.length));
console.log('report js :', kb(reportSrc.length), '->', kb(reportMin.length));
console.log('index.html:', kb(fs.statSync(path.join(OUT, 'index.html')).size));
console.log('car.glb   :', (fs.statSync(path.join(OUT, 'auto', 'car.glb')).size / 1048576).toFixed(1) + ' МБ');
console.log('OK ->', path.join(OUT, 'index.html'));
