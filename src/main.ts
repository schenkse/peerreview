import { GraphState } from './graph-state';
import { GraphRenderer } from './graph-renderer';
import { NetworkBuilder } from './network-builder';
import { ProgressIndicator } from './progress';
import { SearchUI } from './search';
import { MAX_COAUTHOR_COUNT } from './constants';

document.getElementById('publication-filter')!.textContent = `Papers with at most ${MAX_COAUTHOR_COUNT} authors`;

const graphState = new GraphState();

const renderer = new GraphRenderer(
  document.getElementById('graph-container')!,
  graphState,
);

const networkBuilder = new NetworkBuilder(graphState);

// The single search box moves between the landing hero and the top bar.
const searchContainer = document.getElementById('search-container')!;
const heroSlot = searchContainer.parentElement!;
const barSlot = document.getElementById('bar-search')!;

// Progress text sits after the summary; the meter runs along the search underline.
const progress = new ProgressIndicator(document.getElementById('progress')!, searchContainer);

function showGraphView(): void {
  document.body.dataset.view = 'graph';
  barSlot.append(searchContainer);
}

function showLanding(): void {
  document.body.dataset.view = 'landing';
  heroSlot.insertBefore(searchContainer, heroSlot.querySelector('.try'));
}

new SearchUI(searchContainer, async (bai, name, recid) => {
  showGraphView();
  networkBuilder.cancel();
  graphState.clear();
  progress.show();
  await networkBuilder.build(bai, name, recid, (p) => progress.update(p));
});

const searchInput = searchContainer.querySelector<HTMLInputElement>('.search-input')!;

document.getElementById('home')!.addEventListener('click', () => {
  networkBuilder.cancel();
  graphState.clear();
  progress.hide();
  searchInput.value = '';
  showLanding();
});

// Example searches fill the box and open the normal autocomplete; picking an author still needs a BAI.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-query]')) {
  button.addEventListener('click', (event) => {
    // SearchUI cancels pending searches on clicks outside its container.
    event.stopPropagation();
    searchInput.value = button.dataset.query!;
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });
}

// One-line summary above the graph, e.g. "Edward Witten has 12 co-authors here, with 30 links between them."
const summary = document.getElementById('summary')!;
function renderSummary(): void {
  const root = graphState.getNodes().find((n) => n.isRoot);
  if (!root) {
    summary.replaceChildren();
    return;
  }
  const name = document.createElement('b');
  name.textContent = root.name;
  const coauthors = graphState.nodeCount - 1;
  const links = graphState.edgeCount;
  summary.replaceChildren(
    name,
    ` has ${coauthors} co-author${coauthors === 1 ? '' : 's'} here, with ${links} link${links === 1 ? '' : 's'} between them.`,
  );
}
graphState.on('changed', renderSummary);
graphState.on('cleared', renderSummary);

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  renderer.refreshColors();
});

document.getElementById('zoom-in')!.addEventListener('click', () => renderer.zoomIn());
document.getElementById('zoom-out')!.addEventListener('click', () => renderer.zoomOut());
document.getElementById('zoom-reset')!.addEventListener('click', () => renderer.resetView());

const about = document.getElementById('about') as HTMLDialogElement;
document.getElementById('about-btn')!.addEventListener('click', () => about.showModal());
// Clicks on the backdrop land on the dialog element itself; clicks on the card do not.
about.addEventListener('click', (e) => { if (e.target === about) about.close(); });
