import { Viewer, ImageryLayer, ArcGisMapServerImageryProvider, Terrain } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

const viewer = new Viewer('cesiumContainer', {
  terrain: Terrain.fromWorldTerrain(),
  baseLayer: new ImageryLayer(
    new ArcGisMapServerImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
    })
  ),
  // Keep the BaseLayerPicker so you can switch imagery on‑the‑fly
  baseLayerPicker: true,
});

console.log('🌍 Cesium viewer ready');
