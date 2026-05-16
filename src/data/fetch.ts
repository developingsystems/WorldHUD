import type { FeatureCollection } from 'geojson';

const PROXY = import.meta.env.VITE_CORS_PROXY_URL || '';

export async function fetchLatestChunk(): Promise<FeatureCollection> {
  if (!PROXY) throw new Error('Missing VITE_CORS_PROXY_URL in .env');

  // 1. Get the latest chunk timestamp
  const lastUpdateUrl = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';
  const lastUpdateRes = await fetch(PROXY + encodeURIComponent(lastUpdateUrl));
  if (!lastUpdateRes.ok) throw new Error(`lastupdate.txt failed: ${lastUpdateRes.status}`);
  const text = await lastUpdateRes.text();
  const latestFileUrl = text.trim().split('\n')[0].split(' ')[2];
  const match = latestFileUrl.match(/(\d{14})\.export\.CSV\.zip/);
  if (!match) throw new Error('Could not extract timestamp');
  const timestamp = match[1];

  // 2. Fetch the Events CSV
  const eventsUrl = `http://data.gdeltproject.org/gdeltv2/${timestamp}.export.CSV.zip`;
  const resp = await fetch(PROXY + encodeURIComponent(eventsUrl));
  if (!resp.ok) throw new Error(`Events fetch failed: ${resp.status}`);

  // 3. Unzip
  const blob = await resp.blob();
  const { unzip } = await import('fflate');
  const buf = new Uint8Array(await blob.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(buf, (err, result) => (err ? reject(err) : resolve(result)))
  );
  const filename = Object.keys(files)[0];
  const csvText = new TextDecoder().decode(files[filename]);

  // 4. Parse in Web Worker
  const worker = new Worker(new URL('../workers/events-worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.postMessage({ csvText });
    worker.onmessage = (e) => {
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.geojson);
    };
    worker.onerror = (err) => reject(err);
  });
}
