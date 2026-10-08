import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  document.querySelector('#application')?.addEventListener('dragstart', (event) => {
    event.preventDefault();
    ipcRenderer.send('tongzhou:permission-panel-drag');
  });
  document
    .querySelector('#close')
    ?.addEventListener('click', () => ipcRenderer.send('tongzhou:permission-panel-close'));
  document
    .querySelector('#reveal')
    ?.addEventListener('click', () => ipcRenderer.send('tongzhou:permission-panel-reveal'));
  ipcRenderer.on('tongzhou:permission-panel-error', (_, message: string) => {
    const feedback = document.querySelector('#feedback');
    if (feedback) feedback.textContent = message;
  });
});
