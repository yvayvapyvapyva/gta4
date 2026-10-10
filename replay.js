// replay.js — запись и воспроизведение езды (кинематический реплей:
// поза телепортируется из записи, физика в воспроизведении не считается)
// Подключается после drive-control.js, использует глобальные: CAR, keys, drive, ready, scene

const REPLAY_TICK = 1 / 60; // частота кадров записи (60 Гц)

let isRecording = false;
let isPlaying = false;
let replayBuffer = [];
let replayStartTime = 0;
let replayIndex = 0;
let replayTime = 0; // накопленное время воспроизведения
// Текстовые сообщения поверх реплея: [{t: старт, с; dur: длительность, с; text}]
// Хранятся в JSON реплея полем messages, старые записи без поля = пусто.
let replayMessages = [];

// Сохранение текущих входов в буфер.
// Углы колёс НЕ храним: доворот выводится из steer, прокрут — интеграл
// скорости (считается при воспроизведении). Числа округлены до тысячных —
// JSON худеет в разы, на картинке разницы нет.
const r3 = (v) => Math.round(v * 1000) / 1000;
function captureFrame(now) {
  const dt = now - lastRecordTime;
  if (dt < REPLAY_TICK * 1000) return; // пишем не чаще 60 Гц
  lastRecordTime = now;

  // Определяем throttle из клавиатуры/тача (как в drive())
  const touchActive = Math.abs(touchThrottle) > 0.02;
  let throttle = 0;
  if (touchActive) {
    throttle = touchThrottle; // -1..1
  } else {
    const gas = keys.KeyW ? 1 : 0;
    const back = keys.KeyS ? 1 : 0;
    throttle = gas - back; // -1, 0, 1
  }

  const frame = {
    t: r3((now - replayStartTime) / 1000), // секунды от старта
    throttle: r3(throttle),
    steer: r3(CAR.steer), // текущий угол руля (рад)
    handbrake: keys.Space ? 1 : 0,
    blinkL: blinkerLeft ? 1 : 0,
    blinkR: blinkerRight ? 1 : 0,
    camMode: CAR.mode,
    camYaw: r3(CAR.camYaw),
    camPitch: r3(CAR.camPitch),
    camDist: r3(CAR.camDist),
    camFov: r3(CAR.camFov), // угол обзора салона (зум колесом/щипком/кнопками)
    lookYaw: r3(CAR.lookYaw),
    lookPitch: r3(CAR.lookPitch),
    // полное состояние физики
    pos: { x: r3(CAR.root.position.x), z: r3(CAR.root.position.z) },
    groundY: r3(CAR.y),
    lift: r3(CAR.lift),
    yaw: r3(CAR.yaw),
    v: r3(CAR.v),
    vy: r3(CAR.vy),
    xray: typeof xrayOn !== 'undefined' ? xrayOn : false
  };
  replayBuffer.push(frame);
}

// Начать запись
function startRecording() {
  if (isPlaying) stopPlayback();
  if (isEditing) closeReplayEditor();
  isRecording = true;
  replayBuffer = [];
  replayMessages = [];
  replayStartTime = performance.now();
  lastRecordTime = replayStartTime;
  console.log('[Replay] Recording started');
}

// Остановить запись и вернуть JSON
function stopRecording() {
  if (!isRecording) return null;
  isRecording = false;
  const json = {
    version: 1,
    tickRate: 1 / REPLAY_TICK,
    duration: replayBuffer.length > 0 ? replayBuffer[replayBuffer.length - 1].t : 0,
    frames: replayBuffer,
    messages: []
  };
  console.log('[Replay] Recording stopped, frames:', replayBuffer.length);
  return json;
}

