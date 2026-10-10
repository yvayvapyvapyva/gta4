// export.js — экспорт реплея в MP4 1080x1920@30 со звуком и HUD.
//
// Как устроено:
// - картинка: WebGL-канвас на время экспорта рендерит ровно 1080x1920
//   (портрет через hardwareScalingLevel), DOM-интерфейс прячется классом
//   export-active, а сообщения/стрелки/скорость рисуются на отдельном
//   2D-канвасе поверх кадра — captureStream пишет только канвасы, DOM
//   в видео бы не попал;
// - звук: все источники (щелчки, бипы — sounds.js; озвучка — tts.js)
//   идут через общий soundBus, к нему цепляется MediaStreamDestination;
// - темп реальный: реплей кинематический на стенных часах, пишем живьём 1×.
// Подключается после tts.js, использует глобалы index.html/replay.js.

const EXPORT_W = 1080, EXPORT_H = 1920, EXPORT_FPS = 30;
const EXPORT_BITRATE = 12_000_000; // ~1.5 МБ/с
const EXPORT_MIMES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];
const EXPORT_TTS_TIMEOUT = 25000;

let exportActive = false;
let exportFinalizing = false;
let exportDownloaded = false;
let exportRecorder = null;
let exportChunks = [];
let exportStream = null;
let exportAudioDest = null;
let exportCanvas = null;
let exportCtx2d = null;
let exportName = '';
let exportT0 = 0;
let exportDuration = 0;
let exportLastHudSec = -1;
let exportSavedScaling = null;
let exportSavedStyle = null;
// Плавный старт: первые кадры после ресайза канваса под портрет бывают
// пустыми/рваными — рекордер стартует после N живых кадров, а не сразу,
// иначе в начало файла ложится мусор и уползает синхрон.
let exportWarmLeft = 0;
const EXPORT_WARM_FRAMES = 6;

function exportSupported() {
  try {
    return typeof MediaRecorder !== 'undefined' &&
      typeof document.createElement('canvas').captureStream === 'function';
  } catch (e) { return false; }
}

// ── портретный режим рендера ────────────────────────────────────────
// Бэк-стор ровно 1080x1920: buffer = css / scalingLevel, поэтому
// scalingLevel = cssW / 1080. Камеры и зеркала аспект подхватят сами.
function exportEnterPortrait() {
  const canvas = document.getElementById('view');
  exportSavedScaling = engine.getHardwareScalingLevel();
  exportSavedStyle = {
    width: canvas.style.width, height: canvas.style.height,
    position: canvas.style.position, left: canvas.style.left,
    top: canvas.style.top, transform: canvas.style.transform,
  };
  const s = Math.min(innerWidth / EXPORT_W, innerHeight / EXPORT_H);
  const cssW = Math.max(1, Math.floor(EXPORT_W * s));
  const cssH = Math.max(1, Math.floor(EXPORT_H * s));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  engine.setHardwareScalingLevel(cssW / EXPORT_W);
  engine.resize();
  document.body.classList.add('export-active');
}
function exportExitPortrait() {
  const canvas = document.getElementById('view');
  try {
    engine.setHardwareScalingLevel(exportSavedScaling);
    Object.assign(canvas.style, exportSavedStyle);
    engine.resize();
  } catch (e) {}
  document.body.classList.remove('export-active');
}

