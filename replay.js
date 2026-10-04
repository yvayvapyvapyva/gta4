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

// Сохранение текущих входов в буфер
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

  const steer = CAR.steer; // текущий угол руля (рад)
  const handbrake = keys.Space ? 1 : 0;

  // Углы вращения колёс
  const wheelAngles = CAR.wheels ? CAR.wheels.map(w => w.angle || 0) : [];
  const wheelSteers = CAR.wheels ? CAR.wheels.map(w => w.steer?.rotation?.y || 0) : [];

  const frame = {
    t: (now - replayStartTime) / 1000, // секунды от старта
    throttle,
    steer,
    handbrake,
    blinkL: blinkerLeft ? 1 : 0,
    blinkR: blinkerRight ? 1 : 0,
    camMode: CAR.mode,
    camYaw: CAR.camYaw,
    camPitch: CAR.camPitch,
    camDist: CAR.camDist,
    lookYaw: CAR.lookYaw,
    lookPitch: CAR.lookPitch,
    // полное состояние физики
    pos: { x: CAR.root.position.x, z: CAR.root.position.z },
    groundY: CAR.y,
    lift: CAR.lift,
    yaw: CAR.yaw,
    v: CAR.v,
    vy: CAR.vy,
    wheelAngles,
    wheelSteers,
    xray: typeof xrayOn !== 'undefined' ? xrayOn : false
  };
  replayBuffer.push(frame);
}

// Начать запись
function startRecording() {
  if (isPlaying) stopPlayback();
  isRecording = true;
  replayBuffer = [];
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
    frames: replayBuffer
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
  replayIndex = 0;
  replayAccumulator = 0;
  console.log('[Replay] Loaded, frames:', replayBuffer.length, 'duration:', json.duration);
  return true;
}

// Начать воспроизведение
function startPlayback() {
  if (isRecording) stopRecording();
  if (!replayBuffer.length) { console.warn('[Replay] Buffer empty'); return; }
  isPlaying = true;
  isPaused = false;
  replayIndex = 0;
  replayTime = 0;
  // Сброс машины в начальное состояние реплея
  const first = replayBuffer[0];
  resetCarToFrame(first);
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
  CAR.root.rotationQuaternion = CAR.root.rotationQuaternion || new BABYLON.Quaternion();
  CAR.root.rotationQuaternion.copyFrom(BABYLON.Quaternion.RotationYawPitchRoll(CAR.yaw, 0, 0));
  // колёса — восстанавливаем углы вращения и поворот
  if (CAR.wheels && frame.wheelAngles) {
    for (let i = 0; i < CAR.wheels.length; i++) {
      const w = CAR.wheels[i];
      w.angle = frame.wheelAngles[i] || 0;
      if (w.spin) w.spin.rotation.x = w.angle;
      if (w.steer && frame.wheelSteers) w.steer.rotation.y = frame.wheelSteers[i] || 0;
    }
  }
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
  getBuffer: () => replayBuffer,
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
    const settingsWin = document.getElementById('settingsWin');
    const mapWin = document.getElementById('mapWin');
    const typeWin = document.getElementById('typeWin');
    if (settingsWin?.classList.contains('open') || mapWin?.classList.contains('open') || typeWin?.classList.contains('open')) return;
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
    const date = name.replace('replay_', '').replace(/-/g, ':').replace('T', ' ');
    return `<div class="replay-item" data-name="${name}" style="display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer;">
      <div>
        <div style="font-weight:600;font-size:13px;">${name}</div>
        <div style="font-size:11px;color:var(--dim);">${date} · ${dur} · ${frames} кадров</div>
      </div>
      <button class="replay-del" data-name="${name}" style="margin-left:8px;padding:4px 10px;font-size:11px;background:rgba(255,59,59,.2);border:1px solid #ff3b3b;border-radius:6px;color:#ff6b6b;cursor:pointer;">Удалить</button>
    </div>`;
  }).join('');

  // Делегирование событий
  replayListEl.onclick = e => {
    const item = e.target.closest('.replay-item');
    if (!item) return;
    const name = item.dataset.name;
    if (e.target.classList.contains('replay-del') || e.shiftKey) {
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

// Экспорт функций окна
window.Replay.openList = openReplayList;
window.Replay.saveReplayToStorage = saveReplayToStorage;
window.Replay.loadReplayFromStorage = loadReplayFromStorage;
window.Replay.listReplaysFromStorage = listReplaysFromStorage;
window.Replay.deleteReplayFromStorage = deleteReplayFromStorage;

// Инициализация окна реплеев
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initReplayWindow);
} else {
  initReplayWindow();
}