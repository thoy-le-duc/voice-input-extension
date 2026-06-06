const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = `v${manifest.version}`;

const engineSelect  = document.getElementById('engine');
const keyInput      = document.getElementById('apiKey');
const geminiInput   = document.getElementById('geminiKey');
const modelSelect   = document.getElementById('geminiModel');
const modelCustom   = document.getElementById('geminiModelCustom');
const alwaysCheck   = document.getElementById('geminiAlways');
const saveBtn       = document.getElementById('save');
const status        = document.getElementById('status');

const KNOWN_MODELS = [
  'gemini-2.5-flash-lite', 'gemini-2.5-flash',
  'gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'
];

// Affiche le champ texte uniquement quand "Autre…" est sélectionné
function syncCustomVisibility() {
  modelCustom.style.display = modelSelect.value === '__custom__' ? 'block' : 'none';
}
modelSelect.addEventListener('change', syncCustomVisibility);

// Charge les valeurs existantes
chrome.storage.local.get(
  ['apiKey', 'geminiKey', 'geminiModel', 'geminiAlways', 'engine'],
  ({ apiKey, geminiKey, geminiModel, geminiAlways, engine }) => {
    engineSelect.value = engine || 'elevenlabs';
    if (apiKey)    keyInput.placeholder    = '••••••••' + apiKey.slice(-4);
    if (geminiKey) geminiInput.placeholder = '••••••••' + geminiKey.slice(-4);

    const m = geminiModel || 'gemini-2.0-flash-lite';
    if (KNOWN_MODELS.includes(m)) {
      modelSelect.value = m;
    } else {
      modelSelect.value = '__custom__';   // modèle non listé → champ custom
      modelCustom.value = m;
    }
    syncCustomVisibility();
    alwaysCheck.checked = !!geminiAlways;
  }
);

saveBtn.addEventListener('click', () => {
  const elevKey = keyInput.value.trim();
  const gemKey  = geminiInput.value.trim();
  const model   = modelSelect.value === '__custom__'
    ? (modelCustom.value.trim() || 'gemini-2.0-flash-lite')
    : modelSelect.value;

  const toSave = {
    engine: engineSelect.value,
    geminiAlways: alwaysCheck.checked,
    geminiModel: model
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
