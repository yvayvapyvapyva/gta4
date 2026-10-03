// sounds.js — звуковой движок приложения
// Подключается после drive-control.js, использует глобальные: scene, BABYLON, CAR, blinkerLeft, blinkerRight, blinkOn

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
const soundBuffers = new Map();

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
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
  const ctx = ensureAudioContext();
  if (!soundBuffers.has('blinkClick')) {
    soundBuffers.set('blinkClick', createBlinkClickBuffers(ctx));
  }
  const buffers = soundBuffers.get('blinkClick');
  const buffer = isOn ? buffers.on : buffers.off;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.7;
  source.connect(gain).connect(ctx.destination);
  source.start();
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
window.setMasterVolume = (v) => { masterVolume = Math.max(0, Math.min(1, v)); };
window.getMasterVolume = () => masterVolume;