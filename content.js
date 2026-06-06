// Voice Input - Casier Frais

const MIC_CLASS = 'vi-mic-btn';
const SELECTOR = [
  'input[type="number"][step*="."]',
  'input[placeholder*="poids"]',
  'input[placeholder*="kg"]',
  'input[placeholder*="gramme"]',
  'input[placeholder*="quantit"]',
  'input[placeholder*="unité"]',
  'input[name*="weight"]',
  'input[name*="poids"]',
].join(',');

// ── Token (single-use : pré-fetch à l'ouverture, invalidé après usage) ───────
let _pendingToken = null, _pendingTokenAt = 0;

async function getToken() {
  // Utilise le token pré-fetché s'il est frais (< 55s)
  if (_pendingToken && Date.now() - _pendingTokenAt < 55000) {
    const t = _pendingToken;
    _pendingToken = null; // single-use : invalide immédiatement
    return t;
  }
  // Sinon fetch un nouveau
  const { token, error } = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
  if (error) throw new Error(error);
  return token;
}

function prefetchToken() {
  chrome.runtime.sendMessage({ type: 'GET_TOKEN' })
    .then(({ token, error }) => {
      if (!error && token) { _pendingToken = token; _pendingTokenAt = Date.now(); }
    }).catch(() => {});
}

// Verrou global : empêche deux sessions micro simultanées dans la page
let sessionLock = false;

// ── Réglage "toujours Gemini" (lu depuis le stockage, mis à jour en direct) ───
let geminiAlways = false;
chrome.storage.local.get(['geminiAlways'], r => { geminiAlways = !!r.geminiAlways; });
chrome.storage.onChanged?.addListener(changes => {
  if (changes.geminiAlways) geminiAlways = !!changes.geminiAlways.newValue;
});

// ── Détection popup ───────────────────────────────────────────────────────────

function getPopupContext(input) {
  let node = input.parentElement;
  for (let i = 0; i < 20 && node && node !== document.body; i++) {
    const role = node.getAttribute?.('role');
    if (role === 'dialog' || role === 'presentation') {
      const t = node.textContent.toLowerCase();
      if (/remplir/.test(t) && /poids/.test(t)) return 'weight';
      if (/impression|étiquette/.test(t))        return 'label';
      return 'other';
    }
    // Fallback CSS pour Yandex/Android
    if (node.matches?.('[class*="modal"],[class*="dialog"],[class*="popup"]')) return 'other';
    node = node.parentElement;
  }
  return 'none';
}

// ── Injection des boutons micro ───────────────────────────────────────────────

const observer = new MutationObserver((mutations) => {
  for (const m of mutations)
    for (const node of m.addedNodes)
      if (node.nodeType === Node.ELEMENT_NODE) injectMicButtons(node);
});
observer.observe(document.body, { childList: true, subtree: true });
injectMicButtons(document.body);

// ── Affichage debug à l'écran (lisible sur mobile, pas besoin de console) ─────

function showDebug(text, value, source) {
  let box = document.getElementById('vi-debug');
  if (!box) {
    box = document.createElement('div');
    box.id = 'vi-debug';
    Object.assign(box.style, {
      position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '2147483647',
      background: 'rgba(0,0,0,0.85)', color: '#0f0', font: '12px monospace',
      padding: '6px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
    });
    box.addEventListener('click', () => box.remove()); // tap pour fermer
    document.body.appendChild(box);
  }
  box.textContent = `🎤 "${text}"\n→ ${value}  [${source}]  (tap pour fermer)`;
}

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
  const inPopup = getPopupContext(newInputs[0]) !== 'none';
  if (inPopup) {
    prefetchToken(); // pré-fetch pendant le délai d'attente
    setTimeout(() => controls[0].start(), 400);
  }
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

  let active = false, stopFn = null, nextControl = null;

  function setNext(ctrl) { nextControl = ctrl; }

  async function start() {
    if (active) return;
    if (sessionLock) return; // une seule session active dans toute la page
    active = true;
    sessionLock = true;
    btn.textContent = '⏳';
    btn.disabled = true;

    try {
      let token;
      try { token = await getToken(); }
      catch (e) { showError(btn, e.message); active = false; sessionLock = false; return; }

      btn.textContent = '🔴';
      btn.disabled = false;

      const onSessionDone = (filled) => {
        active = false;
        sessionLock = false;
        stopFn = null;
        btn.textContent = filled ? '✅' : '🎤';
        // Passe au champ suivant seulement si celui-ci a été rempli
        if (filled && nextControl) setTimeout(() => nextControl.start(), 300);
      };
      stopFn = await startSession(token, input, onSessionDone);
    } catch (err) {
      showError(btn, err.message);
      active = false;
      sessionLock = false;
    }
  }

  btn.addEventListener('click', () => { if (active) stopFn?.(); else start(); });
  return { start, setNext };
}