// Скачать реплей как файл
function downloadReplay(filename = 'replay.json') {
  const data = stopRecording();
  if (!data) return;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Загрузить реплей из JSON
function loadReplay(json) {
  if (typeof json === 'string') json = JSON.parse(json);
  if (!json.frames || !json.frames.length) return false;
  replayBuffer = json.frames;
  replayMessages = sanitizeMessages(json.messages);
  replayIndex = 0;
  replayAccumulator = 0;
  console.log('[Replay] Loaded, frames:', replayBuffer.length, 'duration:', json.duration,
    'messages:', replayMessages.length);
  return true;
}

// Нормализация сообщений: {t, dur, text, speech, voice}.
// text — текст на экране, speech — текст для озвучки (пусто = озвучить text).
// voice — голос TTS из onepage2: command (Дмитрий) или comment (Светлана).
function sanitizeMessages(src) {
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const t = +m.t, dur = +m.dur;
    const text = String(m.text ?? '').slice(0, 200);
    if (!isFinite(t) || !isFinite(dur) || t < 0 || dur <= 0 || !text.trim()) continue;
    const speech = String(m.speech ?? '').slice(0, 500).trim();
    out.push({ t: Math.round(t * 1000) / 1000, dur: Math.min(60, Math.max(0.5, Math.round(dur * 10) / 10)), text: text.trim(), speech, voice: m.voice === 'comment' ? 'comment' : 'command' });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Что озвучивать для сообщения: только отдельный speech-текст.
// Пусто — тишина, показывается лишь экранный текст.
function msgSpeech(m) {
  if (!m) return '';
  return String(m.speech ?? '').trim();
}

// Оверлей сообщений: один div на все случаи (воспроизведение + редактор).
function replayMsgEl() { return document.getElementById('replayMsg'); }
function updateReplayMessages(t) {
  const el = replayMsgEl();
  if (!el) return;
  const active = replayMessages.filter(m => t >= m.t && t < m.t + m.dur);
  if (!active.length) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = active.map(m => m.text).join('\n');
}
function hideReplayMessages() {
  const el = replayMsgEl();
  if (el) { el.hidden = true; el.textContent = ''; }
}

// Озвучка сообщений при воспроизведении: каждое срабатывает один раз
// в момент активации (время монотонно, повторный проход невозможен).
// Накладки уходят в очередь tts.js — строго по порядку, без каши.
const voiceSeen = new Set();
function voiceTick(t) {
  if (typeof ttsVoiceOn !== 'undefined' && !ttsVoiceOn) return;
  if (typeof ttsSpeak !== 'function') return;
  replayMessages.forEach((m, i) => {
    if (voiceSeen.has(i)) return;
    if (t >= m.t && t < m.t + m.dur) {
      voiceSeen.add(i); // отмечаем всегда, даже молчаливые — повторных проверок нет
      const s = msgSpeech(m);
      if (!s) return;
      try { ttsSpeak(m.voice || 'command', s); } catch (e) {}
    }
  });
}

// Начать воспроизведение
function startPlayback() {
  if (isRecording) stopRecording();
  if (isEditing) closeReplayEditor();
  if (!replayBuffer.length) { console.warn('[Replay] Buffer empty'); return; }
  isPlaying = true;
  isPaused = false;
  replayIndex = 0;
  replayTime = 0;
  // Сброс машины в начальное состояние реплея (поза + камера + поворотники)
  const first = replayBuffer[0];
  resetCarToFrame(first);
  if (CAR.root) applyReplayFrame(first); // до загрузки модели — только буфер, поза встанет в первом тике
  prevRepBlinkL = false;
  prevRepBlinkR = false;
  try { replayBlinkEdge(first); } catch (e) {}
  updateReplayMessages(0);
  // Озвучка: сбрасываем отметки и греем кэш TTS одним батчем на голос —
  // к моменту показа сообщений аудио уже локально.
  voiceSeen.clear();
  try {
    if (typeof ttsPrefetch === 'function') {
      ttsPrefetch(replayMessages.map((m) => ({ voice: m.voice || 'command', text: msgSpeech(m) }))).catch(() => {});
    }
  } catch (e) {}
  showPlaybackUI();
  console.log('[Replay] Playback started');
}

// Остановить воспроизведение
function stopPlayback() {
  isPlaying = false;
  isPaused = false;
  replayIndex = 0;
  replayTime = 0;
  hidePlaybackUI();
  hideReplayMessages();
  voiceSeen.clear();
  if (typeof ttsStop === 'function') { try { ttsStop(); } catch (e) {} }
  // Машина остаётся в финальной позе и стоит: входы в кинематике не используются,
  // сброс ниже — страховка от остатков прошлых версий (газ/ручник из кадров).
  window._replayHandbrake = undefined;
  if (typeof touchThrottle !== 'undefined') touchThrottle = 0;
  if (typeof touchSteerEnabled !== 'undefined') touchSteerEnabled = false;
  if (typeof CAR !== 'undefined' && CAR) { CAR.v = 0; CAR.steer = 0; }
  if (typeof syncDvThrottle === 'function') syncDvThrottle();
  prevRepBlinkL = false;
  prevRepBlinkR = false;
  resetBlinkers();
  console.log('[Replay] Playback stopped');
}

let isPaused = false;

// Поворотники в исходное: кадры реплея/редактора ставят blinkerLeft/Right,
// а гасить их по выходу было некому — мигали дальше сами.
function resetBlinkers() {
  try {
    if (typeof blinkerLeft !== 'undefined') blinkerLeft = false;
    if (typeof blinkerRight !== 'undefined') blinkerRight = false;
    if (typeof applyBlink === 'function') applyBlink(); // тушит 3D-фонари и glow
    if (typeof syncBlinkBtns === 'function') syncBlinkBtns(false); // кнопки на панели
  } catch (e) {}
}

// Пауза/возобновление (часы стенные и на паузе стоят — ресинк не нужен).
// На паузе поворотники гаснут; при продолжении ближайший тик вернёт их
// из кадра (applyReplayFrame) — запоминать сторону не нужно.
function togglePlaybackPause() {
  if (!isPlaying && !isPaused) return;
  isPaused = !isPaused;
  updatePauseButton();
  if (isPaused) {
    try {
      if (typeof blinkerLeft !== 'undefined') blinkerLeft = false;
      if (typeof blinkerRight !== 'undefined') blinkerRight = false;
      if (typeof applyBlink === 'function') applyBlink();
      if (typeof syncBlinkBtns === 'function') syncBlinkBtns(false);
    } catch (e) {}
  }
}
function updatePauseButton() {
  const btn = document.getElementById('playbackPause');
  if (!btn) return;
  btn.textContent = isPaused ? '▶' : '⏸';
  btn.setAttribute('aria-label', isPaused ? 'Продолжить' : 'Пауза');
}

function showPlaybackUI() {
  const ui = document.getElementById('playbackUI');
  if (ui) { ui.hidden = false; document.body.classList.add('playback-active'); }
  updatePauseButton();
}
function hidePlaybackUI() {
  const ui = document.getElementById('playbackUI');
  if (ui) { ui.hidden = true; document.body.classList.remove('playback-active'); }
}

// Обёртка над replayTick с учётом паузы (часы — стенные, см. replayTick)
function replayTickWithPause(rawDt) {
  if (!isPlaying && !isPaused) return false;
  if (isPaused) return true; // просто ждём
  return replayTick(rawDt);
}

// Инициализация кнопок playback UI
function initPlaybackUI() {
  const pauseBtn = document.getElementById('playbackPause');
  const stopBtn = document.getElementById('playbackStop');
  if (pauseBtn) pauseBtn.addEventListener('click', togglePlaybackPause);
  if (stopBtn) stopBtn.addEventListener('click', stopPlayback);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPlaybackUI);
} else {
  initPlaybackUI();
}

// Состояние кадра без входов: поворотники, камера, рентген.
// Входов (газ/ручник) в кинематике нет: поза телепортируется из записи,
// физика в воспроизведении не считается. CAR.steer ставит resetCarToFrame.
function applyReplayFrame(frame) {
  blinkerLeft = !!frame.blinkL;
  blinkerRight = !!frame.blinkR;
  // Камера
  CAR.mode = frame.camMode;
  CAR.camYaw = frame.camYaw;
  CAR.camPitch = frame.camPitch;
  CAR.camDist = frame.camDist;
  // Салоно: сразу задаём и текущие, и целевые значения, чтобы интерполяция не дергала
  CAR.lookYaw = frame.lookYaw;
  CAR.lookPitch = frame.lookPitch;
  CAR.lookYawTarget = frame.lookYaw;
  CAR.lookPitchTarget = frame.lookPitch;
  // Угол обзора салона из записи (зум). Старых записей без поля не трогаем.
  if (isFinite(frame.camFov)) {
    if (typeof setCamFov === 'function') setCamFov(frame.camFov);
    else { CAR.camFov = frame.camFov; }
  }
  // X-ray режим
  if (typeof xrayOn !== 'undefined' && typeof toggleXray === 'function' && frame.xray !== xrayOn) {
    toggleXray();
  }
  if (typeof applyCamMode === 'function') applyCamMode();
  if (typeof syncBlinkBtns === 'function') syncBlinkBtns(true);
  if (typeof syncDvView === 'function') syncDvView();
  // Синхронизируем визуальное состояние поворотников сразу (tickBlink не вызывает applyBlink при выкл. поворотниках)
  if (typeof applyBlink === 'function') applyBlink();
  // Сбрасываем таймер автовозврата камеры, иначе camYaw затухнёт к 0
  CAR.idle = performance.now();
}

// Сбросить машину в состояние кадра (позиция, yaw, скорость)
function resetCarToFrame(frame) {
  if (!CAR.root) return;
  // Восстанавливаем только x,z — y устанавливает физика через groundY + lift
  CAR.root.position.set(frame.pos.x, frame.lift || 0, frame.pos.z);
  CAR.yaw = frame.yaw;
  CAR.v = frame.v;
  CAR.steer = frame.steer || 0;
  CAR.vy = frame.vy ?? 0;
  CAR.y = frame.groundY ?? frame.pos.y; // fallback на старый формат
  CAR.lift = frame.lift ?? 0;
  setCarYawQuat();
  // колёса: доворот — из steer кадра (как в drive()), прокрут продолжает
  // интегрироваться из скорости сам. Старые файлы с wheelAngles тоже грузятся:
  // их углы просто игнорируются.
  if (CAR.wheels) {
    for (const w of CAR.wheels) {
      if (w.front && w.steer) w.steer.rotation.y = CAR.steer;
    }
  }
}

// Ориентация кузова по yaw — тем же базисом, что applySupport() в drive().
// Раньше тут стоял RotationYawPitchRoll(CAR.yaw,0,0): он кладёт локальный +Z
// в (+sin,0,cos), а физика держит задок в (−sin,0,cos) — при yaw=±90° машина
// в предпросмотре стояла ровно задом наперёд относительно записи.
// Поэтому повторяем оси кузова из applySupport; на рельефе — через сэмпл опоры.
function setCarYawQuat() {
  if (typeof sampleSupport === 'function' && typeof applySupport === 'function') {
    try { sampleSupport(CAR.root.position.x, CAR.root.position.z, CAR.y); applySupport(); return; }
    catch (e) {}
  }
  const c = Math.cos(CAR.yaw), s = Math.sin(CAR.yaw);
  if (!CAR.root.rotationQuaternion) CAR.root.rotationQuaternion = new BABYLON.Quaternion();
  BABYLON.Quaternion.RotationQuaternionFromAxisToRef(
    new BABYLON.Vector3(c, 0, s),
    new BABYLON.Vector3(0, 1, 0),
    new BABYLON.Vector3(-s, 0, c),
    CAR.root.rotationQuaternion);
}

// Тик воспроизведения — вызывать в начале drive(dt, rawDt).
// Кинематика: часы стенные (rawDt без клампа — темп реальный на любом fps),
// поза — интерполяция соседних кадров по t. Просадки дают гладкость,
// а не расхождение: физика не считается, входы не нужны.
function replayTick(rawDt) {
  if (!isPlaying || !replayBuffer.length) return false; // false = не в воспроизведении

  replayTime += (isFinite(rawDt) && rawDt > 0) ? rawDt : REPLAY_TICK;
  const last = replayBuffer[replayBuffer.length - 1];

  // Конец реплея — встаём точно в последний кадр
  if (replayTime >= last.t) {
    applyKinematicFrame(last.t);
    updateReplayMessages(last.t);
    stopPlayback();
    return false;
  }
  applyKinematicFrame(replayTime);
  updateReplayMessages(replayTime);
  voiceTick(replayTime);
  return true;
}

// Телепорт в момент t: поза — интерполяция соседних кадров,
// дискретное (поворотники/камера/рентген) — из левого кадра.
function applyKinematicFrame(t) {
  const n = replayBuffer.length;
  const first = replayBuffer[0];
  if (t <= first.t) { resetCarToFrame(first); applyReplayFrame(first); return; }
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (replayBuffer[m].t <= t) lo = m; else hi = m; }
  const a = replayBuffer[lo], b = replayBuffer[lo + 1];
  const span = b.t - a.t;
  const k = span > 1e-6 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 0;
  resetCarToFrame({
    pos: { x: kinLerp(a.pos.x, b.pos.x, k), z: kinLerp(a.pos.z, b.pos.z, k) },
    yaw: kinLerpAngle(a.yaw, b.yaw, k),
    v: kinLerp(a.v, b.v, k),
    steer: kinLerp(a.steer || 0, b.steer || 0, k),
    vy: 0,
    groundY: kinLerp(a.groundY ?? 0, b.groundY ?? 0, k),
    lift: a.lift ?? 0,
  });
  applyReplayFrame(a);
  replayBlinkEdge(a);
}

