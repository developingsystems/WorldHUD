import {
  Viewer, GeoJsonDataSource, Color,
  ClockStep, JulianDate, ClockRange, Ion, ArcGisMapService,
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
  articleSources: Map<string, { fundus?: string; gdeltnews?: string }>;
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

  const articleSources = new Map<string, { fundus?: string; gdeltnews?: string }>();

  // Fetch article JSON through the CORS proxy (same as all other fetches)
  try {
    const proxy = import.meta.env.VITE_CORS_PROXY_URL || '';
    const base = 'https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles';
    const res = await fetch(proxy + encodeURIComponent(`${base}/articles_${ts}.json`), { signal });
    if (res.ok) {
      const data: Record<string, string> = await res.json();
      for (const url of articleMap.keys()) {
        if (data[url]) articleSources.set(url, { gdeltnews: data[url] });
      }
    }
  } catch {
    // article JSON not yet ready – will be filled later by the polling retry
  }

  return { geojson, articleMap, articleSources };
}

// ---------- Main ----------
async function main() {
  // Set the access tokens BEFORE creating the viewer
  Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
  ArcGisMapService.defaultAccessToken = import.meta.env.VITE_ARCGIS_TOKEN;

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
    articleSources: Map<string, { fundus?: string; gdeltnews?: string }>;
  }>();

  // InfoBox must be created BEFORE the initial chunk load so that updateDisplay
  // can start polling for article JSON immediately.
  const infoBox = new InfoBox(viewer, new Map(), new Map());

  let latestPublishedTs = '';
  let currentDataSource: GeoJsonDataSource | null = null;

  // ---------- Dispatch secrets ----------
  const DISPATCH_URL = import.meta.env.VITE_DISPATCH_URL || '';
  const DISPATCH_SECRET = import.meta.env.VITE_DISPATCH_SECRET || '';

async function dispatchReconstruction(chunkTs: string) {
  if (!DISPATCH_URL) return;
  try {
    await fetch(DISPATCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Secret': DISPATCH_SECRET,
      },
      body: JSON.stringify({
        ref: 'main',
        workflow_id: 'gdeltnews',
        inputs: { chunk_timestamp: chunkTs },
      }),
    });
    console.log(`[dispatch] Reconstruction requested for ${chunkTs}`);
  } catch (err) {
    console.warn('[dispatch] Failed to request reconstruction:', err);
  }
}

  async function dispatchFundusExtraction(chunkTs: string, urls: string[]) {
    if (!DISPATCH_URL || urls.length === 0) return;
    try {
      await fetch(DISPATCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Secret': DISPATCH_SECRET,
        },
        body: JSON.stringify({
          ref: 'main',
          workflow_id: 'fundus',
          inputs: {
            chunk_timestamp: chunkTs,
            urls: JSON.stringify(urls),
          },
        }),
      });
      console.log(`[dispatch] Fundus extraction requested for ${chunkTs} (${urls.length} URLs)`);
    } catch (err) {
      console.warn('[dispatch] Failed to request Fundus extraction:', err);
    }
  }

  // NEW: Trafilatura extraction dispatch
  async function dispatchTrafilaturaExtraction(chunkTs: string, urls: string[]) {
    if (!DISPATCH_URL || urls.length === 0) return;
    try {
      await fetch(DISPATCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Secret': DISPATCH_SECRET,
        },
        body: JSON.stringify({
          ref: 'main',
          workflow_id: 'trafilatura',
          inputs: {
            chunk_timestamp: chunkTs,
            urls: JSON.stringify(urls),
          },
        }),
      });
      console.log(`[dispatch] Trafilatura extraction requested for ${chunkTs} (${urls.length} URLs)`);
    } catch (err) {
      console.warn('[dispatch] Failed to request Trafilatura extraction:', err);
    }
  }

  // ---------- Fetch queue ----------
  const fetchQueue = new FetchQueue((ts) => {
    const cached = chunkCache.get(ts);
    if (!cached) return;
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
    articleSources: Map<string, { fundus?: string; gdeltnews?: string }>;
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

    infoBox.updateData(cached.articleMap, cached.articleSources);

    // ---------- Polling retry for article JSON ----------
    const existingInterval = (cached as any)._articlePollInterval;
    if (existingInterval) clearInterval(existingInterval);

    const hasAnyArticle = [...cached.articleSources.values()].some(
      (s) => s.fundus || s.gdeltnews,
    );

    if (!hasAnyArticle) {
      const proxy = import.meta.env.VITE_CORS_PROXY_URL || '';
      const base = 'https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles';
      const url = proxy + encodeURIComponent(`${base}/articles_${ts}.json`);

      const tryFetch = () => {
        fetch(url)
          .then((res) => (res.ok ? res.json() : null))
          .then((data: Record<string, string> | null) => {
            if (!data) return;
            for (const u of cached.articleMap.keys()) {
              if (data[u]) cached.articleSources.set(u, { gdeltnews: data[u] });
            }
            infoBox.updateData(cached.articleMap, cached.articleSources);
            const intervalId = (cached as any)._articlePollInterval;
            if (intervalId) clearInterval(intervalId);
            (cached as any)._articlePollInterval = null;
          })
          .catch(() => {});
      };

      tryFetch();
      (cached as any)._articlePollInterval = setInterval(tryFetch, 10000);
    }
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
          let aborted = false;
          try {
            const data = await fetchAndCacheChunk(t, signal);
            chunkCache.set(t, data);
          } catch (err) {
            if ((err as any).name === 'AbortError') {
              aborted = true;
            }
          }
          if (!aborted) next();
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

    if (Math.abs(viewer.clock.multiplier) > 300) {
      fetchQueue.abortAllExcept(ts);
    }

    if (chunkCache.has(ts)) {
      updateDisplay(ts, chunkCache.get(ts)!);
      lastDisplayedTs = ts;
      schedulePreFetch();
      return;
    }

    fetchQueue.enqueue(ts, 'high', async (signal) => {
      try {
        const data = await fetchAndCacheChunk(ts, signal);
        chunkCache.set(ts, data);
        dispatchReconstruction(ts);
        const urls = [...data.articleMap.keys()];
        dispatchFundusExtraction(ts, urls);
        dispatchTrafilaturaExtraction(ts, urls);   // <-- added
      } catch (err) {
        if ((err as any).name === 'AbortError') return;
        console.error(`Failed to load chunk ${ts}:`, err);
      }
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
            dispatchReconstruction(newTs);
            const urls = [...data.articleMap.keys()];
            dispatchFundusExtraction(newTs, urls);
            dispatchTrafilaturaExtraction(newTs, urls);   // <-- added
          });
        }
      }
    } catch {}
  }

  // ---------- Initial load ----------
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
    const d = JulianDate.toDate(viewer.clock.currentTime);
    d.setMinutes(d.getMinutes() - 15);
    initialTs = chunkTimestamp(JulianDate.fromDate(d));
  }

  try {
    const data = await fetchAndCacheChunk(initialTs);
    chunkCache.set(initialTs, data);
    latestPublishedTs = initialTs;
    fetchQueue.setLatestChunk(initialTs);
    updateDisplay(initialTs, data);
    lastDisplayedTs = initialTs;
    schedulePreFetch();
    dispatchReconstruction(initialTs);
    const urls = [...data.articleMap.keys()];
    dispatchFundusExtraction(initialTs, urls);
    dispatchTrafilaturaExtraction(initialTs, urls);   // <-- added
  } catch (err) {
    console.error('Initial chunk load failed:', err);
  }

  setInterval(pollLatest, 60_000);
}

main();
