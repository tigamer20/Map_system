/* Map rendering: basemaps, team markers, snapshot pins, accuracy halo. */
(function () {
  'use strict';

  // Aucun de ces fonds ne demande de clé d'API.
  const OSM = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
  const ESRI_IMAGERY = [
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  ];
  const ESRI_PLACES = [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
  ];
  const ATTRIB_OSM = '&copy; OpenStreetMap contributors';
  const ATTRIB_CARTO = '&copy; OpenStreetMap contributors &copy; CARTO';
  const ATTRIB_ESRI = 'Imagery &copy; Esri, Maxar, Earthstar Geographics';

  function rasterStyle(tiles, attribution, options) {
    const opts = options || {};
    const style = {
      version: 8,
      sources: {
        base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom: 19 }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#14171d' } },
        { id: 'base', type: 'raster', source: 'base', paint: opts.paint || {} }
      ]
    };
    if (opts.labels) {
      style.sources.labels = { type: 'raster', tiles: opts.labels, tileSize: 256, maxzoom: 19 };
      style.layers.push({ id: 'labels', type: 'raster', source: 'labels' });
    }
    return style;
  }

  /** Tuiles CARTO : gratuites mais avec clé obligatoire depuis 2024. */
  function cartoTiles(style, key) {
    const ratio = window.devicePixelRatio > 1.4 ? '@2x' : '';
    return ['a', 'b', 'c', 'd'].map(
      (sub) => `https://${sub}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}${ratio}.png?key=${key}`
    );
  }

  /** Plan détaillé : CARTO Voyager si une clé existe, sinon OpenStreetMap. */
  function streetsStyle(config) {
    if (config.mapTilerKey) {
      return `https://api.maptiler.com/maps/streets-v2/style.json?key=${config.mapTilerKey}`;
    }
    if (config.cartoKey) {
      return rasterStyle(cartoTiles('voyager', config.cartoKey), ATTRIB_CARTO);
    }
    return rasterStyle(OSM, ATTRIB_OSM);
  }

  /**
   * Plan sombre : les mêmes tuiles OSM assombries par le moteur de rendu, ce qui
   * évite de dépendre d'un fournisseur de tuiles sombres à clé.
   */
  function darkStyle(config) {
    if (config.mapTilerKey) {
      return `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${config.mapTilerKey}`;
    }
    if (config.cartoKey) {
      return rasterStyle(cartoTiles('dark_matter', config.cartoKey), ATTRIB_CARTO);
    }
    return rasterStyle(OSM, ATTRIB_OSM, {
      paint: {
        'raster-brightness-min': 0.02,
        'raster-brightness-max': 0.52,
        'raster-saturation': -0.2,
        'raster-contrast': 0.2
      }
    });
  }

  function satelliteStyle() {
    return rasterStyle(ESRI_IMAGERY, ATTRIB_ESRI, { labels: ESRI_PLACES });
  }

  const BASEMAPS = [
    { name: 'dark', label: 'Plan sombre', build: darkStyle },
    { name: 'streets', label: 'Plan détaillé', build: streetsStyle },
    { name: 'satellite', label: 'Satellite', build: satelliteStyle }
  ];

  const basemapByName = (name) => BASEMAPS.find((b) => b.name === name) || BASEMAPS[0];

  function circlePolygon(lng, lat, meters, points) {
    const coords = [];
    const steps = points || 48;
    const latR = meters / 110574;
    const lngR = meters / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
    for (let i = 0; i <= steps; i += 1) {
      const angle = (i / steps) * 2 * Math.PI;
      coords.push([lng + lngR * Math.cos(angle), lat + latR * Math.sin(angle)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function GameMap(container, config, options) {
    const opts = options || {};
    this.config = config;
    this.basemap = basemapByName(localStorage.getItem('spymap.basemap') || 'dark').name;
    this.markers = new Map();
    this.pinMarkers = new Map();
    this.follow = true;
    this.ready = false;
    this.fellBack = false;
    this.onMarkerClick = opts.onMarkerClick || function () {};

    this.map = new maplibregl.Map({
      container,
      style: basemapByName(this.basemap).build(config),
      center: [2.3522, 48.8566],
      zoom: 12,
      attributionControl: { compact: true },
      pitchWithRotate: true,
      dragRotate: true
    });

    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left');

    this.map.on('load', () => {
      this.ready = true;
      this._addHalo();
    });

    // Une carte vide n'explique rien : clé MapTiler refusée -> retour à OSM,
    // fournisseur muet -> on le dit et on invite à changer de fond.
    this.map.on('error', (event) => {
      const err = (event && event.error) || {};
      const url = err.url || '';
      const badMapTiler = this.config.mapTilerKey && url.includes('api.maptiler.com');
      const badCarto = this.config.cartoKey && url.includes('cartocdn.com');
      if ((badMapTiler || badCarto) && !this.fellBack) {
        this.fellBack = true;
        this.config = Object.assign({}, this.config, { mapTilerKey: '', cartoKey: '' });
        this.setBasemap(this.basemap);
        if (opts.onBasemapFallback) opts.onBasemapFallback(badMapTiler ? 'MapTiler' : 'CARTO');
        return;
      }
      if (!url || this.warnedAbout === this.basemap) return;
      this.tileErrors = (this.tileErrors || 0) + 1;
      if (this.tileErrors >= 4) {
        this.warnedAbout = this.basemap;
        this.tileErrors = 0;
        if (opts.onBasemapError) opts.onBasemapError(basemapByName(this.basemap).label);
      }
    });
    this.map.on('dragstart', () => {
      this.follow = false;
      if (opts.onFollowChange) opts.onFollowChange(false);
    });
  }

  GameMap.prototype._addHalo = function () {
    if (this.map.getSource('accuracy')) return;
    this.map.addSource('accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'accuracy-fill',
      type: 'fill',
      source: 'accuracy',
      paint: { 'fill-color': '#7c8cff', 'fill-opacity': 0.14 }
    });
    this.map.addLayer({
      id: 'accuracy-line',
      type: 'line',
      source: 'accuracy',
      paint: { 'line-color': '#7c8cff', 'line-opacity': 0.45, 'line-width': 1 }
    });
  };

  GameMap.prototype.setBasemap = function (name) {
    const basemap = basemapByName(name);
    this.basemap = basemap.name;
    this.tileErrors = 0;
    localStorage.setItem('spymap.basemap', basemap.name);
    this.map.setStyle(basemap.build(this.config));
    this.map.once('styledata', () => {
      this.ready = true;
      this._addHalo();
    });
  };

  /** Enchaîne plan sombre → plan détaillé → satellite. */
  GameMap.prototype.toggleBasemap = function () {
    const index = BASEMAPS.findIndex((b) => b.name === this.basemap);
    const next = BASEMAPS[(index + 1) % BASEMAPS.length];
    this.setBasemap(next.name);
    return next;
  };

  GameMap.prototype._element = function (player, myCode) {
    const el = document.createElement('div');
    el.className = `marker ${player.team}${player.code === myCode ? ' me' : ''}`;
    el.innerHTML = `<div class="pin">${initials(player.name)}</div><div class="label"></div>`;
    el.addEventListener('click', () => this.onMarkerClick(player));
    return el;
  };

  /** Sync markers with the latest snapshot. */
  GameMap.prototype.render = function (players, myCode) {
    const seen = new Set();

    players.forEach((player) => {
      seen.add(player.code);
      let marker = this.markers.get(player.code);
      if (!marker) {
        const el = this._element(player, myCode);
        marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([player.lng, player.lat])
          .addTo(this.map);
        this.markers.set(player.code, marker);
      } else {
        marker.setLngLat([player.lng, player.lat]);
      }
      const el = marker.getElement();
      el.classList.toggle('stale', !!player.stale);
      const label = el.querySelector('.label');
      const age = Math.round((Date.now() - player.ts) / 1000);
      label.textContent = player.stale ? `${player.name} · ${Math.round(age / 60)}m ago` : player.name;
    });

    for (const [code, marker] of this.markers) {
      if (!seen.has(code)) {
        marker.remove();
        this.markers.delete(code);
      }
    }
  };

  GameMap.prototype.renderPins = function (pins) {
    const seen = new Set();
    pins.forEach((pin) => {
      seen.add(pin.id);
      if (this.pinMarkers.has(pin.id)) return;
      const el = document.createElement('div');
      el.className = `marker pinned ${pin.team}`;
      const at = new Date(pin.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `<div class="pin">!</div><div class="label">${pin.label} · ${at}</div>`;
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([pin.lng, pin.lat])
        .addTo(this.map);
      this.pinMarkers.set(pin.id, marker);
    });
    for (const [id, marker] of this.pinMarkers) {
      if (!seen.has(id)) {
        marker.remove();
        this.pinMarkers.delete(id);
      }
    }
  };

  GameMap.prototype.setAccuracy = function (lng, lat, meters) {
    if (!this.ready || !this.map.getSource('accuracy')) return;
    const data = meters
      ? { type: 'FeatureCollection', features: [circlePolygon(lng, lat, meters)] }
      : { type: 'FeatureCollection', features: [] };
    this.map.getSource('accuracy').setData(data);
  };

  GameMap.prototype.centerOn = function (lng, lat, zoom) {
    this.map.easeTo({ center: [lng, lat], zoom: zoom || Math.max(this.map.getZoom(), 16), duration: 700 });
  };

  GameMap.prototype.followTo = function (lng, lat) {
    if (!this.follow) return;
    this.map.easeTo({ center: [lng, lat], duration: 900 });
  };

  GameMap.prototype.fitAll = function (points) {
    if (!points.length) return;
    if (points.length === 1) return this.centerOn(points[0].lng, points[0].lat, 16);
    const bounds = points.reduce(
      (b, p) => b.extend([p.lng, p.lat]),
      new maplibregl.LngLatBounds([points[0].lng, points[0].lat], [points[0].lng, points[0].lat])
    );
    this.map.fitBounds(bounds, { padding: { top: 90, bottom: 260, left: 60, right: 60 }, maxZoom: 16, duration: 800 });
  };

  window.GameMap = GameMap;
  window.mapUtils = { initials, circlePolygon };
})();
