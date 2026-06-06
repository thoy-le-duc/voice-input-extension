// Service worker — tokens ElevenLabs + parsing Gemini Flash

// Cache des résultats Gemini (en mémoire, max 50 entrées)
const geminiCache = new Map();
const CACHE_MAX = 50;
function cacheSet(map, key, val) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, val);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Token ElevenLabs (single-use) ──────────────────────────────────────────
  if (message.type === 'GET_TOKEN') {
    chrome.storage.local.get(['apiKey'], async ({ apiKey }) => {
      if (!apiKey) { sendResponse({ error: 'Clé ElevenLabs non configurée.' }); return; }
      try {
        const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' }
        });
        if (!res.ok) { sendResponse({ error: `ElevenLabs ${res.status}: ${await res.text()}` }); return; }
        const { token } = await res.json();
        sendResponse({ token });
      } catch (err) { sendResponse({ error: err.message }); }
    });
    return true;
  }

  // ── Parsing Gemini Flash (fallback quand le parser local échoue) ────────────
  if (message.type === 'GEMINI_PARSE') {
    chrome.storage.local.get(['geminiKey', 'geminiModel'], async ({ geminiKey, geminiModel }) => {
      if (!geminiKey) { sendResponse({ error: 'Clé Gemini non configurée.' }); return; }

      // Cache en mémoire (service worker) — évite les doublons en cas de retry
      const cacheKey = (message.fieldHint || '') + '::' + message.text.toLowerCase().trim();
      if (geminiCache.has(cacheKey)) {
        sendResponse({ value: geminiCache.get(cacheKey) });
        return;
      }

      const model = geminiModel || 'gemini-2.0-flash-lite';
      const fieldInfo = message.fieldHint
        ? `\n\nLe champ à remplir est : "${message.fieldHint}". Si c'est un poids en kg, donne le poids en kg. Si c'est une quantité en unités, donne le nombre d'unités.`
        : '';
      const prompt = `Tu extrais UNE valeur numérique d'une transcription vocale française, pour la saisir dans un champ.
Règles :
- La personne peut hésiter, se reprendre ou citer plusieurs nombres : prends la valeur FINALE qu'elle veut vraiment.
- Ignore les nombres sans rapport (ex: "parce qu'il y a 14 courgettes" si le champ est un poids).
- "X kilo Y" ou "X kilo Y grammes" = X + Y/1000 (ex: "1 kilo 415" = 1.415).
- Réponds UNIQUEMENT par le nombre, point comme séparateur décimal. Si rien : null.${fieldInfo}

Exemples :
"Huit kilos, 537 grammes." → 8.537
"Un kilo quatre cent quinze" → 1.415
"on va mettre 1 kilo 415, euh non 600, bon 415" → 1.415
"Trois barquettes et demi." → 3.5
"500 grammes" → 0.5
"deux" → 2

Transcription : "${message.text}"
Nombre :`;

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 10 }
            })
          }
        );
        if (!res.ok) {
          const body = await res.text();
          console.error('[VoiceInput BG] Gemini PARSE', res.status, body);
          sendResponse({ error: `${res.status} (${model}): ${body.slice(0, 200)}` });
          return;
        }
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        const value = raw ? parseFloat(raw.replace(',', '.')) : null;
        const result = (value != null && !isNaN(value)) ? value : null;
        if (result !== null) cacheSet(geminiCache, cacheKey, result);
        sendResponse({ value: result });
      } catch (err) { sendResponse({ error: err.message }); }
    });
    return true;
  }

  // ── Transcription audio directe par Gemini (sans ElevenLabs) ────────────────
  if (message.type === 'GEMINI_AUDIO') {
    chrome.storage.local.get(['geminiKey', 'geminiModel'], async ({ geminiKey, geminiModel }) => {
      if (!geminiKey) { sendResponse({ error: 'Clé Gemini non configurée.' }); return; }
      // flash-lite ne gère pas toujours l'audio → on garantit un modèle compatible
      let model = geminiModel || 'gemini-2.0-flash';
      if (/lite/i.test(model)) model = model.replace(/-lite$/i, ''); // 2.5-flash-lite → 2.5-flash

      const prompt = `Écoute cet audio en français. La personne dit un poids (kg) ou une quantité (unités). Réponds UNIQUEMENT avec le nombre correspondant, point comme séparateur décimal, rien d'autre.
Exemples de réponses attendues : 8.537 / 0.5 / 2 / 1.345 / 3.5
Si tu n'entends aucun nombre, réponds : null`;

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: prompt },
                { inline_data: { mime_type: message.mime, data: message.audio } }
              ] }],
              generationConfig: { temperature: 0, maxOutputTokens: 10 }
            })
          }
        );
        if (!res.ok) { sendResponse({ error: `Gemini ${res.status}` }); return; }
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        const value = raw ? parseFloat(raw.replace(',', '.')) : null;
        sendResponse({ value: (value != null && !isNaN(value)) ? value : null });
      } catch (err) { sendResponse({ error: err.message }); }
    });
    return true;
  }

  // ── Interprétation du texte par ScaleDown Extract ───────────────────────────
  if (message.type === 'SCALEDOWN_PARSE') {
    chrome.storage.local.get(['scaledownKey'], async ({ scaledownKey }) => {
      if (!scaledownKey) { sendResponse({ error: 'Clé ScaleDown non configurée.' }); return; }

      const cacheKey = 'sd:' + message.text.toLowerCase().trim();
      if (geminiCache.has(cacheKey)) { sendResponse({ value: geminiCache.get(cacheKey) }); return; }

      try {
        const res = await fetch('https://api.scaledown.xyz/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': scaledownKey },
          body: JSON.stringify({
            text: message.text,
            instruction: "Convertis l'expression française d'un poids ou d'une quantité en un seul nombre décimal (kg). Ex: 'trois kilos cinquante'=3.05, 'huit kilos 537 grammes'=8.537, 'cinq cents grammes'=0.5, 'deux'=2, 'une livre et demie'=0.75.",
            entities: {
              valeur: 'La valeur numérique finale en nombre décimal (point comme séparateur)'
            }
          })
        });
        if (!res.ok) {
          const body = await res.text();
          console.error('[VoiceInput BG] ScaleDown', res.status, body);
          sendResponse({ error: `${res.status}: ${body.slice(0, 200)}` });
          return;
        }
        const data = await res.json();
        // Cherche la valeur dans structured_result, sinon dans entities[].text
        let raw = null;
        const sr = data.structured_result;
        if (sr && typeof sr === 'object') {
          raw = sr.valeur ?? Object.values(sr).find(v => v != null);
        }
        if (raw == null && Array.isArray(data.entities) && data.entities[0]) {
          raw = data.entities[0].text;
        }
        const value = raw != null ? parseFloat(String(raw).replace(',', '.')) : null;
        const result = (value != null && !isNaN(value)) ? value : null;
        if (result !== null) cacheSet(geminiCache, cacheKey, result);
        sendResponse({ value: result });
      } catch (err) { sendResponse({ error: err.message }); }
    });
    return true;
  }

});
