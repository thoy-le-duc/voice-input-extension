// Service worker — récupère un token ElevenLabs à usage unique pour le content script

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'GET_TOKEN') return;

  chrome.storage.local.get(['apiKey'], async ({ apiKey }) => {
    if (!apiKey) {
      sendResponse({ error: 'Clé API non configurée. Ouvre l\'extension pour la saisir.' });
      return;
    }

    try {
      const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' }
      });

      if (!res.ok) {
        const body = await res.text();
        sendResponse({ error: `ElevenLabs ${res.status}: ${body}` });
        return;
      }

      const { token } = await res.json();
      sendResponse({ token });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  });

  return true; // canal asynchrone
});
