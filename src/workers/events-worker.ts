import Papa from 'papaparse';

interface Feature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

self.onmessage = async (e) => {
  const { csvText } = e.data;
  const features: Feature[] = [];
  let rowCount = 0;

  Papa.parse(csvText, {
    delimiter: '\t',
    header: false,
    step: (row) => {
      rowCount++;
      const lat = parseFloat(row.data[56] || '');
      const lng = parseFloat(row.data[57] || '');
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            globalEventId: row.data[0] || '',
            actor1: row.data[6] || '',
            actor2: row.data[16] || '',
            eventCode: row.data[26] || '',
            goldstein: parseFloat(row.data[30]) || 0,
            numMentions: parseInt(row.data[31]) || 0,
            tone: parseFloat(row.data[34]) || 0,
            sourceUrl: row.data[60] || row.data[59] || '',
          },
        });
      }
    },
    complete: () => {
      self.postMessage({
        geojson: { type: 'FeatureCollection', features: features.slice(0, 5000) },
        rowCount,
      });
    },
    error: (err) => self.postMessage({ error: err.message }),
  });
};
