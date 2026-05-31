import {
  Viewer, GeoJsonDataSource, Color,
  ClockStep, JulianDate, ClockRange,
} from 'cesium';
import { InfoBox } from './ui/infobox.js';
import { fetchChunk } from './data/fetch.js';
import { FetchQueue } from './data/queue.js';

// ---------- Utility: chunk timestamp from a JulianDate ----------
function chunkTimestamp(clockTime: JulianDate): string {
  const d = JulianDate.toDate(clockTime);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
  if (d.getMinutes() === 60) {
    d.setMinutes(0);
    d.setHours(d.getHours() + 1);
  }
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// ---------- Core fetch logic for a single chunk ----------
async function fetchAndCacheChunk(
  ts: string,
  signal?: AbortSignal,
): Promise<{
  geojson: import('geojson').FeatureCollection;
  articleMap: Map<string, Record<string, unknown>[]>;
  articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
}> {
  const { geojson } = await fetchChunk(ts, signal);

  const articleMap = new Map<string, Record<string, unknown>[]>();
  for (const f of geojson.features) {
    const props = f.properties;
    if (props?.sourceUrl) {
      const url = props.sourceUrl as string;
      if (!articleMap.has(url)) articleMap.set(url, []);
      articleMap.get(url)!.push(props);
    }
  }

  const articleSources = new Map<string, { fundus?: string; stage1?: string; stage2?: string }>();
  try {
    const base = 'https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles';
    const res = await fetch(`${base}/articles_${ts}.json`, { signal });
    if (res.ok) {
      const data: Record<string, string> = await res.json();
      for (const url of articleMap.keys()) {
        if (data[url]) articleSources.set(url, { stage2: data[url] });
      }
    }
  } catch {
    // article JSON not yet ready
  }

  return { geojson, articleMap, articleSources };
}

// ---------- Main ----------
async function main() {
  const viewer = new Viewer('cesiumContainer', { infoBox: false });

  viewer.clock.shouldAnimate = true;
  viewer.clock.clockStep = ClockStep.SYSTEM_CLOCK_MULTIPLIER;
  viewer.clock.clockRange = ClockRange.UNBOUNDED;

  const timestampLabel = document.createElement('div');
  timestampLabel.style.cssText = `
    position: absolute; top: 0; left: 50%; transform: translateX(-50%);
    padding: 4px 8px; background: rgba(0,0,0,0.55); color: white;
    font-size: 12px; z-index: 1001; pointer-events: none;
  `;
  viewer.container.appendChild(timestampLabel);

  const chunkCache = new Map<string, {
    geojson: import('geojson').FeatureCollection;
    articleMap: Map<string, Record<string, unknown>[]>;
    articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
  }>();

  let infoBox: InfoBox | null = null;
  let latestPublishedTs = '';

  let currentDataSource: GeoJsonDataSource | null = null;

  // ---------- Fetch queue ----------
  const fetchQueue = new FetchQueue((ts) => {
    const cached = chunkCache.get(ts);
    if (!cached || !infoBox) return;
    const clockTs = chunkTimestamp(viewer.clock.currentTime);
    if (ts === clockTs) {
      updateDisplay(ts, cached);
      schedulePreFetch();
    }
  });

  function formatNato(ts: string): string {
    const y = ts.slice(0, 4), m = ts.slice(4, 6), d = ts.slice(6, 8);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const monthAbbr = months[parseInt(m,10)-1] || m;
    const time = ts.slice(8,12);
    return `${d} ${monthAbbr} ${y} ${time} UTC`;
  }

  function updateDisplay(ts: string, cached: {
    geojson: import('geojson').FeatureCollection;
    articleMap: Map<string, Record<string, unknown>[]>;
    articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
  }) {
    const newDs = new GeoJsonDataSource('chunk');
    newDs.load(cached.geojson, {
      stroke: Color.HOTPINK,
      fill: Color.PINK.withAlpha(0.5),
      strokeWidth: 2,
    }).then(() => {
      viewer.dataSources.add(newDs);
      if (currentDataSource) viewer.dataSources.remove(currentDataSource);
      currentDataSource = newDs;
      timestampLabel.textContent = formatNato(ts);
    });

    if (infoBox) infoBox.updateData(cached.articleMap, cached.articleSources);
  }

  // ---------- Adaptive pre‑fetch ----------
  function schedulePreFetch() {
    const animating = viewer.clock.shouldAnimate;
    const multiplier = Math.abs(viewer.clock.multiplier);
    let w = 0;
    if (!animating || multiplier <= 1) w = 3;
    else if (multiplier <= 60) w = 3;
    else if (multiplier <= 150) w = 2;
    else if (multiplier <= 300) w = 1;

    const cur = lastDisplayedTs || chunkTimestamp(viewer.clock.currentTime);
    const y = parseInt(cur.slice(0,4),10), mo = parseInt(cur.slice(4,6),10)-1,
          d = parseInt(cur.slice(6,8),10), h = parseInt(cur.slice(8,10),10),
          mi = parseInt(cur.slice(10,12),10);
    const base = new Date(Date.UTC(y, mo, d, h, mi, 0, 0));

    const timestamps: string[] = [];
    for (let i = 1; i <= w; i++) {
      for (const off of [i, -i]) {
        const cd = new Date(base);
        cd.setUTCMinutes(cd.getUTCMinutes() + off * 15);
        const ts = cd.toISOString().replace(/[-:T]/g, '').slice(0,14);
        if (!chunkCache.has(ts) && ts <= latestPublishedTs) timestamps.push(ts);
      }
    }

    if (cur === latestPublishedTs) {
      let idx = 0;
      function next() {
        if (idx >= timestamps.length) return;
        const t = timestamps[idx++];
        fetchQueue.enqueue(t, 'low', async (signal) => {
          try { chunkCache.set(t, await fetchAndCacheChunk(t, signal)); }
          catch (err) { if ((err as any).name === 'AbortError') return; }
          finally { next(); }
        });
      }
      next();
    } else {
      timestamps.forEach(ts => {
        fetchQueue.enqueue(ts, 'low', async (signal) => {
          try { chunkCache.set(ts, await fetchAndCacheChunk(ts, signal)); }
          catch (err) { if ((err as any).name === 'AbortError') return; }
        });
      });
    }
  }

  // ---------- Clock tick ----------
  let lastDisplayedTs = '';
  viewer.clock.onTick.addEventListener((clock) => {
    const ts = chunkTimestamp(clock.currentTime);
    if (ts === lastDisplayedTs) return;

    if (ts > latestPublishedTs) return;

    // Cancel all stale tasks leftover from fast scrubbing
    fetchQueue.abortAllExcept(ts);

    // Normal path – chunk exists, show it (or fetch if not cached)
    if (chunkCache.has(ts)) {
      updateDisplay(ts, chunkCache.get(ts)!);
      lastDisplayedTs = ts;
      schedulePreFetch();
      return;
    }

    fetchQueue.enqueue(ts, 'high', async (signal) => {
      try { chunkCache.set(ts, await fetchAndCacheChunk(ts, signal)); }
      catch (err) { if ((err as any).name === 'AbortError') return; }
    });
  });

  // ---------- Polling ----------
  async function pollLatest() {
    try {
      const proxy = import.meta.env.VITE_CORS_PROXY_URL || '';
      const res = await fetch(proxy + encodeURIComponent('http://data.gdeltproject.org/gdeltv2/lastupdate.txt'));
      if (!res.ok) return;
      const text = await res.text();
      const fileUrl = text.trim().split('\n')[0].split(' ')[2];
      const match = fileUrl.match(/(\d{14})\.export\.CSV\.zip/);
      if (!match) return;
      const newTs = match[1];
      if (newTs !== latestPublishedTs) {
        latestPublishedTs = newTs;
        fetchQueue.setLatestChunk(newTs);
        if (!chunkCache.has(newTs)) {
          fetchQueue.enqueue(newTs, 'high', async (signal) => {
            const data = await fetchAndCacheChunk(newTs, signal);
            chunkCache.set(newTs, data);
          });
        }
      }
    } catch {}
  }

  // ---------- Initial load ----------
  // Read lastupdate.txt directly, but don't publish the timestamp until the chunk is ready.
  let initialTs = '';
  try {
    const proxy = import.meta.env.VITE_CORS_PROXY_URL || '';
    const res = await fetch(proxy + encodeURIComponent('http://data.gdeltproject.org/gdeltv2/lastupdate.txt'));
    if (res.ok) {
      const text = await res.text();
      const fileUrl = text.trim().split('\n')[0].split(' ')[2];
      const match = fileUrl.match(/(\d{14})\.export\.CSV\.zip/);
      if (match) initialTs = match[1];
    }
  } catch {}

  if (!initialTs) {
    // Fallback – use the clock's current chunk minus 15 minutes
    const d = JulianDate.toDate(viewer.clock.currentTime);
    d.setMinutes(d.getMinutes() - 15);
    initialTs = chunkTimestamp(JulianDate.fromDate(d));
  }

  // Fetch and display the initial chunk, then enable the clock tick guardrail.
  try {
    const data = await fetchAndCacheChunk(initialTs);
    chunkCache.set(initialTs, data);
    updateDisplay(initialTs, data);
    lastDisplayedTs = initialTs;
    schedulePreFetch();
  } catch (err) {
    console.error('Initial chunk load failed:', err);
  }

  // Now that the globe is populated, allow the clock tick to see the real latest timestamp.
  latestPublishedTs = initialTs;
  fetchQueue.setLatestChunk(initialTs);

  setInterval(pollLatest, 60_000);
  infoBox = new InfoBox(viewer, new Map(), new Map());
}

main();
