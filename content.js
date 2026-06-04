// Voice Input - Casier Frais
// Injecte un bouton micro sur les champs de saisie de poids/quantité dans les popups

const MIC_CLASS = 'vi-mic-btn';
const SELECTOR = [
  'input[type="number"]',
  'input[placeholder*="poids"]',
  'input[placeholder*="kg"]',
  'input[placeholder*="gramme"]',
  'input[placeholder*="quantit"]',
  'input[placeholder*="unité"]',
  'input[name*="weight"]',
  'input[name*="poids"]',
  'input[name*="quantity"]',
].join(',');

// Surveille les popups qui apparaissent dynamiquement
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) injectMicButtons(node);
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true });
injectMicButtons(document.body);

function injectMicButtons(root) {
  const newInputs = [];
  for (const input of root.querySelectorAll(SELECTOR)) {
    if (input.closest(`.${MIC_CLASS}-wrap`)) continue;
    if (input.parentNode.querySelector(`.${MIC_CLASS}`)) continue;
    newInputs.push(input);
  }
  if (newInputs.length === 0) return;

  const controls = newInputs.map(input => attachMicButton(input));

  // Chaîne les champs : quand le champ i est rempli, démarre le champ i+1
  for (let i = 0; i < controls.length - 1; i++) {
    controls[i].setNext(controls[i + 1]);
  }

  // Auto-démarre le premier champ si on est dans une popup
  const inPopup = !!newInputs[0].closest(
    '[role="dialog"], [role="presentation"], .modal, [class*="modal"], [class*="popup"], [class*="dialog"]'
  );
  if (inPopup) setTimeout(() => controls[0].start(), 400);
}

function attachMicButton(input) {
  const wrap = document.createElement('span');
  wrap.className = `${MIC_CLASS}-wrap`;

  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement('button');
  btn.className = MIC_CLASS;
  btn.type = 'button';
  btn.title = 'Saisie vocale';
  btn.textContent = '🎤';
  wrap.appendChild(btn);

  let active = false;
  let cleanup = null;
  let nextControl = null;

  function setNext(ctrl) { nextControl = ctrl; }

  async function start() {
    if (active) return;
    active = true;
    btn.textContent = '⏳';
    btn.disabled = true;

    try {
      const { token, error } = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
      if (error) { showError(btn, error); active = false; return; }

      btn.textContent = '🔴';
      btn.disabled = false;

      cleanup = await startSession(token, input, (filled) => {
        active = false;
        btn.textContent = filled ? '✅' : '🎤';
        cleanup = null;
        // Passe au champ suivant automatiquement
        if (filled && nextControl) setTimeout(() => nextControl.start(), 300);
      });
    } catch (err) {
      showError(btn, err.message);
      active = false;
    }
  }

  btn.addEventListener('click', () => { if (active) cleanup?.(); else start(); });

  return { start, setNext };
}

async function startSession(token, targetInput, onDone) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true }
  });

  // Paramètres dans l'URL (plus compatible mobile que session_config)
  const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  url.searchParams.set('token', token);
  url.searchParams.set('model_id', 'scribe_v2_realtime');
  url.searchParams.set('language_code', 'fr');
  url.searchParams.set('commit_strategy', 'vad');

  const ws = new WebSocket(url.toString());
  let audioCtx = null, processor = null, sessionReady = false;
  let filled = false;

  function stop() {
    processor?.disconnect();
    if (audioCtx?.state !== 'closed') audioCtx?.close();
    stream.getTracks().forEach(t => t.stop());
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) ws.close();
    onDone(filled);
  }

  ws.onopen = () => {
    // On attend session_started avant d'envoyer l'audio
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // ElevenLabs utilise message_type, on accepte aussi type pour compatibilité
    const mtype = msg.message_type || msg.type;

    // Démarre l'audio seulement quand la session est prête
    if (mtype === 'session_started' && !sessionReady) {
      sessionReady = true;
      audioCtx = new AudioContext(); // taux natif du hardware (48000 sur Android)
      const nativeRate = audioCtx.sampleRate;
      const source = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = ev.inputBuffer.getChannelData(0);
        // Rééchantillonnage vers 16000 Hz si nécessaire (Android = 48000 natif)
        const resampled = nativeRate !== 16000 ? resampleAudio(input, nativeRate, 16000) : input;
        const pcm = float32ToInt16(resampled);
        ws.send(JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: bufferToBase64(pcm.buffer),
          sample_rate: 16000
        }));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
    }

    if (mtype === 'partial_transcript' && msg.text) {
      targetInput.placeholder = msg.text;
    }

    if (mtype === 'committed_transcript') {
      if (msg.text) {
        const value = parseValue(msg.text);
        console.log(`[VoiceInput] transcription: "${msg.text}" → valeur: ${value}`);
        if (value !== null) {
          filled = true;
          targetInput.value = value;
          targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      stop();
    }

    if (mtype === 'input_error' || mtype === 'error') {
      console.error('[VoiceInput] ElevenLabs error:', msg);
      stop();
    }
  };

  ws.onerror = () => stop();
  ws.onclose = () => { if (audioCtx?.state !== 'closed') stop(); };

  return stop;
}