// ── композитный канвас + HUD ────────────────────────────────────────
function exportEnsureCanvas() {
  if (!exportCanvas) {
    exportCanvas = document.createElement('canvas');
    exportCanvas.width = EXPORT_W;
    exportCanvas.height = EXPORT_H;
    exportCtx2d = exportCanvas.getContext('2d');
  }
}
function exportRoundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function exportWrap(c, text, maxW) {
  // Абзацы по \n сохраняются, длинные строки переносятся по словам.
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width > maxW && line) { out.push(line); line = w; }
      else line = t;
    }
    if (line) out.push(line);
  }
  return out.slice(0, 6);
}
function exportDrawHud(c) {
  // Всё читаем из данных реплея/машины, а не из DOM: DOM-элементы на время
  // экспорта скрыты классом export-active, и скрапинг давал рассинхрон
  // (сообщения в браузере есть, а в файле — нет).
  let nowT = 0, msgs = [];
  try {
    if (window.Replay?.getMessages) msgs = window.Replay.getMessages() || [];
    if (window.Replay?.getTime) nowT = window.Replay.getTime() || 0;
  } catch (e) {}
  // сообщение
  try {
    const active = msgs.filter((m) => nowT >= m.t && nowT < m.t + m.dur);
    const t = active.map((m) => m.text).join('\n').trim();
    if (t) {
      c.font = '600 44px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const lines = exportWrap(c, t, 920);
      const lh = 58, pad = 26;
      const bw = Math.min(980, Math.max(...lines.map((l) => c.measureText(l).width)) + pad * 2);
      const bh = lines.length * lh + pad * 2;
      const bx = (EXPORT_W - bw) / 2, by = EXPORT_H * 0.085;
      c.fillStyle = 'rgba(10,14,20,0.78)';
      exportRoundRect(c, bx, by, bw, bh, 24);
      c.fill();
      c.fillStyle = '#fff';
      lines.forEach((l, i) => c.fillText(l, EXPORT_W / 2, by + pad + lh * i + lh / 2));
    }
  } catch (e) {}
  // стрелки поворотников — логика как у #turnHud в приложении:
  // пилюля видна всё время, пока хоть один поворотник включён
  // (и в тёмной, и в светлой фазе), мигает только стрелка внутри.
  // Фаза — из живого blinkOn, а не из классов скрытого DOM.
  try {
    const bl = typeof blinkerLeft !== 'undefined' && !!blinkerLeft;
    const br = typeof blinkerRight !== 'undefined' && !!blinkerRight;
    const phase = typeof blinkOn !== 'undefined' ? !!blinkOn : true;
    if (bl || br) exportTurnArrows(c, bl && phase, br && phase);
  } catch (e) {}
  // скорость — левый верхний угол, из живой скорости машины
  try {
    const kmh = (typeof CAR !== 'undefined' && CAR) ? Math.abs(CAR.v) * 3.6 : 0;
    const v = String(Math.round(kmh));
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 12;
    c.font = '700 92px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    c.fillStyle = '#fff';
    c.fillText(v, 56, 140);
    const vw = c.measureText(v).width;
    c.font = '400 40px system-ui, sans-serif';
    c.fillStyle = '#98a0b3';
    c.fillText('км/ч', 56 + vw + 20, 140);
    c.shadowBlur = 0;
  } catch (e) {}
}
function exportArrow(c, cx, cy, dir, lit) {
  // стрелка с древком ~64px: хвостовик + наконечник, как #turnHud
  const s = 64 / 24; // viewBox 24x24 -> px
  c.save();
  c.translate(cx, cy);
  c.scale(dir * s, s);
  // рисуем правую стрелку в локальных единицах viewBox 14..38
  c.translate(-26, -12);
  c.fillStyle = lit ? '#35ff62' : '#223526';
  if (lit) { c.shadowColor = 'rgba(53,255,98,0.9)'; c.shadowBlur = 10; }
  c.fillRect(14, 7.5, 12, 9); // древко
  c.beginPath(); // наконечник
  c.moveTo(26, 2); c.lineTo(38, 12); c.lineTo(26, 22); c.closePath();
  c.fill();
  c.restore();
}
function exportTurnArrows(c, lon, ron) {
  const cy = 96;
  c.fillStyle = 'rgba(8,10,14,0.72)';
  exportRoundRect(c, EXPORT_W / 2 - 110, cy - 45, 220, 90, 18);
  c.fill();
  exportArrow(c, EXPORT_W / 2 - 55, cy, -1, lon);
  exportArrow(c, EXPORT_W / 2 + 55, cy, 1, ron);
}

// ── звук в поток ────────────────────────────────────────────────────
function exportStartAudio() {
  try {
    if (typeof ensureAudioContext === 'function') ensureAudioContext();
    if (typeof audioCtx === 'undefined' || !audioCtx) return null;
    if (typeof soundBusNode !== 'function') return null;
    const bus = soundBusNode();
    if (!bus) return null;
    exportAudioDest = audioCtx.createMediaStreamDestination();
    bus.connect(exportAudioDest);
    return exportAudioDest.stream;
  } catch (e) { return null; }
}
function exportStopAudio() {
  try {
    if (exportAudioDest && typeof soundBusNode === 'function') {
      const bus = soundBusNode();
      if (bus) bus.disconnect(exportAudioDest);
    }
  } catch (e) {}
  exportAudioDest = null;
}

// ── рекордер ────────────────────────────────────────────────────────
function exportPickMime() {
  try {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    for (const m of EXPORT_MIMES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
    }
  } catch (e) {}
  return '';
}

