// Service worker — tokens ElevenLabs + parsing Gemini Flash

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
      const model = geminiModel || 'gemini-2.0-flash-lite';
      const prompt = `Tu extrais une valeur numérique d'une transcription vocale française pour un champ de saisie (poids en kg ou quantité en unités). Réponds UNIQUEMENT avec le nombre, point comme séparateur décimal.

Exemples :
"Huit kilos, 537 grammes." → 8.537
"Trois barquettes et demi." → 3.5
"500 grammes" → 0.5
"deux" → 2
"Un kilo trois cent quarante-cinq." → 1.345
"un quart de kilo" → 0.25
"une livre et demie" → 0.75
"0,835" → 0.835

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
        if (!res.ok) { sendResponse({ error: `Gemini ${res.status}` }); return; }
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        const value = raw ? parseFloat(raw.replace(',', '.')) : null;
        sendResponse({ value: (value != null && !isNaN(value)) ? value : null });
      } catch (err) { sendResponse({ error: err.message }); }
    });
    return true;
  }

});