// ── Session ElevenLabs ────────────────────────────────────────────────────────

async function startSession(token, targetInput, onDone) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Micro refusé — autorise l\'accès dans le navigateur'
      : err.message;
    throw new Error(msg);
  }

  const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  url.searchParams.set('token', token);
  url.searchParams.set('model_id', 'scribe_v2_realtime');
  url.searchParams.set('language_code', 'fr');
  url.searchParams.set('commit_strategy', 'vad');

  const ws = new WebSocket(url.toString());
  let audioCtx = null, processor = null, sessionReady = false;
  let lastPartialText = '';
  let transcriptReceived = false; // on a reçu du texte (même si Gemini pas encore fini)
  let fieldFilled = false;        // le champ a été rempli

  function setFieldValue(value) {
    if (fieldFilled) return;
    fieldFilled = true;
    const rounded = Math.round(value * 1000) / 1000;
    const formatted = targetInput.type === 'number'
      ? String(rounded)
      : String(rounded).replace('.', ',');
    targetInput.value = formatted;
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillAsync(text) {
    if (fieldFilled) return;
    let value, source;

    if (geminiAlways) {
      // Mode "tout Gemini" : Gemini d'abord, parser local en secours
      try {
        const r = await chrome.runtime.sendMessage({ type: 'GEMINI_PARSE', text });
        if (r.value != null) { value = r.value; source = 'gemini'; }
        else if (r.error) { console.warn('[VoiceInput] Gemini erreur:', r.error); }
      } catch {}
      if (value == null) { value = parseValue(text); source = 'local-secours'; }
    } else {
      // Mode normal : parser local, Gemini si null ou fraction douteuse
      value = parseValue(text);
      source = 'local';
      const hasFraction = /\b(demi[e]?|quart|tiers|virgule)\b/i.test(text);
      const needsGemini = value === null || (hasFraction && Number.isInteger(value));
      if (needsGemini) {
        try {
          const r = await chrome.runtime.sendMessage({ type: 'GEMINI_PARSE', text });
          if (r.value != null) { value = r.value; source = 'gemini'; }
          else if (r.error) { source = 'gemini-err'; console.warn('[VoiceInput] Gemini erreur:', r.error); }
        } catch {}
      }
    }

    console.log(`[VoiceInput] "${text}" → ${value} [${source}]`);
    showDebug(text, value, source);
    if (value != null) setFieldValue(value);
  }

  function stop(useLastPartial = false) {
    if (useLastPartial && !transcriptReceived && lastPartialText) {
      transcriptReceived = true;
      fillAsync(lastPartialText);
    }
    processor?.disconnect();
    if (audioCtx?.state !== 'closed') audioCtx?.close();
    stream.getTracks().forEach(t => t.stop());
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) ws.close();
    onDone(transcriptReceived);
  }

  ws.onopen = () => console.log('[VoiceInput] WebSocket connecté');

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const mtype = msg.message_type;
    console.log('[VoiceInput] reçu:', mtype, msg.text ?? '');

    if (mtype === 'session_started' && !sessionReady) {
      sessionReady = true;
      startAudio(stream, ws); // démarre seulement quand ElevenLabs est prêt
    }

    if (mtype === 'partial_transcript' && msg.text) {
      lastPartialText = msg.text;
      targetInput.placeholder = msg.text;
    }

    if (mtype === 'committed_transcript') {
      if (msg.text) { transcriptReceived = true; fillAsync(msg.text); }
      stop();
    }

    if (mtype === 'input_error' || mtype === 'error') {
      console.error('[VoiceInput] erreur ElevenLabs:', msg);
      stop(true);
    }
  };

  ws.onerror = () => stop();
  ws.onclose = (e) => {
    console.log('[VoiceInput] WebSocket fermé, code:', e.code);
    if (audioCtx?.state !== 'closed') stop(true);
  };

  function startAudio(stream, ws) {
    audioCtx = new AudioContext();
    const nativeRate = audioCtx.sampleRate;
    const source = audioCtx.createMediaStreamSource(stream);
    // Buffer 2048 sur desktop (128ms), 4096 sur mobile (256ms, plus stable)
    const bufSize = /Mobi|Android/i.test(navigator.userAgent) ? 4096 : 2048;
    processor = audioCtx.createScriptProcessor(bufSize, 1, 1);

    processor.onaudioprocess = (ev) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
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
    console.log(`[VoiceInput] audio démarré (${nativeRate}→16000Hz, buf=${bufSize})`);
  }

  return stop;
}

