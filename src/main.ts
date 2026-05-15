import {
  Ion,
  Viewer,
  ImageryLayer,
  ArcGisMapServerImageryProvider,
  ArcGisMapService,
  Terrain,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// Set both tokens
Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
ArcGisMapService.defaultAccessToken = import.meta.env.VITE_ARCGIS_TOKEN;

const proxyBase = 'https://cors-proxy.systemworkers.workers.dev/?url=';
const arcGisUrl = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer';

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
