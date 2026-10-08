// tts.js — озвучка текстовых сообщений реплея через ту же Yandex Cloud
// Function, что используется в проекте onepage2 (edge-tts + кэш YDB
// на стороне функции).
//
// API: POST { batches: [{ voice_type: "command"|"comment", texts: [...] }] }
// Ответ: { audios: { "текст": "<base64 mp3>" }, format: "mp3" }.
// Голоса на стороне функции: command = ru-RU-DmitryNeural,
// comment = ru-RU-SvetlanaNeural.
//
// Подключается после replay.js. Связь с реплеем — через typeof-гарды:
// replay.js сам дёргает ttsPrefetch/ttsSpeak/ttsStop, этот модуль ничего
// о реплее не знает.

const TTS_API_URL = 'https://functions.yandexcloud.net/d4erngid6s4rf5oinnp1';

const ttsCache = new Map(); // "voice\ntext" -> blob-URL mp3
let ttsAudio = null;
let ttsQueue = [];   // [{voice, text}] — озвучиваем строго по очереди, без каши
let ttsBusy = false;
let ttsVoiceOn = true;
try { ttsVoiceOn = localStorage.getItem('gta4_voice_on') !== '0'; } catch (e) {}

const ttsKey = (voice, text) => voice + '\n' + text;

function ttsEl() {
  if (!ttsAudio) { ttsAudio = new Audio(); ttsAudio.preload = 'auto'; }
  return ttsAudio;
}

// Мобильные браузеры режут programmatic play() без жеста: первым касанием
// или клавишей прогоняем тихий wav — дальше autoplay разрешён (sticky).
let ttsUnlocked = false;
function ttsUnlock() {
  if (ttsUnlocked) return;
  ttsUnlocked = true;
  try {
    const a = ttsEl();
    a.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAA';
    const p = a.play();
    if (p && p.then) p.then(() => { try { a.pause(); } catch (e) {} }).catch(() => {});
  } catch (e) {}
}
addEventListener('pointerdown', ttsUnlock);
addEventListener('keydown', ttsUnlock);

// Докачка текстов одного голоса, которых нет в кэше.
// Режет на чанки, чтобы предзагрузка давала живой прогресс.
// onChunk(ok, fail) — после каждого чанка.
const TTS_CHUNK = 5;
async function ttsEnsure(voice, texts, onChunk) {
  const miss = [...new Set(texts)].filter((t) => t && t.trim() && !ttsCache.has(ttsKey(voice, t)));
  for (let i = 0; i < miss.length; i += TTS_CHUNK) {
    const chunk = miss.slice(i, i + TTS_CHUNK);
    let ok = 0;
    try {
      const resp = await fetch(TTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batches: [{ voice_type: voice, texts: chunk }] }),
      });
      const data = await resp.json();
      if (data && data.audios) {
        for (const [text, b64] of Object.entries(data.audios)) {
          try {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
            ttsCache.set(ttsKey(voice, text), URL.createObjectURL(new Blob([bytes], { type: 'audio/mp3' })));
            ok++;
          } catch (e) {}
        }
      }
    } catch (e) { console.warn('[TTS] chunk:', e); }
    try { onChunk && onChunk(ok, chunk.length - ok); } catch (e) {}
  }
}

// Есть ли текст в кэше (чтобы пропустить лоадер, когда греть нечего).
function ttsHas(voice, text) {
  return ttsCache.has(ttsKey(voice === 'comment' ? 'comment' : 'command', text));
}

// Предзагрузка всех сообщений записи (по одному запросу на голос).
// onProgress(done, total) — после каждого чанка. Возвращает { done, total }.
async function ttsPrefetch(items, onProgress) {
  const byVoice = {};
  for (const it of items || []) {
    if (!it || !it.text) continue;
    const v = it.voice === 'comment' ? 'comment' : 'command';
    (byVoice[v] || (byVoice[v] = new Set())).add(it.text);
  }
  let total = 0;
  for (const v of Object.keys(byVoice)) total += byVoice[v].size;
  let done = 0;
  const report = () => { try { onProgress && onProgress(done, total); } catch (e) {} };
  report();
  for (const v of Object.keys(byVoice)) {
    await ttsEnsure(v, [...byVoice[v]], (ok) => { done += ok; report(); });
  }
  return { done, total };
}

// В очередь на озвучку (порядок = порядок активации сообщений).
function ttsSpeak(voice, text) {
  if (!text) return;
  ttsQueue.push({ voice: voice === 'comment' ? 'comment' : 'command', text });
  ttsPump();
}

function ttsPump() {
  if (ttsBusy) return;
  const item = ttsQueue.shift();
  if (!item) return;
  const url = ttsCache.get(ttsKey(item.voice, item.text));
  if (!url) {
    // В кэше нет (офлайн на старте) — докачиваем и переигрываем этот пункт.
    ttsBusy = true;
    ttsEnsure(item.voice, [item.text]).then(() => {
      ttsBusy = false;
      if (ttsCache.has(ttsKey(item.voice, item.text))) ttsQueue.unshift(item);
      ttsPump();
    }).catch(() => { ttsBusy = false; ttsPump(); });
    return;
  }
  try {
    ttsBusy = true;
    const a = ttsEl();
    a.onended = () => { ttsBusy = false; ttsPump(); };
    a.onerror = () => { ttsBusy = false; ttsPump(); };
    a.src = url;
    const p = a.play();
    // play() без свежего жеста браузер может отклонить — текст всё равно
    // показан оверлеем, очередь молча едет дальше.
    if (p && p.catch) p.catch(() => { ttsBusy = false; ttsPump(); });
  } catch (e) { ttsBusy = false; ttsPump(); }
}

function ttsStop() {
  ttsQueue.length = 0;
  ttsBusy = false;
  try { const a = ttsEl(); a.onended = null; a.onerror = null; a.pause(); } catch (e) {}
}

// Кнопка 🔊 в редакторе: прослушать один текст сразу (мимо очереди).
function ttsPreview(voice, text) {
  if (!text || !text.trim()) return;
  ttsEnsure(voice, [text]).then(() => {
    const url = ttsCache.get(ttsKey(voice === 'comment' ? 'comment' : 'command', text));
    if (!url) return;
    try {
      const a = ttsEl();
      a.onended = null; a.onerror = null;
      a.src = url;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }).catch(() => {});
}

// Тумблер озвучки при воспроизведении (кнопка в playbackUI).
function ttsSetOn(on) {
  ttsVoiceOn = !!on;
  try { localStorage.setItem('gta4_voice_on', ttsVoiceOn ? '1' : '0'); } catch (e) {}
  if (!ttsVoiceOn) ttsStop();
  syncTtsBtn();
}
function syncTtsBtn() {
  const b = document.getElementById('playbackMute');
  if (b) { b.textContent = ttsVoiceOn ? '🔊' : '🔇'; b.classList.toggle('on', ttsVoiceOn); }
}
function initTtsBtn() {
  syncTtsBtn();
  document.getElementById('playbackMute')?.addEventListener('click', () => ttsSetOn(!ttsVoiceOn));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTtsBtn);
} else {
  initTtsBtn();
}