// ── Audio utils ───────────────────────────────────────────────────────────────

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

function float32ToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  return out;
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

// ── Parseur de nombres français ───────────────────────────────────────────────

const SKIP = new Set(['le','la','les','de','du','des','pour','à','au','ou','environ','bien']);

function parseFrenchInt(text) {
  const words = text.toLowerCase().replace(/-/g, ' ').split(/\s+/)
    .filter(w => w && w !== 'et' && w !== 'de' && w !== 'virgule');
  const UNITS = { zéro:0,un:1,une:1,deux:2,trois:3,quatre:4,cinq:5,six:6,sept:7,huit:8,neuf:9,
                  dix:10,onze:11,douze:12,treize:13,quatorze:14,quinze:15,seize:16 };
  const TENS  = { vingt:20,trente:30,quarante:40,cinquante:50,soixante:60,
                  septante:70,huitante:80,octante:80,nonante:90 };
  let result = 0, cur = 0, i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w in UNITS) {
      if (words[i+1] === 'vingt' || words[i+1] === 'vingts') { cur += UNITS[w] * 20; i += 2; continue; }
      cur += UNITS[w];
    } else if (w in TENS) {
      cur += TENS[w];
    } else if (w === 'cent' || w === 'cents') {
      cur = cur === 0 ? 100 : cur * 100;
    } else if (w === 'mille') {
      result += cur === 0 ? 1000 : cur * 1000; cur = 0;
    } else if (w === 'demi') {
      cur += 500;
    }
    i++;
  }
  return result + cur;
}

function parseFrenchDecimal(text) {
  const t = text.toLowerCase();
  const vIdx = t.indexOf('virgule');
  if (vIdx === -1) return null;
  const intPart = t.slice(0, vIdx).trim();
  const decPart = t.slice(vIdx + 7).trim();
  const intVal = parseFrenchInt(intPart) || 0;
  const decVal = parseFrenchInt(decPart);
  if (!decVal) return null;
  return parseFloat(`${intVal}.${decVal}`);
}

function segToNum(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.includes('virgule')) { const v = parseFrenchDecimal(t); if (v !== null) return v; }
  const dm = t.match(/(\d+(?:[.,]\d+)?)/);
  if (dm) return parseFloat(dm[1].replace(',', '.'));
  if (/\bdemi\b/.test(t)) return 0.5;
  const n = parseFrenchInt(t);
  return n > 0 ? n : null;
}

function clean(words) {
  return words.filter(w => !SKIP.has(w) && !/^\W+$/.test(w)).join(' ');
}

