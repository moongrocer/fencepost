import './ui/style.css';
import { App } from './app';
import { initRemote } from './remote';

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');

const app = new App(root);
initRemote(app);

// Exposed for automated verification (preview/headless tests can build the
// MPCDI artifacts in-memory and inspect headers/XML without a download).
declare global {
  interface Window {
    fencepost: App;
  }
}
window.fencepost = app;
