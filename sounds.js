// sounds.js — звуковой движок приложения
// Подключается после drive-control.js, использует глобальные: scene, BABYLON, CAR, blinkerLeft, blinkerRight, blinkOn

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
const soundBuffers = new Map();
// Общая шина: все звуки идут через неё в колонки, а на время экспорта MP4
// к ней цепляется ещё и MediaStreamDestination (см. export.js).
let soundBus = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (!soundBus) {
    soundBus = audioCtx.createGain();
    soundBus.gain.value = masterVolume;
    soundBus.connect(audioCtx.destination);
  }
  return audioCtx;
}
// Узел для подключения рекордера/TTS. Создаёт контекст при необходимости.
function soundBusNode() {
  try {
    if (typeof ensureAudioContext === 'function') ensureAudioContext();
  } catch (e) {}
  return soundBus;
}
// Куда выводить очередной звук: в шину, а если её нет — напрямую.
function soundOut(ctx) {
  return soundBus || ctx.destination;
}

// Контекст разрешают запускать только из жеста (тап/клавиша): будим его
// заранее, иначе первый щелчок планируется в suspended-контексте с
// замороженным временем и выстреливает пачкой позже — мимо мигания.
// Render loop для разблокировки не годится — там жеста нет.
const unlockSounds = () => { try { ensureAudioContext(); } catch (e) {} };
addEventListener('pointerdown', unlockSounds);
addEventListener('keydown', unlockSounds);

// Живой контекст или null: планировать звук в suspended нельзя —
// source.start() встанет на замороженное время 0 и бахнет позже всех,
// сбивая ритм. Лучше пропустить один щелчок, чем выстрелить пачкой.
function liveAudioCtx() {
  let ctx;
  try { ctx = ensureAudioContext(); } catch (e) { return null; }
  if (!ctx || ctx.state !== 'running') return null;
  return ctx;
}

// Задержка старта коротких звуков относительно фронта события, с.
// Нужна только в MP4-экспорте: видеотрек проходит конвейер (рендер 1080x1920,
// композит, кодер, муксер) на 1–3 кадра дольше, чем звук из графа, и в файле
// щелчок слышен раньше вспышки. В живой езде всегда 0 — там звук и так идёт
// через железо с собственной задержкой. Ставит export.js на время записи.
let blinkStartDelay = 0;
window.setBlinkStartDelay = (v) => { blinkStartDelay = Math.max(0, +v || 0); };
function clickStart(src, ctx) {
  if (blinkStartDelay > 0.004) src.start(ctx.currentTime + blinkStartDelay);
  else src.start();
}

// Генерация реалистичного щелчка реле поворотника
function createBlinkClickBuffers(ctx) {
  const sampleRate = ctx.sampleRate;

  // ON click — глухой механический щелчок (замыкание)
  const onDur = 0.035;
  const onSamples = Math.floor(sampleRate * onDur);
  const onBuffer = ctx.createBuffer(1, onSamples, sampleRate);
  const onData = onBuffer.getChannelData(0);

  // OFF click — ещё более глухой (размыкание)
  const offDur = 0.045;
  const offSamples = Math.floor(sampleRate * offDur);
  const offBuffer = ctx.createBuffer(1, offSamples, sampleRate);
  const offData = offBuffer.getChannelData(0);

  for (let i = 0; i < onSamples; i++) {
    const t = i / sampleRate;
    // Глухой импульс + низкий резонанс корпуса ~600-900 Гц
    const impulse = Math.exp(-t * 600) * 0.6;
    const resonance = Math.sin(2 * Math.PI * 850 * t) * Math.exp(-t * 150) * 0.35;
    const body = Math.sin(2 * Math.PI * 300 * t) * Math.exp(-t * 50) * 0.2;
    onData[i] = (impulse + resonance + body) * 0.45;
  }

  for (let i = 0; i < offSamples; i++) {
    const t = i / sampleRate;
    // Ещё более приглушённый, низкий, "вязкий"
    const impulse = Math.exp(-t * 350) * 0.45;
    const resonance = Math.sin(2 * Math.PI * 650 * t) * Math.exp(-t * 120) * 0.3;
    const body = Math.sin(2 * Math.PI * 250 * t) * Math.exp(-t * 35) * 0.15;
    offData[i] = (impulse + resonance + body) * 0.45;
  }

  return { on: onBuffer, off: offBuffer };
}

function playBlinkClick(isOn) {
  const ctx = liveAudioCtx();
  if (!ctx) return;
  if (!soundBuffers.has('blinkClick')) {
    soundBuffers.set('blinkClick', createBlinkClickBuffers(ctx));
  }
  const buffers = soundBuffers.get('blinkClick');
  const buffer = isOn ? buffers.on : buffers.off;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.7;
  source.connect(gain).connect(soundOut(ctx));
  clickStart(source, ctx);
}

// Отслеживание состояния мигания (blinkOn из drive-control.js)
let lastBlinkOn = false;
let lastBlinkerLeft = false;
let lastBlinkerRight = false;

function tickBlinkSounds() {
  if (typeof blinkerLeft === 'undefined' || typeof blinkerRight === 'undefined') return;
  if (typeof blinkOn === 'undefined') return;

  // Щелчок на ВКЛЮЧЕНИЕ И ВЫКЛЮЧЕНИЕ лампочки (как в жизни — два щелчка за цикл)
  // Но только если какой-то поворотник активен
  const anyBlinker = blinkerLeft || blinkerRight;
  if (anyBlinker && blinkOn !== lastBlinkOn) {
    playBlinkClick(blinkOn); // true = ON click, false = OFF click
  }
  lastBlinkOn = blinkOn;

  // Сброс при переключении сторон
  if (blinkerLeft !== lastBlinkerLeft || blinkerRight !== lastBlinkerRight) {
    lastBlinkOn = blinkOn; // синхронизируем, чтобы не было лишнего щелчка при смене стороны
  }
  lastBlinkerLeft = blinkerLeft;
  lastBlinkerRight = blinkerRight;
}

// Запуск тика звуков в основном рендер-лупе (index.html вызывает tickBlinkSounds)
window.tickBlinkSounds = tickBlinkSounds;

// Громкость мастер (0..1)
let masterVolume = 1;
window.setMasterVolume = (v) => {
  masterVolume = Math.max(0, Math.min(1, v));
  try { if (soundBus) soundBus.gain.value = masterVolume; } catch (e) {}
};
window.getMasterVolume = () => masterVolume;

// Громкий БИП при сбитии конуса
function createConeHitBuffer(ctx) {
  const sampleRate = ctx.sampleRate;
  const duration = 0.25;
  const samples = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(1, samples, sampleRate);
  const data = buffer.getChannelData(0);

  // Резкий пик 1200 Гц -> 800 Гц с быстрым затуханием, много гармоник
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const freq = 1200 * Math.exp(-t * 8) + 800;
    const envelope = Math.exp(-t * 12);
    // Добавляем квадратную волну для "пищалки"
    const square = Math.sign(Math.sin(2 * Math.PI * freq * t));
    const sine = Math.sin(2 * Math.PI * freq * t);
    data[i] = (square * 0.6 + sine * 0.4) * envelope * 0.8;
  }
  return buffer;
}

function playConeHit() {
  const ctx = liveAudioCtx();
  if (!ctx) return;
  if (!soundBuffers.has('coneHit')) {
    soundBuffers.set('coneHit', createConeHitBuffer(ctx));
  }
  const buffer = soundBuffers.get('coneHit');
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 1.0; // громко
  source.connect(gain).connect(soundOut(ctx));
  clickStart(source, ctx);
}

window.playConeHit = playConeHit;