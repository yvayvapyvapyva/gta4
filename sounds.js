// sounds.js — звуковой движок приложения
// Подключается после drive-control.js, использует глобальные: scene, BABYLON, CAR, blinkerLeft, blinkerRight, blinkOn

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
const soundBuffers = new Map();
// Общая шина: все звуки идут через неё в колонки.
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

// Контекст разрешают запускать только из жеста: будим заранее первым
// тапом/клавишей, иначе на мобильных он висит suspended и планировать нечего.
addEventListener('pointerdown', () => { try { ensureAudioContext(); } catch (e) {} });
addEventListener('keydown', () => { try { ensureAudioContext(); } catch (e) {} });

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

function playBlinkClick(isOn, when) {
  let ctx;
  try { ctx = ensureAudioContext(); } catch (e) { return; }
  if (!ctx || ctx.state !== 'running') return;
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
  // when — точное аудиовремя фронта от планировщика ниже; без него — сразу
  if (when != null && isFinite(when) && when > ctx.currentTime + 0.005) source.start(when);
  else source.start();
}

// ── Планировщик щелчков ─────────────────────────────────────────────
// Раньше щелчок играл в момент детекции фронта в render loop. В живой езде
// кадры по 16 мс — ошибка неслышна, а под нагрузкой кадры тянутся по 100+ мс:
// каждый щелчок опаздывал до кадра, нерегулярно — ритм сбивался.
// Теперь сетка фронтов считается от стенных часов независимо от кадров:
// период 0.8 с, фронты каждые 0.4 с от сброса фазы (BLINK/BLINK_DUTY из
// drive-control.js), чётный фронт — щелчок ON, нечётный — OFF. Каждый фронт
// планируется один раз заранее на аудиочасах. Дёргается и из render loop,
// и своим 25-мс таймером — кто раньше увидит окно планирования, тот и ставит.
const BLINK_EDGE = 0.4;      // интервал между фронтами, с
const BLINK_AHEAD = 0.3;     // за сколько планируем фронт, с
const BLINK_SKIP_LATE = 0.15; // фронт старше этого — молча пропускаем, не догоняем
let blinkPhaseT0 = 0;   // wall-время сброса фазы (performance.now()/1000)
let blinkSchedIdx = -1; // индекс последнего запланированного фронта
let blinkLastT = 0;     // прошлый blinkT: по откату назад ловим сброс фазы
let blinkWasActive = false;

function tickBlinkSounds() {
  if (typeof blinkerLeft === 'undefined' || typeof blinkerRight === 'undefined') return;
  if (typeof blinkOn === 'undefined') return;
  const active = !!(blinkerLeft || blinkerRight);
  let ctx;
  try { ctx = ensureAudioContext(); } catch (e) { return; }
  if (!ctx || ctx.state !== 'running') return;
  const pNow = performance.now() / 1000;
  const bt = (typeof blinkT === 'number' && isFinite(blinkT)) ? blinkT : 0;
  if (!active) {
    // всё выключили — сброс, следующий вкл начнёт сетку заново
    blinkSchedIdx = -1;
    blinkWasActive = false;
    blinkLastT = bt;
    return;
  }
  if (!blinkWasActive || bt < blinkLastT - 1e-4) {
    // включение или сброс фазы (рычаг/фронт записи ставит blinkT=0) —
    // привязываем сетку к текущему моменту
    blinkPhaseT0 = pNow - bt;
    blinkSchedIdx = -1;
    // свежий фронт ON в точке сброса: лампа уже горит — щёлкаем сразу,
    // иначе включение останется без щелчка до первого OFF
    if (bt < BLINK_EDGE) {
      playBlinkClick(true, null);
      blinkSchedIdx = 0;
    }
  }
  blinkWasActive = true;
  blinkLastT = bt;
  // первый фронт строго после текущей фазы
  const phase = pNow - blinkPhaseT0;
  const idx = Math.floor(phase / BLINK_EDGE + 1e-6) + 1;
  if (idx <= blinkSchedIdx) return; // уже запланирован
  const edgeIn = (blinkPhaseT0 + idx * BLINK_EDGE) - pNow;
  if (edgeIn > BLINK_AHEAD) return; // рано, подойдём ближе следующим тиком
  if (edgeIn < -BLINK_SKIP_LATE) { blinkSchedIdx = idx; return; } // проспали — пропускаем
  playBlinkClick(idx % 2 === 0, ctx.currentTime + Math.max(0, edgeIn));
  blinkSchedIdx = idx;
}

// Запуск тика звуков в основном рендер-лупе (index.html вызывает tickBlinkSounds).
// Свой частый таймер — чтобы планирование не зависело от темпа кадров.
window.tickBlinkSounds = tickBlinkSounds;
setInterval(tickBlinkSounds, 25);

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
  const ctx = ensureAudioContext();
  if (!soundBuffers.has('coneHit')) {
    soundBuffers.set('coneHit', createConeHitBuffer(ctx));
  }
  const buffer = soundBuffers.get('coneHit');
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 1.0; // громко
  source.connect(gain).connect(soundOut(ctx));
  source.start();
}

window.playConeHit = playConeHit;