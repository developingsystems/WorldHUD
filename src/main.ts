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

// Create the ArcGIS imagery provider with explicit token
const arcGisImagery = await ArcGisMapServerImageryProvider.fromUrl(
  'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer',
  { enablePickFeatures: false, }
);

const viewer = new Viewer('cesiumContainer', {
  terrain: Terrain.fromWorldTerrain(),
  baseLayer: new ImageryLayer(arcGisImagery),
  baseLayerPicker: true,
});

console.log('🌍 Cesium viewer ready');
