const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = `v${manifest.version}`;

const keyInput     = document.getElementById('apiKey');
const geminiInput  = document.getElementById('geminiKey');
const modelInput   = document.getElementById('geminiModel');
const alwaysCheck  = document.getElementById('geminiAlways');
const saveBtn      = document.getElementById('save');
const status       = document.getElementById('status');

// Charge les valeurs existantes
chrome.storage.local.get(
  ['apiKey', 'geminiKey', 'geminiModel', 'geminiAlways'],
  ({ apiKey, geminiKey, geminiModel, geminiAlways }) => {
    if (apiKey)    keyInput.placeholder    = '••••••••' + apiKey.slice(-4);
    if (geminiKey) geminiInput.placeholder = '••••••••' + geminiKey.slice(-4);
    modelInput.value   = geminiModel || '';
    alwaysCheck.checked = !!geminiAlways;
  }
);

saveBtn.addEventListener('click', () => {
  const elevKey = keyInput.value.trim();
  const gemKey  = geminiInput.value.trim();
  const model   = modelInput.value.trim();

  const toSave = {
    geminiAlways: alwaysCheck.checked,
    geminiModel: model || 'gemini-2.0-flash-lite'
  };
  if (elevKey) toSave.apiKey    = elevKey;
  if (gemKey)  toSave.geminiKey = gemKey;

  chrome.storage.local.set(toSave, () => {
    if (elevKey) { keyInput.value = '';    keyInput.placeholder    = '••••••••' + elevKey.slice(-4); }
    if (gemKey)  { geminiInput.value = ''; geminiInput.placeholder = '••••••••' + gemKey.slice(-4); }
    status.style.color = '#16a34a';
    status.textContent = 'Réglages enregistrés ✓';
    setTimeout(() => (status.textContent = ''), 2000);
  });
});
