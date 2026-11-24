document.addEventListener('DOMContentLoaded', async () => {
  const checkbox = document.getElementById('useSubfolder');
  const dlCount = document.getElementById('dlCount');
  const lastFileRow = document.getElementById('lastFileRow');
  const lastFile = document.getElementById('lastFile');

  const data = await chrome.storage.local.get({
    useSubfolder: true,
    downloadCount: 0,
    lastFile: '',
  });

  checkbox.checked = Boolean(data.useSubfolder);
  dlCount.textContent = String(data.downloadCount || 0);

  if (data.lastFile) {
    lastFile.textContent = data.lastFile;
    lastFileRow.style.display = 'block';
  }

  checkbox.addEventListener('change', async () => {
    await chrome.storage.local.set({ useSubfolder: checkbox.checked });
  });
});