// ── главный поток ───────────────────────────────────────────────────
function exportReplay(name) {
  if (exportActive) { showToast('Экспорт уже идёт'); return; }
  if (!exportSupported()) { showToast('Браузер не умеет писать видео'); return; }
  if (window.Replay.isRecording()) { showToast('Сначала остановите запись'); return; }
  if (window.Replay.isPlaying() || window.Replay.isPaused() || window.Replay.isEditing()) {
    showToast('Сначала остановите текущий режим'); return;
  }
  const data = window.Replay.loadReplayFromStorage(name);
  if (!data) { showToast('Запись не найдена'); return; }
  if (!window.Replay.loadReplay(data)) { showToast('Повреждённая запись'); return; }
  const buf = window.Replay.getBuffer();
  exportDuration = buf.length ? buf[buf.length - 1].t : 0;
  const msgs = window.Replay.getMessages ? window.Replay.getMessages() : [];
  const canVoice = typeof ttsPrefetch === 'function' && typeof ttsHas === 'function';
  const speakOf = (m) => (typeof msgSpeech === 'function' ? msgSpeech(m) : String(m.speech ?? '').trim());
  const cold = canVoice ? msgs.filter((m) => speakOf(m).trim() && !ttsHas(m.voice || 'command', speakOf(m))) : [];
  openVoiceLoad(true);
  updateVoiceLoad(0, Math.max(1, cold.length));
  const items = cold.map((m) => ({ voice: m.voice || 'command', text: speakOf(m) }));
  const prefetch = canVoice
    ? ttsPrefetch(items, (done, total) => updateVoiceLoad(done, total))
    : Promise.resolve({ done: 0, total: 0 });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('tts timeout')), EXPORT_TTS_TIMEOUT));
  Promise.race([prefetch, timeout]).then(
    () => exportBegin(name),
    () => exportBegin(name), // офлайн: едем без части озвучки, картинка пишется всё равно
  );
}

function exportBegin(name) {
  openVoiceLoad(false);
  exportName = name;
  exportChunks = [];
  exportFinalizing = false;
  exportDownloaded = false;
  exportLastHudSec = -1;
  exportEnsureCanvas();
  try { if (typeof openSettings === 'function') openSettings(false); } catch (e) {}
  try { if (typeof openReplayList === 'function') openReplayList(false); } catch (e) {}
  exportEnterPortrait();
  const aStream = exportStartAudio();
  exportStream = new MediaStream();
  try {
    exportCanvas.captureStream(EXPORT_FPS).getVideoTracks().forEach((t) => exportStream.addTrack(t));
    if (aStream) aStream.getAudioTracks().forEach((t) => exportStream.addTrack(t));
  } catch (e) {
    showToast('Не удалось захватить поток');
    exportExitPortrait();
    exportStopAudio();
    return;
  }
  const mime = exportPickMime();
  try {
    exportRecorder = new MediaRecorder(exportStream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: EXPORT_BITRATE,
    });
  } catch (e) {
    showToast('Рекордер не запустился');
    exportExitPortrait();
    exportStopAudio();
    return;
  }
  exportRecorder.ondataavailable = (e) => { if (e.data && e.data.size) exportChunks.push(e.data); };
  exportRecorder.onstop = exportDownload;
  // start() — не здесь, а из exportTick после прогревочных кадров
  exportWarmLeft = EXPORT_WARM_FRAMES;
  exportT0 = performance.now();
  exportActive = true;
  showExportHud(true);
  try { if (typeof ttsUnlock === 'function') ttsUnlock(); } catch (e) {}
  window.Replay.startPlayback();
  exportSnapCamera(); // камера — сразу в кадр, без дотяжки экспонентой
  showToast('⏺ Запись MP4…');
}

// Жёсткая доводка камеры в кадр первого тика: после смены разрешения
// следящая камера дотягивается экспонентой (~секунда) — в видео это выглядит
// как «машина сбоку, потом центрируется». Ставим углы/таргет сразу.
function exportSnapCamera() {
  try {
    if (typeof CAR === 'undefined' || !CAR || !CAR.root) return;
    const p = CAR.root.position;
    if (CAR.mode === 0 && typeof cam !== 'undefined' && cam) {
      if (typeof camTarget !== 'undefined' && camTarget) {
        camTarget.set(p.x, p.y + 0.75, p.z);
        cam.target.copyFrom(camTarget);
      } else {
        cam.target.set(p.x, p.y + 0.75, p.z);
      }
      cam.alpha = CAR.yaw + Math.PI / 2 + (CAR.camYaw || 0);
      cam.beta = CAR.camPitch;
      cam.radius = CAR.camDist;
    } else if (CAR.mode === 1 && typeof cockpit !== 'undefined' && cockpit) {
      cockpit.rotation.set(
        (typeof COCKPIT_PITCH !== 'undefined' ? COCKPIT_PITCH : 0.16) + (CAR.lookPitch || 0),
        Math.PI - (CAR.lookYaw || 0), 0);
    }
  } catch (e) {}
}