// Фронт включения поворотника в записи: как рычаг в живой езде (toggleBlink
// сбрасывает blinkT в 0 — вспышка и щелчок сразу), иначе фаза свободная и
// мигание идёт со сдвигом относительно манёвра: «звук не с видео».
let prevRepBlinkL = false, prevRepBlinkR = false;
function replayBlinkEdge(frame) {
  try {
    const L = !!frame.blinkL, R = !!frame.blinkR;
    if ((L && !prevRepBlinkL) || (R && !prevRepBlinkR)) {
      if (typeof blinkT !== 'undefined') blinkT = 0;
      if (typeof applyBlink === 'function') applyBlink();
    }
    prevRepBlinkL = L;
    prevRepBlinkR = R;
  } catch (e) {}
}

const kinLerp = (a, b, k) => a + (b - a) * k;
// Интерполяция курса по кратчайшей дуге: без wrap разворот через ±π
// провернул бы машину через весь круг.
function kinLerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

// Визуал кинематики за кадр: прокрут от записанной скорости, доворот,
// руль в салоне, спидометр, следящая камера. Вызывается из drive() вместо физики.
function kinematicVisualTick(dt) {
  if (typeof CAR === 'undefined' || !CAR || !CAR.root) return;
  for (const w of CAR.wheels || []) {
    w.angle -= CAR.v / CAR.wheelR * dt;
    w.spin.rotation.x = w.angle;
    if (w.front) w.steer.rotation.y = CAR.steer;
  }
  if (CAR.steerWheel) {
    CAR.steerWheel.rotationQuaternion = CAR.steerWheelBase.multiply(
      BABYLON.Quaternion.RotationAxis(
        CAR.steerWheelAxis, -CAR.steer / CAR.maxSteer * Math.PI * 2 * CAR.steerWheelTurns));
  }
  try {
    if (typeof spdEl !== 'undefined' && spdEl) {
      const kmh = Math.abs(CAR.v) * 3.6;
      spdEl.firstChild.nodeValue = String(Math.round(kmh));
    }
  } catch (e) {}
  if (typeof editCameraTick === 'function') editCameraTick(dt);
}
// Хук в drive(): в начале функции добавить
// if (window.Replay?.isPlaying?.() && replayTickWithPause(rawDt)) { kinematicVisualTick(dt); return; }
// Чтение ручника через window._replayHandbrake больше не нужно: входов в реплее нет.

