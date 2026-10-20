// A local diagnostic window has no core IPC permissions. Only its own input is observed.
document.getElementById('sample').addEventListener('input', (event) => {
  location.hash = encodeURIComponent(event.target.value);
});
document.addEventListener('DOMContentLoaded', () => {
  location.hash = 'ready';
});