// Вызывается из render loop каждый кадр после scene.render().
function exportTick() {
  if (!exportActive) return;
  try {
    exportCtx2d.drawImage(document.getElementById('view'), 0, 0, EXPORT_W, EXPORT_H);
  } catch (e) { return; }
  exportDrawHud(exportCtx2d);
  updateExportHud();
  // Плавный старт рекордера: ждём живых кадров уже идущего воспроизведения.
  if (exportRecorder && exportRecorder.state === 'inactive' && !exportFinalizing) {
    try {
      if (window.Replay.isPlaying() && !window.Replay.isPaused()) {
        if (exportWarmLeft > 0) exportWarmLeft--;
        else exportRecorder.start(1000);
      }
    } catch (e) {}
  }
  if (!window.Replay.isPlaying() && !window.Replay.isPaused() && !exportFinalizing) {
    // лента кончилась (stopPlayback уже отработал) — хвост на звук и финал
    exportFinalizing = true;
    setTimeout(exportFinish, 600);
  }
}

function exportFinish() {
  exportActive = false;
  showExportHud(false);
  try {
    if (exportRecorder && exportRecorder.state !== 'inactive') exportRecorder.stop();
    else exportDownload();
  } catch (e) { exportDownload(); }
  setTimeout(() => { if (!exportDownloaded) exportDownload(); }, 2000);
  exportStopAudio();
  exportExitPortrait();
}

function exportDownload() {
  if (exportDownloaded) return;
  exportDownloaded = true;
  try {
    if (!exportChunks.length) { showToast('Пустая запись'); return; }
    const mime = (exportRecorder && exportRecorder.mimeType) || 'video/mp4';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(exportChunks, { type: mime.split(';')[0] });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName.replace(/[^\w\-а-яё]+/gi, '_') + '_1080x1920.' + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    const mb = (blob.size / 1048576).toFixed(1);
    showToast('Сохранено (' + mb + ' МБ)');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    showToast('Ошибка сохранения файла');
  }
  exportChunks = [];
}

// ── REC-плашка ──────────────────────────────────────────────────────
function showExportHud(on) {
  const el = document.getElementById('exportHud');
  if (el) el.hidden = !on;
  exportLastHudSec = -1;
}
function updateExportHud() {
  const el = document.getElementById('exportHud');
  if (!el || el.hidden) return;
  const sec = Math.floor((performance.now() - exportT0) / 1000);
  if (sec === exportLastHudSec) return;
  exportLastHudSec = sec;
  const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  el.textContent = '⏺ REC ' + fmt(sec) + ' / ' + fmt(exportDuration);
}

window.ExportMP4 = { start: exportReplay, isActive: () => exportActive };

// ── Гид кадрирования 9:16 ───────────────────────────────────────────
// Портретный рендер держит тот же вертикальный FOV и режет бока — это ровно
// центральный кроп 9:16 широкого кадра. Рамка показывает его заранее и видна
// только когда включена вручную из «Вид» (кнопка или G).
// Прячется в самом экспорте — там канвас уже портрет.
let cropGuideManual = false;
try { cropGuideManual = localStorage.getItem('gta4_cropguide') === '1'; } catch (e) {}
let cropGuideShown = null;
function syncCropGuide() {
  const el = document.getElementById('cropGuide');
  if (!el) return;
  let show = cropGuideManual;
  try {
    // Видимость — только по настройке из «Вид». В самом экспорте прячем:
    // там канвас уже портретный.
    if (window.ExportMP4 && window.ExportMP4.isActive()) show = false;
  } catch (e) {}
  if (show === cropGuideShown) return;
  cropGuideShown = show;
  el.hidden = !show;
  const b = document.getElementById('cropGuideBtn');
  if (b) b.classList.toggle('on', cropGuideManual);
}
function toggleCropGuide(force) {
  cropGuideManual = typeof force === 'boolean' ? force : !cropGuideManual;
  try { localStorage.setItem('gta4_cropguide', cropGuideManual ? '1' : '0'); } catch (e) {}
  cropGuideShown = null;
  syncCropGuide();
}
function initCropGuide() {
  syncCropGuide();
  document.getElementById('cropGuideBtn')?.addEventListener('click', () => toggleCropGuide());
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyG' || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    toggleCropGuide();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCropGuide);
} else {
  initCropGuide();
}
