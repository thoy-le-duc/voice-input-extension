const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = `v${manifest.version}`;

const keyInput    = document.getElementById('apiKey');
const geminiInput = document.getElementById('geminiKey');
const saveBtn     = document.getElementById('save');
const status      = document.getElementById('status');

// Charge les clés existantes (masquées)
chrome.storage.local.get(['apiKey', 'geminiKey'], ({ apiKey, geminiKey }) => {
  if (apiKey)    keyInput.placeholder    = '••••••••' + apiKey.slice(-4);
  if (geminiKey) geminiInput.placeholder = '••••••••' + geminiKey.slice(-4);
});

saveBtn.addEventListener('click', () => {
  const elevKey   = keyInput.value.trim();
  const gemKey    = geminiInput.value.trim();

  if (!elevKey && !gemKey) {
    status.style.color = '#dc2626';
    status.textContent = 'Saisis au moins une clé.';
    return;
  }

  const toSave = {};
  if (elevKey) toSave.apiKey    = elevKey;
  if (gemKey)  toSave.geminiKey = gemKey;

  chrome.storage.local.set(toSave, () => {
    if (elevKey) { keyInput.value = '';    keyInput.placeholder    = '••••••••' + elevKey.slice(-4); }
    if (gemKey)  { geminiInput.value = ''; geminiInput.placeholder = '••••••••' + gemKey.slice(-4); }
    status.style.color = '#16a34a';
    status.textContent = 'Clés enregistrées ✓';
    setTimeout(() => (status.textContent = ''), 2000);
  });
});
