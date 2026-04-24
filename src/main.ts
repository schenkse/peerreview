import { GraphState } from './graph-state';
import { GraphRenderer } from './graph-renderer';
import { NetworkBuilder } from './network-builder';
import { ProgressIndicator } from './progress';
import { SearchUI } from './search';

const graphState = new GraphState();

const renderer = new GraphRenderer(
  document.getElementById('graph-container')!,
  graphState,
);

const networkBuilder = new NetworkBuilder(graphState);

const searchContainer = document.getElementById('search-container')!;
const progressEl = document.createElement('div');
searchContainer.appendChild(progressEl);
const progress = new ProgressIndicator(progressEl);

new SearchUI(searchContainer, async (bai, name, recid) => {
  networkBuilder.cancel();
  graphState.clear();
  progress.show();
  await networkBuilder.build(bai, name, recid, (p) => progress.update(p));
});

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  renderer.refreshColors();
});

document.getElementById('zoom-in')!.addEventListener('click', () => renderer.zoomIn());
document.getElementById('zoom-out')!.addEventListener('click', () => renderer.zoomOut());
document.getElementById('zoom-reset')!.addEventListener('click', () => renderer.resetView());

const infoModal = document.getElementById('info-modal')!;
document.getElementById('info-btn')!.addEventListener('click', () => infoModal.classList.add('visible'));
document.getElementById('info-close')!.addEventListener('click', () => infoModal.classList.remove('visible'));
infoModal.addEventListener('click', (e) => { if (e.target === infoModal) infoModal.classList.remove('visible'); });