// Экспорт
window.Replay = {
  startRecording,
  stopRecording,
  downloadReplay,
  loadReplay,
  startPlayback,
  stopPlayback,
  isRecording: () => isRecording,
  isPlaying: () => isPlaying,
  isPaused: () => isPaused,
  isEditing: () => isEditing,
  getBuffer: () => replayBuffer,
  getMessages: () => replayMessages,
  getTime: () => replayTime,
  kinematicTick: kinematicVisualTick
};

// localStorage helpers
const REPLAY_STORAGE_KEY = 'gta4_replays';
function saveReplayToStorage(name, data) {
  try {
    const stored = JSON.parse(localStorage.getItem(REPLAY_STORAGE_KEY) || '{}');
    stored[name] = data;
    localStorage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch (e) { console.error('[Replay] Save failed:', e); return false; }
}
function loadReplayFromStorage(name) {
  try {
    const stored = JSON.parse(localStorage.getItem(REPLAY_STORAGE_KEY) || '{}');
    return stored[name] || null;
  } catch (e) { console.error('[Replay] Load failed:', e); return null; }
}
function listReplaysFromStorage() {
  try { return Object.keys(JSON.parse(localStorage.getItem(REPLAY_STORAGE_KEY) || '{}')); }
  catch { return []; }
}
function deleteReplayFromStorage(name) {
  try {
    const stored = JSON.parse(localStorage.getItem(REPLAY_STORAGE_KEY) || '{}');
    delete stored[name];
    localStorage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch (e) { console.error('[Replay] Delete failed:', e); return false; }
}

// UI для кнопки записи
let recBtn = null;
function initRecButton() {
  recBtn = document.getElementById('recBtn');
  if (!recBtn) return;
  recBtn.addEventListener('click', () => {
    if (window.Replay.isRecording()) {
      stopAndSave();
    } else {
      uiStartRecording();
    }
  });
  updateRecButton();
}
function updateRecButton() {
  if (!recBtn) return;
  const rec = window.Replay.isRecording();
  recBtn.classList.toggle('recording', rec);
  recBtn.setAttribute('aria-label', rec ? 'Остановить запись' : 'Начать запись');
  recBtn.title = rec ? 'Остановить запись (R)' : 'Начать запись (R)';
}
function uiStartRecording() {
  window.Replay.startRecording();
  updateRecButton();
}
function stopAndSave() {
  const data = window.Replay.stopRecording();
  if (!data) return;
  const name = 'replay_' + new Date().toISOString().replace(/[:.]/g, '-');
  if (saveReplayToStorage(name, data)) {
    console.log('[Replay] Saved to localStorage as:', name);
    showToast('Реплей сохранён: ' + name);
  } else {
    showToast('Ошибка сохранения');
  }
  updateRecButton();
}

// Горячая клавиша R для записи (когда не в меню)
addEventListener('keydown', e => {
  if (e.code === 'KeyR' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('#replayEditWin')) return;
    if (typeof isEditing !== 'undefined' && isEditing) return;
    const settingsWin = document.getElementById('settingsWin');
    const mirrorWin = document.getElementById('mirrorWin');
    if (settingsWin?.classList.contains('open') || mirrorWin?.classList.contains('open')) return;
    e.preventDefault();
    if (window.Replay.isRecording()) stopAndSave(); else uiStartRecording();
  }
});

// Инициализация кнопки
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRecButton);
} else {
  initRecButton();
}

