/* MapLibre v6 ships ESM only: expose it as a global, then load the classic app scripts. */
import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';

window.maplibregl = maplibregl;

import('/js/map.js')
  .then(() => import('/js/app.js'))
  .catch((err) => {
    console.error('Failed to start the app', err);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="toast error" style="position:fixed;left:16px;right:16px;top:16px;z-index:99">The map failed to load. Refresh the page.</div>'
    );
  });
