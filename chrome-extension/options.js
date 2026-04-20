const STORAGE_KEY = 'balanceApiKey';

const input   = document.getElementById('balanceKey');
const button  = document.getElementById('save');
const status  = document.getElementById('status');

chrome.storage.local.get(STORAGE_KEY, (result) => {
  if (result && result[STORAGE_KEY]) input.value = result[STORAGE_KEY];
});

button.addEventListener('click', () => {
  const value = input.value.trim();
  if (!value) {
    status.textContent = 'Key is empty — nothing saved.';
    status.className = 'status err';
    return;
  }
  chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
    status.textContent = 'Saved. Reload TradingView for the extension to pick up the change.';
    status.className = 'status ok';
  });
});