// Replay List Window
let replayWin = null, replayBackdrop = null, replayListEl = null;
function initReplayWindow() {
  replayWin = document.getElementById('replayWin');
  replayBackdrop = document.getElementById('replayBackdrop');
  replayListEl = document.getElementById('replayList');
  if (!replayWin || !replayBackdrop || !replayListEl) return;

  document.getElementById('replayListBtn')?.addEventListener('click', () => {
    openSettings(false);
    openReplayList(true);
  });
  document.getElementById('replayClose')?.addEventListener('click', () => openReplayList(false));
  replayBackdrop?.addEventListener('click', () => openReplayList(false));
}
function openReplayList(open) {
  if (!replayWin || !replayBackdrop) return;
  replayWin.classList.toggle('open', open);
  replayBackdrop.classList.toggle('open', open);
  if (open) renderReplayList();
}
function renderReplayList() {
  if (!replayListEl) return;
  const names = listReplaysFromStorage().sort().reverse(); // новые сверху
  if (!names.length) {
    replayListEl.innerHTML = '<div style="padding:16px;color:var(--dim);text-align:center;">Реплеев нет</div>';
    return;
  }
  replayListEl.innerHTML = names.map(name => {
    const data = loadReplayFromStorage(name);
    const dur = data?.duration ? data.duration.toFixed(1) + ' с' : '—';
    const frames = data?.frames?.length || 0;
    const msgs = Array.isArray(data?.messages) ? data.messages.length : 0;
    const date = name.replace('replay_', '').replace(/-/g, ':').replace('T', ' ');
    // размер записи по весу её JSON
    let size = '—';
    try {
      const bytes = JSON.stringify(data).length;
      size = bytes < 1024 ? bytes + ' Б' :
        bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' КБ' :
        (bytes / 1048576).toFixed(1) + ' МБ';
    } catch (e) {}
    return `<div class="replay-item" data-name="${name}" style="display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer;">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:13px;">${name}</div>
        <div style="font-size:11px;color:var(--dim);">${date} · ${dur} · ${frames} кадров · 💬${msgs} · ${size}</div>
      </div>
      <div style="display:flex;gap:6px;margin-left:8px;flex:0 0 auto">
        <button class="replay-mp4" data-name="${name}" style="padding:4px 10px;font-size:11px;background:rgba(98,208,223,.12);border:1px solid #62d0df;border-radius:6px;color:#62d0df;cursor:pointer;" title="Сохранить MP4 1080x1920">🎬</button>
        <button class="replay-edit" data-name="${name}" style="padding:4px 10px;font-size:11px;background:rgba(255,138,61,.15);border:1px solid var(--acc);border-radius:6px;color:var(--acc);cursor:pointer;" title="Редактировать сообщения">✎</button>
        <button class="replay-del" data-name="${name}" style="padding:4px 10px;font-size:11px;background:rgba(255,59,59,.2);border:1px solid #ff3b3b;border-radius:6px;color:#ff6b6b;cursor:pointer;">Удалить</button>
      </div>
    </div>`;
  }).join('');

  // Делегирование событий
  replayListEl.onclick = e => {
    const mp4Btn = e.target.closest('.replay-mp4');
    if (mp4Btn) {
      e.stopPropagation();
      if (typeof window.ExportMP4?.start === 'function') window.ExportMP4.start(mp4Btn.dataset.name);
      else showToast('Экспорт недоступен (нет export.js)');
      return;
    }
    const editBtn = e.target.closest('.replay-edit');
    if (editBtn) { e.stopPropagation(); openReplayEditor(editBtn.dataset.name); return; }
    const delBtn = e.target.closest('.replay-del');
    const item = e.target.closest('.replay-item');
    if (!item) return;
    const name = item.dataset.name;
    if (delBtn) {
      if (confirm('Удалить реплей ' + name + '?')) {
        deleteReplayFromStorage(name);
        renderReplayList();
      }
    } else {
      playReplay(name);
    }
  };
}
function playReplay(name) {
  const data = loadReplayFromStorage(name);
  if (!data) return;
  openReplayList(false);
  window.Replay.loadReplay(data);
  const msgs = (window.Replay.getMessages && window.Replay.getMessages()) || [];
  const canVoice = typeof ttsPrefetch === 'function' && typeof ttsHas === 'function';
  // Греть нечего (нет сообщений или всё уже в кэше) — играем сразу без лоадера.
  const cold = canVoice ? msgs.filter((m) => msgSpeech(m) && !ttsHas(m.voice || 'command', msgSpeech(m))) : [];
  if (!cold.length) {
    window.Replay.startPlayback();
    showToast('Воспроизведение: ' + name);
    return;
  }
  // Сначала грузим всю озвучку с прогрессом — и только потом стартуем,
  // чтобы не было «текст есть, а голоса нет».
  openVoiceLoad(true);
  updateVoiceLoad(0, Math.max(1, cold.length));
  const items = cold.map((m) => ({ voice: m.voice || 'command', text: msgSpeech(m) }));
  const prefetch = ttsPrefetch(items, (done, total) => updateVoiceLoad(done, total));
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('tts timeout')), 25000));
  Promise.race([prefetch, timeout]).then((stat) => {
    openVoiceLoad(false);
    const failed = Math.max(0, (stat && stat.total || 0) - (stat && stat.done || 0));
    window.Replay.startPlayback();
    showToast(failed > 0
      ? 'Озвучка загрузилась частично (' + failed + ' шт.) — остальное текстом'
      : 'Воспроизведение: ' + name);
  }).catch(() => {
    // Офлайн/таймаут: картинку не блокируем — едем с одними субтитрами.
    openVoiceLoad(false);
    window.Replay.startPlayback();
    showToast('Озвучка не загрузилась — только текст');
  });
}

