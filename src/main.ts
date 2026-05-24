import {
  Ion,
  Viewer,
  ImageryLayer,
  ArcGisMapServerImageryProvider,
  ArcGisMapService,
  Terrain,
  Color,
  GeoJsonDataSource,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { fetchLatestChunk } from './data/fetch';
import { InfoBox } from './ui/infobox.js';

Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
ArcGisMapService.defaultAccessToken = import.meta.env.VITE_ARCGIS_TOKEN;

// ── Viewer ── 
const arcGisImagery = await ArcGisMapServerImageryProvider.fromUrl(
  `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer?token=${import.meta.env.VITE_ARCGIS_TOKEN}`,
  { enablePickFeatures: false }
);

const viewer = new Viewer('cesiumContainer', {
  terrain: Terrain.fromWorldTerrain(),
  baseLayer: new ImageryLayer(arcGisImagery),
  baseLayerPicker: true,
  infoBox: false,
});

console.log('🌍 Cesium viewer ready');

// ── GDELT News Pulse ──
try {
  const { geojson, timestamp } = await fetchLatestChunk();
  const dataSource = await GeoJsonDataSource.load(geojson, {
    stroke: Color.HOTPINK,
    fill: Color.PINK.withAlpha(0.5),
    strokeWidth: 2,
  });
  viewer.dataSources.add(dataSource);

  // Build a map of sourceUrl → all event properties for per‑article InfoBoxes
  const articleMap = new Map<string, Record<string, unknown>[]>();
  for (const feature of geojson.features) {
    const props = feature.properties;
    if (props && props.sourceUrl) {
      const url = props.sourceUrl as string;
      if (!articleMap.has(url)) articleMap.set(url, []);
      articleMap.get(url)!.push(props);
    }
  }

  // Fetch the two article JSON files from GitHub Pages
  const base = 'https://developingsystems.github.io/WorldHUD';
  const stage1File = `${base}/articles_${timestamp}_stage1.json`;
  const stage2File = `${base}/articles_${timestamp}.json`;

  // Helper to fetch & parse JSON, returns empty object on failure
  const fetchJson = async (url: string) => {
    try {
      const res = await fetch(url);
      return res.ok ? await res.json() as Record<string, string> : {};
    } catch { return {}; }
  };

  const [stage1Data, stage2Data] = await Promise.all([
    fetchJson(stage1File),
    fetchJson(stage2File),
  ]);

  // Build a three‑version article source map (fundus will be added later)
  const articleSources = new Map<string, { fundus?: string; stage1?: string; stage2?: string }>();
  for (const url of articleMap.keys()) {
    const sources: { fundus?: string; stage1?: string; stage2?: string } = {};
    if (stage1Data[url]) sources.stage1 = stage1Data[url];
    if (stage2Data[url]) sources.stage2 = stage2Data[url];
    // fundus will be populated once that pipeline is built
    articleSources.set(url, sources);
  }

  new InfoBox(viewer, articleMap, articleSources);
} catch (err) {
  console.error('GDELT fetch failed:', err);
}
