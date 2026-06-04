// Affiche la version
const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = `v${manifest.version}`;

const keyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');

// Charge la clé existante (masquée)
chrome.storage.local.get(['apiKey'], ({ apiKey }) => {
  if (apiKey) keyInput.placeholder = '••••••••' + apiKey.slice(-4);
});

saveBtn.addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) {
    status.style.color = '#dc2626';
    status.textContent = 'Clé vide.';
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    keyInput.value = '';
    keyInput.placeholder = '••••••••' + key.slice(-4);
    status.style.color = '#16a34a';
    status.textContent = 'Clé enregistrée ✓';
    setTimeout(() => (status.textContent = ''), 2000);
  });
});