// Лоадер предзагрузки озвучки (модалка с прогрессом перед стартом реплея).
function openVoiceLoad(open) {
  const w = document.getElementById('voiceLoadWin');
  const b = document.getElementById('voiceLoadBackdrop');
  if (w) w.classList.toggle('open', !!open);
  if (b) b.classList.toggle('open', !!open);
}
function updateVoiceLoad(done, total) {
  const f = document.getElementById('voiceLoadFill');
  const m = document.getElementById('voiceLoadMsg');
  const t = Math.max(1, total || 0), d = Math.min(done || 0, t);
  if (f) f.style.width = (d / t * 100).toFixed(1) + '%';
  if (m) m.textContent = (total || 0) > 0 ? ('Аудио: ' + d + ' / ' + total) : 'Подготовка…';
}

// ── Редактор записей ──────────────────────────────────────────────
// Открывает запись из хранилища, ставит машину в кадр ползунком,
// позволяет вставить текстовое сообщение в текущий момент с
// длительностью показа. При воспроизведении сообщение видно ровно
// на отрезке [t, t+dur).
let isEditing = false;
let editName = null;
let editIndex = 0;
let editPlaying = false;
let editTimer = 0;

function editEls() {
  return {
    win: document.getElementById('replayEditWin'),
    backdrop: document.getElementById('replayEditBackdrop'),
    title: document.getElementById('replayEditTitle'),
    scrub: document.getElementById('replayEditScrub'),
    time: document.getElementById('replayEditTime'),
    play: document.getElementById('replayEditPlay'),
    text: document.getElementById('replayEditText'),
    speech: document.getElementById('replayEditSpeech'),
    dur: document.getElementById('replayEditDur'),
    voice: document.getElementById('replayEditVoice'),
    msgs: document.getElementById('replayEditMsgs'),
    count: document.getElementById('replayEditCount'),
  };
}

function openReplayEditor(name) {
  const data = loadReplayFromStorage(name);
  if (!data) { showToast('Запись не найдена'); return; }
  if (isPlaying) stopPlayback();
  if (isRecording) { showToast('Сначала остановите запись'); return; }
  if (!window.Replay.loadReplay(data)) { showToast('Повреждённая запись'); return; }
  openReplayList(false);
  if (typeof openSettings === 'function') openSettings(false);
  editName = name;
  isEditing = true;
  editIndex = 0;
  setEditPlaying(false);
  document.body.classList.add('edit-active');
  const el = editEls();
  if (el.title) el.title.textContent = '✎ ' + name;
  if (el.win) el.win.classList.add('open');
  if (el.backdrop) el.backdrop.classList.add('open');
  seekEdit(0);
  renderEditMsgs();
  // R во время редактирования не должна стартовать новую запись
  console.log('[Replay] Edit opened:', name);
}

function closeReplayEditor() {
  setEditPlaying(false);
  isEditing = false;
  editName = null;
  document.body.classList.remove('edit-active');
  hideReplayMessages();
  const el = editEls();
  if (el.win) el.win.classList.remove('open');
  if (el.backdrop) el.backdrop.classList.remove('open');
  window._replayHandbrake = undefined;
  if (typeof touchThrottle !== 'undefined') touchThrottle = 0;
  if (typeof syncDvThrottle === 'function') syncDvThrottle();
  resetBlinkers();
}

function seekEdit(i) {
  if (!replayBuffer.length) return;
  editIndex = Math.max(0, Math.min(replayBuffer.length - 1, Math.round(i)));
  const frame = replayBuffer[editIndex];
  if (!frame) return;
  // Ставим машину точно в кадр (поза + камера + поворотники), физика заморожена
  resetCarToFrame(frame);
  applyReplayFrame(frame);
  try { replayBlinkEdge(frame); } catch (e) {}
  window._replayHandbrake = undefined; // в редакторе ручник не держим
  CAR.v = 0; CAR.vy = 0; // стоим на месте, иначе drive() увёз бы машину
  updateReplayMessages(frame.t);
  const el = editEls();
  if (el.scrub) {
    el.scrub.max = String(replayBuffer.length - 1);
    if (document.activeElement !== el.scrub) el.scrub.value = String(editIndex);
  }
  if (el.time) {
    const total = replayBuffer[replayBuffer.length - 1]?.t ?? 0;
    el.time.textContent = frame.t.toFixed(1) + ' / ' + total.toFixed(1) + ' с';
  }
}

