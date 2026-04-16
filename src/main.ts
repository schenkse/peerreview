import { GraphState } from './graph-state';
import { GraphRenderer } from './graph-renderer';
import { NetworkBuilder } from './network-builder';
import { ProgressIndicator } from './progress';
import { SearchUI } from './search';

const graphState = new GraphState();

const graphRenderer = new GraphRenderer(
  document.getElementById('graph-container')!,
  graphState,
);

const networkBuilder = new NetworkBuilder(graphState);

const progress = new ProgressIndicator(
  document.getElementById('progress')!,
);

new SearchUI(
  document.getElementById('search-container')!,
  async (bai, name, recid) => {
    networkBuilder.cancel();
    graphState.clear();
    graphRenderer.reset();
    progress.show();
    await networkBuilder.build(bai, name, recid, (p) => progress.update(p));
  },
);
