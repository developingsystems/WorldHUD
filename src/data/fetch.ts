import type { FeatureCollection } from 'geojson';

const PROXY = import.meta.env.VITE_CORS_PROXY_URL || '';

export async function fetchLatestChunk(): Promise<{ geojson: FeatureCollection; timestamp: string }> {
  if (!PROXY) throw new Error('Missing VITE_CORS_PROXY_URL in .env');

  // 1. Get latest chunk timestamp
  const lastUpdateUrl = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';
  const lastUpdateRes = await fetch(PROXY + encodeURIComponent(lastUpdateUrl));
  if (!lastUpdateRes.ok) throw new Error(`lastupdate.txt failed: ${lastUpdateRes.status}`);
  const text = await lastUpdateRes.text();
  const latestFileUrl = text.trim().split('\n')[0].split(' ')[2];
  const match = latestFileUrl.match(/(\d{14})\.export\.CSV\.zip/);
  if (!match) throw new Error('Could not extract timestamp');
  const timestamp = match[1];

  // 2. Build URLs for all three tables
  const baseUrl = `http://data.gdeltproject.org/gdeltv2/${timestamp}`;
  const files = {
    events: `${baseUrl}.export.CSV.zip`,
    mentions: `${baseUrl}.mentions.CSV.zip`,
    gkg: `${baseUrl}.gkg.csv.zip`,
  };

  // 3. Fetch all three in parallel (with timeout + retry)
  async function fetchBlob(url: string): Promise<Blob> {
    const maxRetries = 5;
    const baseTimeout = 15000; // 15 seconds
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const timeout = baseTimeout * attempt; // backoff: 15s, 30s, 45s
      const signal = AbortSignal.timeout(timeout);
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.blob();
      } catch (err: any) {
        if (attempt < maxRetries && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          console.warn(`Fetch attempt ${attempt} timed out after ${timeout}s, retrying...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('fetchBlob: unreachable');
  }

  const [eventsBlob, mentionsBlob, gkgBlob] = await Promise.all([
    fetchBlob(PROXY + encodeURIComponent(files.events)),
    fetchBlob(PROXY + encodeURIComponent(files.mentions)),
    fetchBlob(PROXY + encodeURIComponent(files.gkg)),
  ]);

  // 4. Unzip helper
  async function unzipCsv(blob: Blob): Promise<string> {
    const { unzip } = await import('fflate');
    const buf = new Uint8Array(await blob.arrayBuffer());
    const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
      unzip(buf, (err, result) => (err ? reject(err) : resolve(result))),
    );
    const filename = Object.keys(files)[0];
    return new TextDecoder().decode(files[filename]);
  }

  // 5. Unzip all three in parallel
  const [eventsCsv, mentionsCsv, gkgCsv] = await Promise.all([
    unzipCsv(eventsBlob),
    unzipCsv(mentionsBlob),
    unzipCsv(gkgBlob),
  ]);

  // 6. Spawn workers
  const eventsWorker = new Worker(new URL('../workers/events-worker.ts', import.meta.url), { type: 'module' });
  const mentionsWorker = new Worker(new URL('../workers/mentions-worker.ts', import.meta.url), { type: 'module' });
  const gkgWorker = new Worker(new URL('../workers/gkg-worker.ts', import.meta.url), { type: 'module' });

  // 7. Create promises for each worker
  const eventsPromise = new Promise<any>((resolve, reject) => {
    eventsWorker.onmessage = (e) => (e.data.error ? reject(e.data.error) : resolve(e.data.geojson));
    eventsWorker.onerror = (err) => reject(err);
    eventsWorker.postMessage({ csvText: eventsCsv });
  });

  const mentionsPromise = new Promise<any[]>((resolve, reject) => {
    mentionsWorker.onmessage = (e) => (e.data.error ? reject(e.data.error) : resolve(e.data.mentions));
    mentionsWorker.onerror = (err) => reject(err);
    mentionsWorker.postMessage({ csvText: mentionsCsv });
  });

  const gkgPromise = new Promise<any[]>((resolve, reject) => {
    gkgWorker.onmessage = (e) => (e.data.error ? reject(e.data.error) : resolve(e.data.records));
    gkgWorker.onerror = (err) => reject(err);
    gkgWorker.postMessage({ csvText: gkgCsv });
  });

  const [eventsGeojson, mentionsArray, gkgRecords] = await Promise.all([eventsPromise, mentionsPromise, gkgPromise]);

  console.log(`✅ Loaded ${eventsGeojson.features.length} events`);
  console.log(`✅ Loaded ${mentionsArray.length} mentions`);
  console.log(`✅ Loaded ${gkgRecords.length} GKG records`);

  // 8. Build lookup maps …
  const mentionsMap = new Map<string, string[]>();   // GLOBALEVENTID → MentionIdentifier[]
  for (const { globalEventId, mentionId } of mentionsArray) {
    if (!mentionsMap.has(globalEventId)) mentionsMap.set(globalEventId, []);
    mentionsMap.get(globalEventId)!.push(mentionId);
  }

  const gkgMap = new Map<string, { pageTitle: string; counts: any[] }>();
  for (const { mentionId, pageTitle, counts } of gkgRecords) {
    gkgMap.set(mentionId, { pageTitle, counts });
  }

  // 9. Enrich events with headlines and counts
  for (const feature of (eventsGeojson as FeatureCollection).features) {
    const globalEventId = feature.properties?.globalEventId as string;
    const mentionIds = mentionsMap.get(globalEventId) || [];
    const headlines: string[] = [];
    const counts: any[] = [];
    for (const mId of mentionIds) {
      const gkgEntry = gkgMap.get(mId);
      if (gkgEntry) {
        headlines.push(gkgEntry.pageTitle);
        counts.push(...gkgEntry.counts);
      }
    }
    if (feature.properties) {
      feature.properties.headlines = headlines;
      feature.properties.counts = counts;
    }
  }

    return { geojson: eventsGeojson as FeatureCollection, timestamp };
}
