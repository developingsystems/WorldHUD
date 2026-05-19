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
  const geojson = await fetchLatestChunk();
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

  new InfoBox(viewer, articleMap);
} catch (err) {
  console.error('GDELT fetch failed:', err);
}
