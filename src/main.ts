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
  signal: AbortSignal,
): Promise<{
  geojson: import('geojson').FeatureCollection;
  articleMap: Map<string, Record<string, unknown>[]>;
  articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
}> {
  const { geojson } = await fetchChunk(ts, signal);

  // Build articleMap (SOURCEURL → events)
  const articleMap = new Map<string, Record<string, unknown>[]>();
  for (const f of geojson.features) {
    const props = f.properties;
    if (props?.sourceUrl) {
      const url = props.sourceUrl as string;
      if (!articleMap.has(url)) articleMap.set(url, []);
      articleMap.get(url)!.push(props);
    }
  }

  // Try to fetch gdeltnews-reconstructed articles from GitHub Releases
  const articleSources = new Map<string, { fundus?: string; stage1?: string; stage2?: string }>();
  try {
    const base = 'https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles';
    const res = await fetch(`${base}/articles_${ts}.json`, { signal });
    if (res.ok) {
      const data: Record<string, string> = await res.json();
      for (const url of articleMap.keys()) {
        if (data[url]) {
          articleSources.set(url, { stage2: data[url] });
        }
      }
    }
  } catch {
    // Article JSON not yet available – will be filled later by the polling timer
  }

  return { geojson, articleMap, articleSources };
}

// ---------- Main ----------
async function main() {
  const viewer = new Viewer('cesiumContainer', { infoBox: false });

  // Start clock ticking immediately (real‑time mode by default)
  viewer.clock.shouldAnimate = true;
  viewer.clock.clockStep = ClockStep.SYSTEM_CLOCK_MULTIPLIER;
  viewer.clock.clockRange = ClockRange.UNBOUNDED;

  // Temporary timestamp label (top‑center)
  const timestampLabel = document.createElement('div');
  timestampLabel.style.cssText = `
    position: absolute; top: 0; left: 50%; transform: translateX(-50%);
    padding: 4px 8px;
    background: rgba(0,0,0,0.55); color: white; font-size: 12px;
    z-index: 1001; pointer-events: none;
  `;
  viewer.container.appendChild(timestampLabel);

  // ---------- Cache ----------
  const chunkCache = new Map<string, {
    geojson: import('geojson').FeatureCollection;
    articleMap: Map<string, Record<string, unknown>[]>;
    articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
  }>();

  let infoBox: InfoBox | null = null;
  let latestPublishedTs = '';   // most recent chunk known via lastupdate.txt

  // Current displayed data source – used for flicker‑free swap
  let currentDataSource: GeoJsonDataSource | null = null;

  // ---------- Fetch queue ----------
  const fetchQueue = new FetchQueue((ts) => {
    // Called when a chunk finishes fetching.
    const cached = chunkCache.get(ts);
    if (!cached || !infoBox) return;

    // Always update the pre‑fetch window around the current clock position.
    schedulePreFetch();

    // Only display the chunk if the clock is currently on it.
    const clockTs = chunkTimestamp(viewer.clock.currentTime);
    if (ts === clockTs) {
      updateDisplay(ts, cached);
    }
  });

  // ---------- Helper: NATO‑style date formatting ----------
  function formatNato(ts: string): string {
    const y = ts.slice(0, 4);
    const m = ts.slice(4, 6);
    const d = ts.slice(6, 8);
    const months = [
      'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
    ];
    const monthAbbr = months[parseInt(m, 10) - 1] || m;
    const time = ts.slice(8, 12);
    return `${d} ${monthAbbr} ${y} ${time} UTC`;
  }

  // ---------- Display updater ----------
  function updateDisplay(ts: string, cached: {
    geojson: import('geojson').FeatureCollection;
    articleMap: Map<string, Record<string, unknown>[]>;
    articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
  }) {
    timestampLabel.textContent = formatNato(ts);

    // Load new data source off‑screen before removing the old one
    const newDs = new GeoJsonDataSource('chunk');
    newDs.load(cached.geojson, {
      stroke: Color.HOTPINK,
      fill: Color.PINK.withAlpha(0.5),
      strokeWidth: 2,
    }).then(() => {
      viewer.dataSources.add(newDs);
      if (currentDataSource) {
        viewer.dataSources.remove(currentDataSource);
      }
      currentDataSource = newDs;
    });

    if (infoBox) {
      infoBox.updateData(cached.articleMap, cached.articleSources);
    }
  }

  // ---------- Adaptive pre‑fetch ----------
  function schedulePreFetch() {
    const animating = viewer.clock.shouldAnimate;
    const multiplier = Math.abs(viewer.clock.multiplier);
    let windowSize = 0;

    // Paused or real‑time → maximum window
    if (!animating || multiplier <= 1) {
      windowSize = 3;
    } else if (multiplier <= 60) {
      windowSize = 3;
    } else if (multiplier <= 150) {
      windowSize = 2;
    } else if (multiplier <= 300) {
      windowSize = 1;
    }

    // Get the current chunk timestamp and convert back to a Date
    const currentTs = chunkTimestamp(viewer.clock.currentTime);
    const y = parseInt(currentTs.slice(0, 4), 10);
    const m = parseInt(currentTs.slice(4, 6), 10) - 1;
    const d = parseInt(currentTs.slice(6, 8), 10);
    const h = parseInt(currentTs.slice(8, 10), 10);
    const min = parseInt(currentTs.slice(10, 12), 10);
    const baseDate = new Date(Date.UTC(y, m, d, h, min, 0, 0));

    const offsets: number[] = [];
    for (let i = 1; i <= windowSize; i++) {
      offsets.push(i, -i);
    }

    offsets.forEach((offset) => {
      const chunkDate = new Date(baseDate);
      chunkDate.setUTCMinutes(chunkDate.getUTCMinutes() + offset * 15);
      const ts = chunkDate.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      if (!chunkCache.has(ts) && ts <= latestPublishedTs) {
        fetchQueue.enqueue(ts, 'low', async (signal) => {
          try {
            const data = await fetchAndCacheChunk(ts, signal);
            chunkCache.set(ts, data);
          } catch (err) {
            if ((err as any).name === 'AbortError') return;
          }
        });
      }
    });
  }

  // ---------- Clock tick ----------
  let lastDisplayedTs = '';
  viewer.clock.onTick.addEventListener((clock) => {
    const ts = chunkTimestamp(clock.currentTime);
    if (ts === lastDisplayedTs) return;

    // If the clock points to a chunk that isn't published yet,
    // display the latest published chunk instead (already cached).
    if (ts > latestPublishedTs) {
      const fallbackTs = latestPublishedTs;
      if (chunkCache.has(fallbackTs)) {
        updateDisplay(fallbackTs, chunkCache.get(fallbackTs)!);
        lastDisplayedTs = fallbackTs;
      } else {
        // Should never happen – the fallback was loaded at startup
        fetchQueue.enqueue(fallbackTs, 'high', async (signal) => {
          const data = await fetchAndCacheChunk(fallbackTs, signal);
          chunkCache.set(fallbackTs, data);
        });
        lastDisplayedTs = fallbackTs;
      }
      return;
    }

    // Abort everything that's not the current chunk
    fetchQueue.abortAllExcept(ts);

    // Already cached → show immediately
    if (chunkCache.has(ts)) {
      updateDisplay(ts, chunkCache.get(ts)!);
      lastDisplayedTs = ts;
      schedulePreFetch();
      return;
    }

    // Otherwise enqueue with high priority
    fetchQueue.enqueue(ts, 'high', async (signal) => {
      try {
        const data = await fetchAndCacheChunk(ts, signal);
        chunkCache.set(ts, data);
      } catch (err) {
        if ((err as any).name === 'AbortError') return;
        console.error(`Failed to load chunk ${ts}:`, err);
      }
    });
  });

  // ---------- Real‑time polling ----------
  async function pollLatest() {
    try {
      const proxy = import.meta.env.VITE_CORS_PROXY_URL || '';
      const res = await fetch(
        proxy + encodeURIComponent('http://data.gdeltproject.org/gdeltv2/lastupdate.txt'),
      );
      if (!res.ok) return;
      const text = await res.text();
      const latestFileUrl = text.trim().split('\n')[0].split(' ')[2];
      const match = latestFileUrl.match(/(\d{14})\.export\.CSV\.zip/);
      if (!match) return;
      const newTs = match[1];
      if (newTs !== latestPublishedTs) {
        latestPublishedTs = newTs;
        fetchQueue.setLatestChunk(newTs);
        // Pre‑fetch the newest chunk so it's ready when the clock reaches it
        if (!chunkCache.has(newTs)) {
          fetchQueue.enqueue(newTs, 'high', async (signal) => {
            const data = await fetchAndCacheChunk(newTs, signal);
            chunkCache.set(newTs, data);
          });
        }
      }
    } catch {
      // polling failure is silent
    }
  }

  // Kick off polling immediately, then every 60 s
  pollLatest();
  setInterval(pollLatest, 60_000);

  // ---------- InfoBox ----------
  infoBox = new InfoBox(viewer, new Map(), new Map());

  // ---------- Initial chunk load ----------
  // Read lastupdate.txt synchronously to find the truly latest published chunk
  let initialTs = '';
  try {
    const proxy = import.meta.env.VITE_CORS_PROXY_URL || '';
    const res = await fetch(
      proxy + encodeURIComponent('http://data.gdeltproject.org/gdeltv2/lastupdate.txt'),
    );
    if (res.ok) {
      const text = await res.text();
      const latestFileUrl = text.trim().split('\n')[0].split(' ')[2];
      const match = latestFileUrl.match(/(\d{14})\.export\.CSV\.zip/);
      if (match) initialTs = match[1];
    }
  } catch { /* silent */ }

  // Fallback: if the fetch failed, use the chunk 15 minutes before the clock
  if (!initialTs) {
    const d = JulianDate.toDate(viewer.clock.currentTime);
    d.setMinutes(d.getMinutes() - 15);
    initialTs = chunkTimestamp(JulianDate.fromDate(d));
  }

  latestPublishedTs = initialTs;
  fetchQueue.setLatestChunk(initialTs);

  // Load and display the most recent published chunk immediately
  fetchQueue.enqueue(initialTs, 'high', async (signal) => {
    const data = await fetchAndCacheChunk(initialTs, signal);
    chunkCache.set(initialTs, data);
  });
}

main();
