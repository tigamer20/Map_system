/* Map rendering: basemaps, team markers, snapshot pins, accuracy halo. */
(function () {
  'use strict';

  const CARTO = ['a', 'b', 'c', 'd'].map(
    (s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{ratio}.png`
  );
  const ATTRIB_OSM = '&copy; OpenStreetMap contributors &copy; CARTO';
  const ATTRIB_ESRI = 'Imagery &copy; Esri, Maxar, Earthstar Geographics';

  function rasterStyle(tiles, attribution, extra) {
    const style = {
      version: 8,
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sources: {
        base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom: 19 }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
        { id: 'base', type: 'raster', source: 'base' }
      ]
    };
    if (extra) {
      style.sources.labels = {
        type: 'raster',
        tiles: extra.tiles,
        tileSize: 256,
        maxzoom: 19
      };
      style.layers.push({ id: 'labels', type: 'raster', source: 'labels' });
    }
    return style;
  }

  /** Streets basemap: MapTiler vector when a key is configured, CARTO Voyager otherwise. */
  function streetsStyle(config) {
    if (config.mapTilerKey) {
      return `https://api.maptiler.com/maps/streets-v2/style.json?key=${config.mapTilerKey}`;
    }
    const ratio = window.devicePixelRatio > 1.4 ? '@2x' : '';
    return rasterStyle(CARTO.map((t) => t.replace('{ratio}', ratio)), ATTRIB_OSM);
  }

  function satelliteStyle() {
    return rasterStyle(
      ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      ATTRIB_ESRI,
      { tiles: ['https://basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png'] }
    );
  }

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
    this.basemap = localStorage.getItem('spymap.basemap') || 'streets';
    this.markers = new Map();
    this.pinMarkers = new Map();
    this.follow = true;
    this.ready = false;
    this.onMarkerClick = opts.onMarkerClick || function () {};

    this.map = new maplibregl.Map({
      container,
      style: this.basemap === 'satellite' ? satelliteStyle() : streetsStyle(config),
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
      paint: { 'fill-color': '#35d0e0', 'fill-opacity': 0.12 }
    });
    this.map.addLayer({
      id: 'accuracy-line',
      type: 'line',
      source: 'accuracy',
      paint: { 'line-color': '#35d0e0', 'line-opacity': 0.4, 'line-width': 1 }
    });
  };

  GameMap.prototype.setBasemap = function (name) {
    this.basemap = name;
    localStorage.setItem('spymap.basemap', name);
    const style = name === 'satellite' ? satelliteStyle() : streetsStyle(this.config);
    this.map.setStyle(style);
    this.map.once('styledata', () => {
      this.ready = true;
      this._addHalo();
    });
  };

  GameMap.prototype.toggleBasemap = function () {
    this.setBasemap(this.basemap === 'satellite' ? 'streets' : 'satellite');
    return this.basemap;
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