function parseValue(rawText) {
  // Corrige les fautes de transcription courantes de "kilo" par ElevenLabs
  // (sur tablette : "kilo" entendu comme "guillo", "quilo"…)
  const text = rawText
    .replace(/\bguillot?s?\b/gi, 'kilo')
    .replace(/\bgu[iy]los?\b/gi, 'kilo')
    .replace(/\bqu[iy]ll?os?\b/gi, 'kilo')
    .replace(/\bki?llos?\b/gi, 'kilo');

  // tDec : virgule décimale → point, ponctuation finale retirée
  const tDec = text.toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[!?]/g, '')
    .replace(/\.\s*$/, '')   // point final de phrase
    .trim();
  // tW : tout en mots, tirets et ponctuation → espace
  const tW = text.toLowerCase().replace(/[.!?,]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

  const KG = '(?:kilos?|kilogrammes?|kg)';
  const GR = '(?:grammes?|gr(?:\\b|\\s|$))';
  const LV = '(?:livres?)';

  // Livres (1 livre = 500 g)
  const dLv = tDec.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${LV}`));
  if (dLv) return parseFloat(dLv[1]) * 0.5;
  const wLv = tW.match(new RegExp(`(.+?)\\s+${LV}`));
  if (wLv) { const lv = segToNum(clean(wLv[1].split(/\s+/))); if (lv !== null) return lv * 0.5; }

  // "un quart de kilo"
  if (/quart/.test(tW) && new RegExp(KG).test(tW)) return 0.25;

  // "un virgule cinq kilo"
  if (tW.includes('virgule')) {
    const vDec = parseFrenchDecimal(tW);
    if (vDec !== null) {
      if (new RegExp(GR).test(tW)) return vDec / 1000;
      return vDec;
    }
  }

  // "X [unité quelconque] et demi(e)" → X + 0.5
  // Fonctionne avec n'importe quel mot d'unité : barquette, sachet, litre…
  if (/\bet\s+demi[e]?\b/i.test(tW)) {
    const before = tW.split(/\bet\s+demi[e]?\b/i)[0];
    const dm = before.match(/(\d+(?:\.\d+)?)/);
    const n = dm ? parseFloat(dm[1]) : parseFrenchInt(before);
    if (n > 0) return n + 0.5;
  }

  // "X [unité] et quart" → X + 0.25
  if (/\bet\s+quart\b/i.test(tW)) {
    const before = tW.split(/\bet\s+quart\b/i)[0];
    const dm = before.match(/(\d+(?:\.\d+)?)/);
    const n = dm ? parseFloat(dm[1]) : parseFrenchInt(before);
    if (n > 0) return n + 0.25;
  }

  // "demi kilo" / "un kilo et demi" (avec unité kilo explicite)
  if (/demi/.test(tW) && new RegExp(KG).test(tW)) {
    const kgIdx = tW.search(new RegExp(KG));
    const demiIdx = tW.indexOf('demi');
    if (demiIdx < kgIdx) return 0.5;
    const kg = segToNum(clean(tW.slice(0, kgIdx).trim().split(/\s+/)));
    return (kg ?? 1) + 0.5;
  }

  // ── Chiffres ──
  // "2 kilos 535 grammes" ou "2kg 535g"
  const dKgGr = tDec.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${KG}[\\s,.]*(\\d+(?:\\.\\d+)?)\\s*${GR}`));
  if (dKgGr) return parseFloat(dKgGr[1]) + parseFloat(dKgGr[2]) / 1000;

  const dKg = tDec.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${KG}`));
  const dGr = tDec.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${GR}`));

  if (dKg && dGr) return parseFloat(dKg[1]) + parseFloat(dGr[1]) / 1000;
  // Ne pas court-circuiter si un mot "kilo" est présent → laisser le chemin mots gérer
  if (dGr && !dKg && !new RegExp(KG).test(tW)) return parseFloat(dGr[1]) / 1000;
  if (dKg) {
    const after = tDec.slice(dKg.index + dKg[0].length)
      .replace(/^[^\w\d]+/, '').trim();
    const bare = after.match(/^(\d+(?:\.\d+)?)/);  // pas de contrainte sur ce qui suit
    if (bare) {
      const gr = parseFloat(bare[1]);
      const grAdj = (gr >= 1 && gr <= 9) ? gr * 100 : gr;
      return parseFloat(dKg[1]) + grAdj / 1000;
    }
    return parseFloat(dKg[1]);
  }

  // ── Mots ──
  const wKgGr = tW.match(new RegExp(`(.+?)\\s+${KG}\\s+(?:et\\s+)?(.+?)\\s+${GR}`));
  if (wKgGr) {
    const kg = segToNum(clean(wKgGr[1].split(/\s+/)));
    const gr = segToNum(clean(wKgGr[2].split(/\s+/)));
    if (kg !== null && gr !== null) return kg + gr / 1000;
  }

  const wKg = tW.match(new RegExp(`(.+?)\\s+${KG}(.*)`));
  const wGr = tW.match(new RegExp(`(.+?)\\s+${GR}`));

  if (wKg) {
    const kg = segToNum(clean(wKg[1].split(/\s+/)));
    if (kg !== null) {
      const after = clean(wKg[2].trim().split(/\s+/));
      if (after) {
        const gr = segToNum(after);
        if (gr !== null && gr > 0) {
          const grAdj = (gr >= 1 && gr <= 9) ? gr * 100 : gr;
          return kg + grAdj / 1000;
        }
      }
      if (wGr) { const gr = segToNum(clean(wGr[1].split(/\s+/))); if (gr !== null) return kg + gr / 1000; }
      return kg;
    }
  }
  if (wGr) { const gr = segToNum(clean(wGr[1].split(/\s+/))); if (gr !== null) return gr / 1000; }

  // ── Fallback ──
  if (tW.includes('virgule')) { const v = parseFrenchDecimal(tW); if (v !== null) return v; }

  // "8 537" ou "8 537." → 8 kg + 537 g = 8.537 (ElevenLabs sans unités, chiffres)
  const twoNum = tDec.match(/^(\d{1,3})\s+(\d{3})\.?\s*$/);
  if (twoNum) return parseFloat(twoNum[1]) + parseFloat(twoNum[2]) / 1000;

  // "Huit, cinq cent trente-sept." → 8 + 537/1000 (sans unités, séparés par virgule)
  const ci = text.indexOf(',');
  if (ci > 0 && !new RegExp(KG + '|' + GR).test(tW)) {
    const n1 = segToNum(text.slice(0, ci).trim().toLowerCase());
    const n2 = segToNum(text.slice(ci + 1).replace(/[.!?\s]+$/, '').trim().toLowerCase());
    if (n1 !== null && n2 !== null && n2 > 0 && n2 < 1000) return n1 + n2 / 1000;
  }

  // "kilo 640" — kilo présent mais nombre de kilos perdu par ElevenLabs.
  // On traite le nombre comme des grammes (0.640) plutôt que 640 kg absurde.
  if (new RegExp(KG).test(tW)) {
    const nm = tDec.match(/(\d+(?:\.\d+)?)/);
    if (nm) {
      const n = parseFloat(nm[1]);
      return n >= 100 ? n / 1000 : n; // 640 → 0.640 ; 2 → 2 (probable nb de kilos)
    }
  }

  const numMatch = tDec.match(/(\d+(?:\.\d+)?)/);
  if (numMatch) return parseFloat(numMatch[1]);
  const wordOnly = parseFrenchInt(tW);
  if (wordOnly > 0) return wordOnly;

  return null;
}

function showError(btn, msg) {
  console.error('[VoiceInput]', msg);
  btn.textContent = '❌';
  btn.disabled = false;
  btn.title = msg;
  setTimeout(() => { btn.textContent = '🎤'; btn.title = 'Saisie vocale'; }, 3000);
}
