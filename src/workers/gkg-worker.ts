import Papa from 'papaparse';

interface CountEntry {
  type: string;
  number: number;
  object: string;
}

interface GkgRecord {
  mentionId: string;
  pageTitle: string;
  counts: CountEntry[];
}

self.onmessage = async (e) => {
  const { csvText } = e.data;
  const records: GkgRecord[] = [];

  Papa.parse(csvText, {
    delimiter: '\t',
    header: false,
    complete: (result) => {
      for (const row of result.data) {
        const mentionId = row[4];          // DocumentIdentifier
        const countsField = row[6] || '';  // V2Counts
        const xmlExtras = row[26] || '';   // V2ExtrasXML

        // Extract page title
        let pageTitle = '';
        if (xmlExtras) {
          const match = xmlExtras.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/);
          if (match && match[1]) pageTitle = match[1].trim();
        }

        // Parse counts
        const counts: CountEntry[] = [];
        if (countsField) {
          const blocks = countsField.split(';');
          for (const block of blocks) {
            if (!block.trim()) continue;
            const parts = block.split('#');
            if (parts.length >= 3) {
              const type = parts[0] || '';
              const number = parseInt(parts[1]) || 0;
              const object = parts[2] || '';
              if (type && number > 0) {
                counts.push({ type, number, object });
              }
            }
          }
        }

        if (mentionId && pageTitle) {
          records.push({ mentionId, pageTitle, counts });
        }
      }
      self.postMessage({ type: 'gkg', records });
    },
    error: (err) => self.postMessage({ type: 'gkg', error: err.message }),
  });
};
