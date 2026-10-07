// replay.js — запись и воспроизведение езды (детерминированный реплей)
// Подключается после drive-control.js, использует глобальные: CAR, keys, drive, ready, scene

const REPLAY_TICK = 1 / 60; // фиксированный таймстеп записи (60 Гц)
const REPLAY_FIXED_DT = REPLAY_TICK; // используем фиксированный dt для воспроизведения

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

// Нормализация сообщений: только {t, dur, text} с числами и непустым текстом.
function sanitizeMessages(src) {
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const t = +m.t, dur = +m.dur;
    const text = String(m.text ?? '').slice(0, 200);
    if (!isFinite(t) || !isFinite(dur) || t < 0 || dur <= 0 || !text.trim()) continue;
    out.push({ t: Math.round(t * 1000) / 1000, dur: Math.min(60, Math.max(0.5, Math.round(dur * 10) / 10)), text: text.trim() });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
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

// Начать воспроизведение
function startPlayback() {
  if (isRecording) stopRecording();
  if (isEditing) closeReplayEditor();
  if (!replayBuffer.length) { console.warn('[Replay] Buffer empty'); return; }
  isPlaying = true;
  isPaused = false;
  replayIndex = 0;
  replayTime = 0;
  // Сброс машины в начальное состояние реплея
  const first = replayBuffer[0];
  resetCarToFrame(first);
  updateReplayMessages(0);
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
  // Сбрасываем входы реплея, иначе машина продолжает ехать сама:
  // applyReplayFrame кладёт газ в touchThrottle, а ручник — в _replayHandbrake,
  // и без сброса drive() после выхода из реплея видит «нажатый газ».
  window._replayHandbrake = undefined;
  if (typeof touchThrottle !== 'undefined') touchThrottle = 0;
  if (typeof touchSteerEnabled !== 'undefined') touchSteerEnabled = false;
  if (typeof CAR !== 'undefined' && CAR) { CAR.v = 0; CAR.steer = 0; }
  if (typeof syncDvThrottle === 'function') syncDvThrottle();
  console.log('[Replay] Playback stopped');
}

let isPaused = false;

// Пауза/возобновление
function togglePlaybackPause() {
  if (!isPlaying && !isPaused) return;
  isPaused = !isPaused;
  updatePauseButton();
  if (!isPaused) {
    // возобновляем — сбрасываем replayTime к текущему кадру, чтобы не было скачка
    const frame = replayBuffer[replayIndex];
    if (frame) replayTime = frame.t;
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

// Обёртка над replayTick с учётом паузы
function replayTickWithPause(dt) {
  if (!isPlaying && !isPaused) return false;
  if (isPaused) return true; // просто ждём
  return replayTick(dt);
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

// Применить кадр реплея к машине (вызывается в drive() вместо чтения keys)
function applyReplayFrame(frame) {
  // Входы
  touchThrottle = frame.throttle;
  CAR.steer = frame.steer;
  // handbrake не сохраняем в CAR напрямую — нужен флаг для drive()
  window._replayHandbrake = frame.handbrake;
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

// Тик воспроизведения — вызывать в начале drive(dt)
// Используем фиксированный таймстеп для детерминированности
function replayTick(dt) {
  if (!isPlaying || !replayBuffer.length) return false; // false = не в воспроизведении

  // Фиксированный шаг физики (как при записи 60 Гц)
  replayTime += REPLAY_FIXED_DT;
  const targetTime = replayBuffer[replayIndex]?.t || 0;

  // Если опередили запись — ждём (не должно случиться при фиксированном шаге)
  if (replayTime < targetTime - 0.001) return true;

  // Применяем кадр
  applyReplayFrame(replayBuffer[replayIndex]);
  replayIndex++;

  // Конец реплея
  if (replayIndex >= replayBuffer.length) {
    stopPlayback();
    return false;
  }
  updateReplayMessages(replayTime);
  return true;
}
// Хук в drive(): в начале функции добавить
// if (isPlaying) { if (!replayTick(dt)) return; /* дальше идёт физика с уже подставленными входами */ }
// И в месте чтения handbrake: использовать window._replayHandbrake вместо keys.Space

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
  FIXED_DT: REPLAY_FIXED_DT
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
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
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
        <button class="replay-edit" data-name="${name}" style="padding:4px 10px;font-size:11px;background:rgba(255,138,61,.15);border:1px solid var(--acc);border-radius:6px;color:var(--acc);cursor:pointer;" title="Редактировать сообщения">✎</button>
        <button class="replay-del" data-name="${name}" style="padding:4px 10px;font-size:11px;background:rgba(255,59,59,.2);border:1px solid #ff3b3b;border-radius:6px;color:#ff6b6b;cursor:pointer;">Удалить</button>
      </div>
    </div>`;
  }).join('');

  // Делегирование событий
  replayListEl.onclick = e => {
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
  window.Replay.startPlayback();
  showToast('Воспроизведение: ' + name);
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
    dur: document.getElementById('replayEditDur'),
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
}

function seekEdit(i) {
  if (!replayBuffer.length) return;
  editIndex = Math.max(0, Math.min(replayBuffer.length - 1, Math.round(i)));
  const frame = replayBuffer[editIndex];
  if (!frame) return;
  // Ставим машину точно в кадр (позиция + входы + камера), физика заморожена
  resetCarToFrame(frame);
  applyReplayFrame(frame);
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

function renderEditMsgs() {
  const el = editEls();
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
      '<input type="text" maxlength="200" value="">' +
      '<input type="number" min="0.5" max="60" step="0.5" title="Длительность показа, с" value="' + m.dur + '">' +
      '<button data-act="del" title="Удалить" style="padding:4px 8px">✕</button>';
    row.querySelector('input[type=text]').value = m.text;
    row.querySelector('input[type=text]').addEventListener('change', (e) => {
      const v = e.target.value.trim().slice(0, 200);
      if (!v) { renderEditMsgs(); return; } // пустой текст не сохраняем
      replayMessages[idx].text = v;
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
    el.msgs.appendChild(row);
  });
}

function saveReplayEdits() {
  if (!editName) return;
  const data = loadReplayFromStorage(editName);
  if (!data) { showToast('Запись пропала'); return; }
  data.messages = replayMessages.map(m => ({ t: m.t, dur: m.dur, text: m.text }));
  if (saveReplayToStorage(editName, data)) showToast('Сохранено: ' + editName);
  else showToast('Ошибка сохранения');
}

function initReplayEditor() {
  const el = editEls();
  if (!el.win) return;
  el.scrub?.addEventListener('input', () => { setEditPlaying(false); seekEdit(+el.scrub.value); });
  el.play?.addEventListener('click', () => setEditPlaying(!editPlaying));
  document.getElementById('replayEditAdd')?.addEventListener('click', () => {
    if (!isEditing || !replayBuffer.length) return;
    const text = (el.text?.value ?? '').trim().slice(0, 200);
    if (!text) { showToast('Введите текст сообщения'); el.text?.focus(); return; }
    let dur = +el.dur?.value;
    if (!isFinite(dur)) dur = 3;
    dur = Math.min(60, Math.max(0.5, Math.round(dur * 10) / 10));
    const t = replayBuffer[editIndex]?.t ?? 0;
    replayMessages.push({ t, dur, text });
    replayMessages.sort((a, b) => a.t - b.t);
    if (el.text) el.text.value = '';
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
    if (e.code === 'Escape') { e.preventDefault(); closeReplayEditor(); }
    else if (e.code === 'Space' && document.activeElement !== el.text) {
      // пробел в редакторе = play/pause предпросмотра, а не ручник
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