// Rééchantillonnage linéaire (48000 Hz Android → 16000 Hz ElevenLabs)
function resampleAudio(buffer, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const newLength = Math.ceil(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, buffer.length - 1);
    result[i] = buffer[lo] + (buffer[hi] - buffer[lo]) * (src - lo);
  }
  return result;
}

// Convertit Float32 → Int16 PCM
function float32ToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  }
  return out;
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

// Extrait un nombre depuis du texte (FR)
// Ex: "500 grammes" → 500, "1,2 kilo" → 1200, "cinq cents" → 500
function parseValue(text) {
  // Normalisation
  const t = text.toLowerCase().trim()
    .replace(/[.!?]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2')       // virgule décimale → point
    .replace(/,/g, ' ')                    // autres virgules → espace
    .replace(/(\d)\s*kg\b/g, '$1 kilo')   // "8kg" ou "8 kg" → "8 kilo"
    .replace(/(\d)\s*g\b/g, '$1 grammes') // "536g" ou "536 g" → "536 grammes"
    .replace(/\s+/g, ' ').trim();

  const wordMap = {
    zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
    six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
    treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20,
    trente: 30, quarante: 40, cinquante: 50, soixante: 60,
    cent: 100, cents: 100, mille: 1000
  };

  // Convertit une chaîne (chiffres ou mots) en nombre
  function extractNum(str) {
    if (!str) return null;
    const s = str.trim();
    const m = s.match(/(\d+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1]);
    // Mots
    let total = 0, cur = 0;
    for (const w of s.split(/[\s-]+/)) {
      const v = wordMap[w];
      if (v === undefined) continue;
      if (v === 1000) { total += (cur || 1) * 1000; cur = 0; }
      else if (v === 100) cur = (cur || 1) * 100;
      else cur += v;
    }
    total += cur;
    return total > 0 ? total : null;
  }

  // "X kilo(s) Y gramme(s)" — ex: "six kilos 238 grammes" → 6.238
  const kgGr = t.match(/(.+?)\s+(?:kilo[s]?|kg)\s+(.+?)\s+gramme[s]?(?:\s|$)/);
  if (kgGr) {
    const kg = extractNum(kgGr[1]), gr = extractNum(kgGr[2]);
    if (kg !== null && gr !== null) return kg + gr / 1000;
  }

  // "X kilo(s) Y" sans mot "grammes" — ex: "un kilo trois cent quarante-cinq" → 1.345
  const kgImpl = t.match(/(.+?)\s+(?:kilo[s]?|kg)\s+(.+)/);
  if (kgImpl) {
    const kg = extractNum(kgImpl[1]);
    const gr = extractNum(kgImpl[2].replace(/gramme[s]?/g, '').trim());
    if (kg !== null && gr !== null) return kg + gr / 1000;
    if (kg !== null) return kg;
  }

  // "X kilo(s)" seul — ex: "deux kilos" → 2
  const kgOnly = t.match(/(.+?)\s+(?:kilo[s]?|kg)(?:\s|$)/);
  if (kgOnly) {
    const v = extractNum(kgOnly[1]);
    if (v !== null) return v;
  }

  // "X gramme(s)" — ex: "500 grammes" → 0.5
  const grOnly = t.match(/(.+?)\s+gramme[s]?(?:\s|$)/);
  if (grOnly) {
    const v = extractNum(grOnly[1]);
    if (v !== null) return v / 1000;
  }

  // Fallback : premier chiffre (ex: "2 unités" → 2)
  const numM = t.match(/(\d+(?:\.\d+)?)/);
  if (numM) return parseFloat(numM[1]);

  // Mots seuls (ex: "deux" → 2)
  return extractNum(t);
}

function showError(btn, msg) {
  console.error('[VoiceInput]', msg);
  btn.textContent = '❌';
  btn.disabled = false;
  btn.title = msg;
  setTimeout(() => { btn.textContent = '🎤'; btn.title = 'Saisie vocale'; }, 3000);
}