function setEditPlaying(on) {
  editPlaying = !!on && isEditing;
  const el = editEls();
  if (el.play) { el.play.textContent = editPlaying ? '⏸' : '▶'; el.play.setAttribute('aria-label', editPlaying ? 'Пауза' : 'Предпросмотр'); }
  if (editTimer) { clearInterval(editTimer); editTimer = 0; }
  if (editPlaying) {
    editTimer = setInterval(() => {
      if (!isEditing || !replayBuffer.length) { setEditPlaying(false); return; }
      if (editIndex >= replayBuffer.length - 1) { setEditPlaying(false); seekEdit(replayBuffer.length - 1); return; }
      seekEdit(editIndex + 1);
      const el2 = editEls();
      if (el2.scrub) el2.scrub.value = String(editIndex);
    }, 1000 / 60);
  }
}

// Камера в редакторе: машина стоит, но вид должен следовать за кадром.
// Вызывается из drive() вместо физики (см. хук в index.html).
function editCameraTick(dt) {
  if (!CAR.root) return;
  const p = CAR.root.position;
  if (CAR.mode === 0) {
    camTargetTmp.set(p.x, p.y + 0.75, p.z);
    BABYLON.Vector3.LerpToRef(camTarget, camTargetTmp, 1 - Math.exp(-dt * 9), camTarget);
    cam.target.copyFrom(camTarget);
    const k = 1 - Math.exp(-dt * 5);
    let diff2 = (CAR.yaw + Math.PI / 2 + CAR.camYaw) - cam.alpha;
    while (diff2 > Math.PI) diff2 -= Math.PI * 2;
    while (diff2 < -Math.PI) diff2 += Math.PI * 2;
    cam.alpha = wrapAngle(cam.alpha + diff2 * k);
    cam.beta += (CAR.camPitch - cam.beta) * (1 - Math.exp(-dt * 7));
    cam.radius += (CAR.camDist - cam.radius) * (1 - Math.exp(-dt * 7));
  } else if (CAR.mode === 1 && typeof cockpit !== 'undefined' && cockpit) {
    const k = 1 - Math.exp(-dt * 10);
    CAR.lookYaw += (CAR.lookYawTarget - CAR.lookYaw) * k;
    CAR.lookPitch += (CAR.lookPitchTarget - CAR.lookPitch) * k;
    cockpit.rotation.set(COCKPIT_PITCH + CAR.lookPitch, Math.PI - CAR.lookYaw, 0);
  }
  // колёса стоят, но доворот руля показываем как в кадре
  if (CAR.wheels) for (const w of CAR.wheels) if (w.front && w.steer) w.steer.rotation.y = CAR.steer;
}

// Прослушивание со спиннером: пока грузится аудио, на кнопке крутится
// индикатор; страховка 15 с — зависший fetch не блокирует кнопку навсегда.
function hearWithSpinner(btn, voice, text) {
  if (typeof ttsPreview !== 'function') { showToast('Озвучка недоступна (нет tts.js)'); return; }
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    btn.disabled = false;
    btn.innerHTML = orig;
  };
  setTimeout(restore, 15000);
  try {
    const p = ttsPreview(voice, text);
    if (p && p.then) p.then(restore).catch(restore);
    else restore();
  } catch (e) { restore(); }
}

function renderEditMsgs() {  const el = editEls();
  if (!el.msgs) return;
  if (el.count) el.count.textContent = String(replayMessages.length);
  if (!replayMessages.length) {
    el.msgs.innerHTML = '<div style="padding:10px;color:var(--dim);text-align:center;font-size:12px;">Сообщений нет — выстави ползунок и нажми «Вставить здесь»</div>';
    return;
  }
  el.msgs.innerHTML = '';
  replayMessages.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'replay-edit-msg';
    const end = (m.t + m.dur).toFixed(1);
    row.innerHTML =
      '<button data-act="goto" title="Перейти к началу (' + m.t.toFixed(1) + ' с)" style="padding:4px 8px">⏵ ' + m.t.toFixed(1) + '–' + end + '</button>' +
      '<textarea data-act="text" maxlength="200" rows="2" title="Текст на экране"></textarea>' +
      '<textarea data-act="speech" maxlength="500" rows="2" title="Текст для озвучки (пусто = тишина)" placeholder="Озвучить текст"></textarea>' +
      '<input type="number" min="0.5" max="60" step="0.5" title="Длительность показа, с" value="' + m.dur + '">' +
      '<select data-act="voice" title="Голос озвучки"><option value="command">команда</option><option value="comment">коммент.</option></select>' +
      '<button data-act="hear" title="Прослушать" style="padding:4px 8px">🔊</button>' +
      '<button data-act="del" title="Удалить" style="padding:4px 8px">✕</button>';
    row.querySelector('[data-act=text]').value = m.text;
    row.querySelector('[data-act=speech]').value = m.speech || '';
    row.querySelector('[data-act=text]').addEventListener('change', (e) => {
      const v = e.target.value.trim().slice(0, 200);
      if (!v) { renderEditMsgs(); return; } // пустой текст не сохраняем
      replayMessages[idx].text = v;
    });
    row.querySelector('[data-act=speech]').addEventListener('change', (e) => {
      replayMessages[idx].speech = e.target.value.trim().slice(0, 500);
    });
    row.querySelector('input[type=number]').addEventListener('change', (e) => {
      let d = +e.target.value;
      if (!isFinite(d)) { e.target.value = m.dur; return; }
      replayMessages[idx].dur = Math.min(60, Math.max(0.5, Math.round(d * 10) / 10));
      e.target.value = replayMessages[idx].dur;
      updateReplayMessages(replayBuffer[editIndex]?.t ?? 0);
    });
    row.querySelector('[data-act=goto]').addEventListener('click', () => {
      // ищем ближайший кадр к t сообщения
      let best = 0, bd = 1e9;
      for (let i = 0; i < replayBuffer.length; i++) {
        const d = Math.abs(replayBuffer[i].t - m.t);
        if (d < bd) { bd = d; best = i; }
      }
      setEditPlaying(false);
      seekEdit(best);
      const s = editEls().scrub;
      if (s) s.value = String(best);
    });
    row.querySelector('[data-act=del]').addEventListener('click', () => {
      replayMessages.splice(idx, 1);
      renderEditMsgs();
      updateReplayMessages(replayBuffer[editIndex]?.t ?? 0);
    });
    const voiceSel = row.querySelector('[data-act=voice]');
    voiceSel.value = m.voice || 'command';
    voiceSel.addEventListener('change', (e) => {
      replayMessages[idx].voice = e.target.value === 'comment' ? 'comment' : 'command';
    });
    row.querySelector('[data-act=hear]').addEventListener('click', (e) => {
      const mm = replayMessages[idx];
      if (!mm) return;
      const v = voiceSel.value === 'comment' ? 'comment' : 'command';
      mm.voice = v;
      const s = msgSpeech(mm);
      if (!s) { showToast('Поле озвучки пусто — будет только текст'); return; }
      hearWithSpinner(e.currentTarget, v, s);
    });
    el.msgs.appendChild(row);
  });
}

