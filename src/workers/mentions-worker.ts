import Papa from 'papaparse';

interface MentionEntry {
  globalEventId: string;
  mentionId: string;
}

self.onmessage = async (e) => {
  const { csvText } = e.data;
  const mentions: MentionEntry[] = [];

  Papa.parse(csvText, {
    delimiter: '\t',
    header: false,
    complete: (result) => {
      for (const row of result.data) {
        const globalEventId = row[0];
        const mentionId = row[5];
        if (globalEventId && mentionId) {
          mentions.push({ globalEventId, mentionId });
        }
      }
      self.postMessage({ type: 'mentions', mentions });
    },
    error: (err) => self.postMessage({ type: 'mentions', error: err.message }),
  });
};
