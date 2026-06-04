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
    audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
  });

  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=${token}`);
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  let processor = null;

  let filled = false;

  function stop() {
    processor?.disconnect();
    audioCtx.close();
    stream.getTracks().forEach(t => t.stop());
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onDone(filled);
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'session_config',
      model_id: 'scribe_v2_realtime',
      language_code: 'fr',
      commit_strategy: 'vad',
      audio_format: 'pcm_s16le',
      sample_rate: 16000
    }));

    const source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const pcm = float32ToInt16(e.inputBuffer.getChannelData(0));
      ws.send(JSON.stringify({
        type: 'input_audio_chunk',
        audio_base_64: bufferToBase64(pcm.buffer),
        sample_rate: 16000
      }));
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'partial_transcript' && msg.text) {
      targetInput.placeholder = msg.text;
    }

    if (msg.type === 'committed_transcript' && msg.text) {
      const value = parseValue(msg.text);
      if (value !== null) {
        filled = true;
        targetInput.value = value;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      stop();
    }

    if (msg.type === 'error') {
      console.error('[VoiceInput] ElevenLabs error:', msg);
      stop();
    }
  };

  ws.onerror = () => stop();
  ws.onclose = () => { if (audioCtx.state !== 'closed') stop(); };

  return stop; // permet d'arrêter depuis l'extérieur
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
  const t = text.toLowerCase().trim().replace(/[.!?]/g, '').replace(/,/g, '.');

  // Cherche un nombre décimal/entier en premier
  const numMatch = t.match(/(\d+(?:\.\d+)?)/);
  if (numMatch) {
    let val = parseFloat(numMatch[1]);
    if (/kilo|kg/.test(t)) val = Math.round(val * 1000);
    return val;
  }

  // Conversion mots → chiffres (FR simplifié)
  const map = {
    zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
    six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
    treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20,
    trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100, cents: 100, mille: 1000
  };

  let total = 0, cur = 0;
  for (const w of t.split(/\s+/)) {
    const v = map[w];
    if (v === undefined) continue;
    if (v === 1000) { total += (cur || 1) * 1000; cur = 0; }
    else if (v === 100) cur = (cur || 1) * 100;
    else cur += v;
  }
  total += cur;

  if (total === 0) return null;
  if (/kilo|kg/.test(t)) total *= 1000;
  return total;
}

function showError(btn, msg) {
  console.error('[VoiceInput]', msg);
  btn.textContent = '❌';
  btn.disabled = false;
  btn.title = msg;
  setTimeout(() => { btn.textContent = '🎤'; btn.title = 'Saisie vocale'; }, 3000);
}