function saveReplayEdits() {
  if (!editName) return;
  const data = loadReplayFromStorage(editName);
  if (!data) { showToast('Запись пропала'); return; }
  data.messages = replayMessages.map(m => ({ t: m.t, dur: m.dur, text: m.text, speech: m.speech || '', voice: m.voice || 'command' }));
  if (saveReplayToStorage(editName, data)) showToast('Сохранено: ' + editName);
  else showToast('Ошибка сохранения');
}

function initReplayEditor() {
  const el = editEls();
  if (!el.win) return;
  el.scrub?.addEventListener('input', () => { setEditPlaying(false); seekEdit(+el.scrub.value); });
  el.play?.addEventListener('click', () => setEditPlaying(!editPlaying));
  document.getElementById('replayEditHear')?.addEventListener('click', (e) => {
    if (!isEditing) return;
    const text = (el.text?.value ?? '').trim().slice(0, 200);
    if (!text) { showToast('Введите текст сообщения'); el.text?.focus(); return; }
    const voice = el.voice?.value === 'comment' ? 'comment' : 'command';
    const speech = (el.speech?.value ?? '').trim().slice(0, 500);
    if (!speech) { showToast('Поле озвучки пусто — будет только текст'); return; }
    hearWithSpinner(e.currentTarget, voice, speech);
  });
  document.getElementById('replayEditAdd')?.addEventListener('click', () => {    if (!isEditing || !replayBuffer.length) return;
    const text = (el.text?.value ?? '').trim().slice(0, 200);
    if (!text) { showToast('Введите текст сообщения'); el.text?.focus(); return; }
    let dur = +el.dur?.value;
    if (!isFinite(dur)) dur = 3;
    dur = Math.min(60, Math.max(0.5, Math.round(dur * 10) / 10));
    const t = replayBuffer[editIndex]?.t ?? 0;
    const voice = el.voice?.value === 'comment' ? 'comment' : 'command';
    const speech = (el.speech?.value ?? '').trim().slice(0, 500);
    replayMessages.push({ t, dur, text, speech, voice });
    replayMessages.sort((a, b) => a.t - b.t);
    if (el.text) el.text.value = '';
    if (el.speech) el.speech.value = '';
    renderEditMsgs();
    updateReplayMessages(t);
    showToast('Сообщение вставлено на ' + t.toFixed(1) + ' с');
  });
  document.getElementById('replayEditSave')?.addEventListener('click', saveReplayEdits);
  document.getElementById('replayEditExit')?.addEventListener('click', closeReplayEditor);
  document.getElementById('replayEditClose')?.addEventListener('click', closeReplayEditor);
  el.backdrop?.addEventListener('click', closeReplayEditor);
  addEventListener('keydown', (e) => {
    if (!isEditing) return;
    if (e.code === 'Escape') { e.preventDefault(); closeReplayEditor(); return; }
    // Фокус внутри панели редактора — хоткеи (включая пробел предпросмотра)
    // не перехватываем: поля, селекты, слайдер и кнопки работают нативно.
    const t = e.target;
    if (t && t.closest && t.closest('#replayEditWin')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      setEditPlaying(!editPlaying);
    }
  });
}

// Экспорт функций окна
window.Replay.openList = openReplayList;
window.Replay.saveReplayToStorage = saveReplayToStorage;
window.Replay.loadReplayFromStorage = loadReplayFromStorage;
window.Replay.listReplaysFromStorage = listReplaysFromStorage;
window.Replay.deleteReplayFromStorage = deleteReplayFromStorage;
window.Replay.openEditor = openReplayEditor;
window.Replay.closeEditor = closeReplayEditor;
window.Replay.editTick = editCameraTick;

// Инициализация окна реплеев
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initReplayWindow(); initReplayEditor(); });
} else {
  initReplayWindow();
  initReplayEditor();
}