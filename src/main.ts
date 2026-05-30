import {
  Viewer, GeoJsonDataSource, Color,
  ClockStep, JulianDate, ClockRange,
} from 'cesium';
import { InfoBox } from './ui/infobox.js';
import { fetchLatestChunk } from './data/fetch.js';
import { FetchQueue } from './data/queue.js';

// ---------- Utility: chunk timestamp from a JulianDate ----------
function chunkTimestamp(clockTime: JulianDate): string {
  const d = JulianDate.toDate(clockTime);
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
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
  const { geojson } = await fetchLatestChunk(ts, signal);

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

  // ---------- Cache ----------
  const chunkCache = new Map<string, {
    geojson: import('geojson').FeatureCollection;
    articleMap: Map<string, Record<string, unknown>[]>;
    articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
  }>();

  let infoBox: InfoBox | null = null;
  let latestPublishedTs = '';   // most recent chunk known via lastupdate.txt

  // ---------- Fetch queue ----------
  const fetchQueue = new FetchQueue((ts) => {
    // Called when a chunk finishes fetching
    const cached = chunkCache.get(ts);
    if (cached && infoBox) {
      updateDisplay(cached);
      schedulePreFetch(ts);
    }
  });

  // ---------- Display updater ----------
  function updateDisplay(cached: {
    geojson: import('geojson').FeatureCollection;
    articleMap: Map<string, Record<string, unknown>[]>;
    articleSources: Map<string, { fundus?: string; stage1?: string; stage2?: string }>;
  }) {
    viewer.dataSources.removeAll();
    const ds = new GeoJsonDataSource('chunk');
    ds.load(cached.geojson, {
      stroke: Color.HOTPINK,
      fill: Color.PINK.withAlpha(0.5),
      strokeWidth: 2,
    }).then(() => {
      viewer.dataSources.add(ds);
      viewer.flyTo(ds);
    });
    if (infoBox) {
      infoBox.updateData(cached.articleMap, cached.articleSources);
    }
  }

  // ---------- Adaptive pre‑fetch ----------
  function schedulePreFetch(currentTs: string) {
    const multiplier = viewer.clock.multiplier;
    let windowSize = 0;
    if (multiplier <= 60) windowSize = 2;         // current ±2
    else if (multiplier <= 300) windowSize = 1;   // current ±1
    // > 300× → only fetch current

    const offsets: number[] = [];
    for (let i = 1; i <= windowSize; i++) {
      offsets.push(i, -i);
    }

    offsets.forEach((offset) => {
      const d = JulianDate.toDate(viewer.clock.currentTime);
      d.setMinutes(d.getMinutes() + offset * 15);
      const ts = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      if (!chunkCache.has(ts) && ts <= latestPublishedTs) {
        fetchQueue.enqueue(ts, 'low', async (signal) => {
          try {
            const data = await fetchAndCacheChunk(ts, signal);
            chunkCache.set(ts, data);
          } catch (err) {
            if (err.name === 'AbortError') return;
            // ignore pre‑fetch failures
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

    // Already cached → show immediately
    if (chunkCache.has(ts)) {
      updateDisplay(chunkCache.get(ts)!);
      lastDisplayedTs = ts;
      schedulePreFetch(ts);
      return;
    }

    // Otherwise enqueue with high priority
    fetchQueue.enqueue(ts, 'high', async (signal) => {
      try {
        const data = await fetchAndCacheChunk(ts, signal);
        chunkCache.set(ts, data);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(`Failed to load chunk ${ts}:`, err);
      }
    });
    lastDisplayedTs = ts;
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
  try {
    const ts = chunkTimestamp(viewer.clock.currentTime);
    latestPublishedTs = ts; // fallback until first poll completes
    fetchQueue.setLatestChunk(ts);
    fetchQueue.enqueue(ts, 'high', async (signal) => {
      const data = await fetchAndCacheChunk(ts, signal);
      chunkCache.set(ts, data);
    });
  } catch (err) {
    console.error('Initial GDELT fetch failed:', err);
  }
}

main();
