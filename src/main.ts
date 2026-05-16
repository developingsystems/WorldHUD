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
  viewer.flyTo(dataSource);
  console.log(`📊 Loaded ${geojson.features.length} events`);
} catch (err) {
  console.error('GDELT fetch failed:', err);
}
