import { GraphState } from './graph-state';
import { GraphRenderer } from './graph-renderer';
import { NetworkBuilder } from './network-builder';
import { ProgressIndicator } from './progress';
import { SearchUI } from './search';

const graphState = new GraphState();

new GraphRenderer(
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
});
