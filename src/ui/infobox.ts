import { Viewer, Entity } from 'cesium';
import DOMPurify, { type Config } from 'dompurify';
import { marked } from 'marked';
import { getVerb, getRootVerbPast } from '../data/cameoverbs.js';

// =============================================================================
// Type declarations for the Sanitizer API (not yet in TypeScript's DOM lib)
// =============================================================================
declare global {
  interface Element {
    setHTML(html: string, options?: { sanitizer: Sanitizer }): void;
  }
}

interface SanitizerConfig {
  allowElements?: readonly string[];
  blockElements?: readonly string[];
  dropElements?: readonly string[];
  allowAttributes?: Record<string, readonly string[]>;
  dropAttributes?: Record<string, readonly string[]>;
  allowComments?: boolean;
  allowDataAttributes?: boolean;
}

declare class Sanitizer {
  constructor(config?: SanitizerConfig);
  sanitize(input: Document | DocumentFragment | Element): DocumentFragment;
  sanitizeFor(elementName: string, input: string): Element;
}

// =============================================================================
// Feature detection: Sanitizer API (Firefox 148+, Chrome 146+)
// =============================================================================
function hasNativeSanitizer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof Sanitizer === 'function' &&
    typeof Element.prototype.setHTML === 'function'
  );
}

// =============================================================================
// GDELT allowed tags & attributes (mirrored for DOMPurify and native Sanitizer)
// =============================================================================
const GDELT_ALLOWED_TAGS = [
  'a', 'p', 'strong', 'em', 'br', 'hr',
  'ul', 'ol', 'li', 'div', 'span',
] as const;

/** DOMPurify configuration – compatible with v3.x */
const GDELT_DOMPURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [...GDELT_ALLOWED_TAGS],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'title'],
  ALLOWED_URI_REGEXP: /^https?:\/\//,
  ALLOW_UNKNOWN_PROTOCOLS: true,
  ADD_ATTR: ['target'],
};

// =============================================================================
// Sanitization function (auto‑picks native or fallback)
// =============================================================================
function sanitize(html: string): string {
  if (hasNativeSanitizer()) {
    const sanitizer = new Sanitizer({
      allowElements: [...GDELT_ALLOWED_TAGS],
    });
    const temp = document.createElement('div');
    temp.setHTML(html, { sanitizer });
    return temp.innerHTML as unknown as string;
  }
  return DOMPurify.sanitize(html, GDELT_DOMPURIFY_CONFIG);
}

// =============================================================================
// Helper: Extract article text from any source format (string or object)
// =============================================================================
function getTextFromSource(sourceEntry: unknown): string {
  if (!sourceEntry) return '';
  if (typeof sourceEntry === 'string') return sourceEntry;
  if (typeof sourceEntry === 'object' && sourceEntry !== null) {
    if ('text' in sourceEntry && typeof sourceEntry.text === 'string') return sourceEntry.text;
    if ('content' in sourceEntry && typeof sourceEntry.content === 'string') return sourceEntry.content;
    return JSON.stringify(sourceEntry);
  }
  return '';
}

// =============================================================================
// Snapshot type – captured when an entity is selected
// =============================================================================
interface Snapshot {
  sourceUrl: string;
  headlines: string[];
  globalEventId: string;
  actor1: string;
  actor2: string;
  eventCode: string;
  goldstein: number;
  numMentions: number;
  tone: number;
  articleMap: Map<string, Record<string, unknown>[]>;
}

type ArticleSources = Map<string, { fundus?: unknown; gdeltnews?: unknown; trafilatura?: unknown }>;

// =============================================================================
// Helper: Choose best source based on priority and 50% gdeltnews advantage
// -----------------------------------------------------------------------------
// Priority order: Fundus > Trafilatura > gdeltnews.
// But if gdeltnews text is at least 50% longer than the current best, switch to gdeltnews.
// =============================================================================
function selectBestSource(sources: {
  fundus?: unknown;
  trafilatura?: unknown;
  gdeltnews?: unknown;
}): { source: 'fundus' | 'gdeltnews' | 'trafilatura'; text: string } | null {
  const fundusText = sources.fundus ? getTextFromSource(sources.fundus) : '';
  const trafilaturaText = sources.trafilatura ? getTextFromSource(sources.trafilatura) : '';
  const gdeltnewsText = sources.gdeltnews ? getTextFromSource(sources.gdeltnews) : '';

  // Priority order: Fundus, then Trafilatura, then gdeltnews
  let bestSource: 'fundus' | 'gdeltnews' | 'trafilatura' | null = null;
  let bestText = '';

  if (fundusText) {
    bestSource = 'fundus';
    bestText = fundusText;
  } else if (trafilaturaText) {
    bestSource = 'trafilatura';
    bestText = trafilaturaText;
  } else if (gdeltnewsText) {
    bestSource = 'gdeltnews';
    bestText = gdeltnewsText;
  } else {
    return null;
  }

  // If gdeltnews exists and is at least 50% longer than the best text, override
  if (gdeltnewsText && bestText && gdeltnewsText.length >= 1.5 * bestText.length) {
    return { source: 'gdeltnews', text: gdeltnewsText };
  }

  return bestSource ? { source: bestSource, text: bestText } : null;
}

// =============================================================================
// Helper: Render Markdown to HTML asynchronously (non‑blocking)
// =============================================================================
async function renderMarkdown(markdown: string): Promise<string> {
  if (!markdown) return '';
  try {
    const rawHtml = await marked.parse(markdown);
    return DOMPurify.sanitize(rawHtml, GDELT_DOMPURIFY_CONFIG);
  } catch (error) {
    console.error('Markdown rendering failed:', error);
    // Fallback: return escaped text
    return escapeHtml(markdown);
  }
}

// =============================================================================
// Helper: Escape HTML special characters (for plain text fallback)
// =============================================================================
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =============================================================================
// Helper: Get tone color with non‑linear mapping (enhances -10..10 range)
// =============================================================================
function getToneColor(tone: number): string {
  let x = Math.min(100, Math.max(-100, tone));
  const sign = x === 0 ? 0 : Math.sign(x);
  const absX = Math.abs(x);
  // Use exponent 0.25 (fourth root) for stronger colour differentiation in the ±10 range
  const t = sign * Math.pow(absX / 100, 0.25);
  const normalized = (t + 1) / 2;
  return `color-mix(in oklab, color-mix(in oklab, red ${(1 - normalized) * 100}%, gray 100%), green ${normalized * 100}%)`;
}

// =============================================================================
// Format tone number with sign (+ for positive, - for negative)
// =============================================================================
function formatTone(tone: number): string {
  const sign = tone > 0 ? '+' : '';
  return sign + tone.toFixed(2);
}

// =============================================================================
// Render function with rich Trafilatura support (async)
// =============================================================================
async function renderGdelt(
  snapshot: Snapshot,
  articleMap: Map<string, Record<string, unknown>[]>,
  articleSources: ArticleSources,
  currentSource: 'fundus' | 'gdeltnews' | 'trafilatura',
): Promise<{ title: string; body: string; footer: string }> {
  const { sourceUrl, headlines, globalEventId } = snapshot;
  const esc = (s: unknown): string => {
    const str = s == null ? '' : String(s);
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  const sources = articleSources.get(sourceUrl) || {};
  let rawTitle = '';
  let descriptionHtml = '';
  let articleHtml = '';

  // --- Title & Description based on current source ---
  if (currentSource === 'trafilatura' && sources.trafilatura && typeof sources.trafilatura === 'object') {
    const traf = sources.trafilatura as any;
    if (traf.description) {
      descriptionHtml = `<div class="infobox-description">${esc(traf.description)}</div>`;
    }
    const titleFromTraf = traf.title || (headlines && headlines[0]) || 'GDELT Event';
    const decode = (s: string) => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent || s;
    const decodedTitle = decode(titleFromTraf);
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(decodedTitle)}</a>`;
    const markdownText = traf.text || '';
    articleHtml = await renderMarkdown(markdownText);
  } else if (currentSource === 'trafilatura' && typeof sources.trafilatura === 'string') {
    const headline = (headlines && headlines[0]) ? headlines[0] : 'GDELT Event';
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(headline)}</a>`;
    articleHtml = await renderMarkdown(sources.trafilatura);
  } else if (currentSource === 'gdeltnews' && sources.gdeltnews) {
    const headline = (headlines && headlines[0]) ? headlines[0] : 'GDELT Event';
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(headline)}</a>`;
    const plainText = getTextFromSource(sources.gdeltnews);
    articleHtml = `<p>${esc(plainText)}</p>`;
  } else if (currentSource === 'fundus' && sources.fundus) {
    const headline = (headlines && headlines[0]) ? headlines[0] : 'GDELT Event';
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(headline)}</a>`;
    const plainText = getTextFromSource(sources.fundus);
    articleHtml = `<p>${esc(plainText)}</p>`;
  } else {
    const headline = (headlines && headlines[0]) ? headlines[0] : 'GDELT Event';
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(headline)}</a>`;
    articleHtml = '<p style="color: gray;">Article text not yet available for this source.</p>';
  }

  // --- Events list (without tone) ---
  const siblings = snapshot.articleMap.get(sourceUrl) || articleMap.get(sourceUrl) || [];
  let eventsHtml = '';
  siblings.forEach((evt) => {
    const gid  = (evt.globalEventId as string) || '';
    const a1   = (evt.actor1 as string) || '';
    const a2   = (evt.actor2 as string) || '';
    const code = (evt.eventCode as string) || '';
    const gold = (evt.goldstein as number) || 0;
    const ment = (evt.numMentions as number) || 0;
    const isClicked = gid === globalEventId;

    const highlightStyle = isClicked
      ? 'border-left: 2px solid #66aaff; padding-left: 6px;'
      : 'border-left: 2px solid transparent; padding-left: 6px;';

    eventsHtml += `
      <div style="${highlightStyle} margin-bottom: 7px; font-size: 12px;" title="Global Event ID: ${esc(gid)}">
        <strong>${esc(a1)} <span title="${esc(getVerb(code))}">${esc(getRootVerbPast(code))}</span> ${esc(a2)}</strong>
        | goldstein: ${gold.toFixed(1)} | mentions: ${ment}
      </div>`;
  });

  // --- Article‑level tone (average over all events sharing the same sourceUrl) ---
  let totalTone = 0;
  let toneCount = 0;
  for (const evt of siblings) {
    const t = evt.tone;
    if (typeof t === 'number' && !isNaN(t)) {
      totalTone += t;
      toneCount++;
    }
  }
  const articleTone = toneCount > 0 ? totalTone / toneCount : 0;
  const toneColor = getToneColor(articleTone);
  const toneDisplay = formatTone(articleTone);

  const title = sanitize(rawTitle);
  const scrollableContent = `
    ${descriptionHtml}
    ${eventsHtml}
    <hr>
    <div id="infobox-dropdown-placeholder"></div>
    <div class="infobox-article">
      ${articleHtml}
    </div>
  `;
  const footerHtml = `
    <div class="infobox-footer">
      <span class="tone-label">Article tone: </span><span class="tone-value" style="color: ${toneColor};">${toneDisplay}</span>
    </div>
  `;
  return { title, body: scrollableContent, footer: footerHtml };
}

// =============================================================================
// InfoBox class (async render updates)
// =============================================================================
export class InfoBox {
  private container: HTMLDivElement;
  private removeListener: () => void;
  private articleMap: Map<string, Record<string, unknown>[]>;
  private articleSources: ArticleSources;
  private dropdown: HTMLSelectElement;
  private currentSource: 'fundus' | 'gdeltnews' | 'trafilatura' = 'gdeltnews';
  private currentTitle: string = '';
  private currentScrollable: string = '';
  private currentFooter: string = '';
  private currentSnapshot: Snapshot | null = null;

  constructor(
    viewer: Viewer,
    articleMap: Map<string, Record<string, unknown>[]>,
    articleSources: ArticleSources,
  ) {
    this.articleMap = articleMap;
    this.articleSources = articleSources;

    // Inject CSS (once)
    if (!document.getElementById('custom-infobox-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'custom-infobox-styles';
      styleEl.textContent = `
        .infobox-title-link {
          color: white;
          text-decoration: none;
        }
        .infobox-description {
          font-style: italic;
          color: #ccc;
          margin-bottom: 12px;
          border-left: 3px solid #66aaff;
          padding-left: 8px;
        }
        .infobox-body {
          font-family: sans-serif;
        }
        .infobox-uuid {
          font-size: 0.7em;
          color: gray;
          margin-bottom: 0;
        }
        .infobox-article {
          max-height: 50vh;
          overflow-y: auto;
          margin-top: 8px;
          white-space: normal;
        }
        .infobox-source-select {
          width: 100%;
          margin-bottom: 8px;
          padding: 4px;
          background: #222;
          color: white;
          border: 1px solid #555;
          border-radius: 4px;
          font-size: 12px;
        }
        .infobox-scrollable {
          overflow-y: auto;
          flex: 1;
        }
        .infobox-footer {
          display: flex;
          justify-content: flex-start;
          font-size: 12px;
          color: gray;
          padding: 8px 0 0 0;
          border-top: 1px solid #444;
          margin-top: 8px;
          flex-shrink: 0;
        }
        .tone-label {
          font-weight: normal;
          margin-right: 4px;
        }
        .tone-value {
          font-weight: bold;
        }
      `;
      document.head.appendChild(styleEl);
    }

    // Create DOM container
    this.container = document.createElement('div');
    this.container.id = 'custom-infobox';
    this.container.style.cssText = `
      position: absolute;
      top: 44px;
      right: 10px;
      width: 480px;
      max-height: 80vh;
      background: rgba(0, 0, 0, 0.80);
      color: white;
      padding: 12px;
      border-radius: 4px;
      font-size: 13px;
      z-index: 1000;
      display: none;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;
    viewer.container.appendChild(this.container);

    // Build dropdown
    this.dropdown = document.createElement('select');
    this.dropdown.className = 'infobox-source-select';
    this.dropdown.style.display = 'none';
    this.dropdown.addEventListener('change', () => {
      this.currentSource = this.dropdown.value as 'fundus' | 'gdeltnews' | 'trafilatura';
      this.refreshArticle();
    });

    this.removeListener = viewer.selectedEntityChanged.addEventListener(
      (entity: Entity | undefined) => this.onSelectionChanged(entity),
    );
  }

  private async onSelectionChanged(entity: Entity | undefined): Promise<void> {
    if (!entity || !entity.properties) return;

    const p = entity.properties.getValue() || {};
    const snapshot: Snapshot = {
      sourceUrl: (p.sourceUrl as string) || '',
      headlines: (p.headlines as string[]) || [],
      globalEventId: (p.globalEventId as string) || '',
      actor1: (p.actor1 as string) || '',
      actor2: (p.actor2 as string) || '',
      eventCode: (p.eventCode as string) || '',
      goldstein: (p.goldstein as number) || 0,
      numMentions: (p.numMentions as number) || 0,
      tone: (p.tone as number) || 0,
      articleMap: new Map(this.articleMap),
    };
    this.currentSnapshot = snapshot;

    // Select best source using priority + 50% gdeltnews rule
    const sources = this.articleSources.get(snapshot.sourceUrl) || {};
    const best = selectBestSource(sources);
    if (best) {
      this.currentSource = best.source;
    }

    const { title, body, footer } = await renderGdelt(snapshot, this.articleMap, this.articleSources, this.currentSource);
    this.currentTitle = title;
    this.currentScrollable = body;
    this.currentFooter = footer;
    this.show();
  }

  private async refreshArticle(): Promise<void> {
    if (!this.currentSnapshot) return;
    const { title, body, footer } = await renderGdelt(
      this.currentSnapshot,
      this.articleMap,
      this.articleSources,
      this.currentSource,
    );
    this.currentTitle = title;
    this.currentScrollable = body;
    this.currentFooter = footer;
    this.show();
  }

  private show(): void {
    this.container.innerHTML = '';

    // Build dropdown (but don't append yet)
    const url = this.currentSnapshot?.sourceUrl || '';
    const sources = this.articleSources.get(url) || {};
    this.dropdown.innerHTML = '';
    const options: { value: 'fundus' | 'gdeltnews' | 'trafilatura'; label: string }[] = [
      { value: 'fundus', label: 'Fundus' },
      { value: 'gdeltnews', label: 'gdeltnews' },
      { value: 'trafilatura', label: 'Trafilatura' },
    ];
    options.forEach(opt => {
      const optionEl = document.createElement('option');
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      if (!sources[opt.value]) optionEl.disabled = true;
      if (opt.value === this.currentSource) optionEl.selected = true;
      this.dropdown.appendChild(optionEl);
    });
    this.dropdown.style.display = 'block';

    // Create title element
    const titleEl = document.createElement('div');
    titleEl.style.cssText =
      'font-weight: bold; font-size: 18px; margin-bottom: 12px; border-bottom: 1px solid #555; padding-bottom: 6px;';
    titleEl.innerHTML = this.currentTitle;

    // Create scrollable content container
    const scrollableDiv = document.createElement('div');
    scrollableDiv.className = 'infobox-scrollable';
    scrollableDiv.innerHTML = this.currentScrollable;

    // Create footer element
    const footerDiv = document.createElement('div');
    footerDiv.innerHTML = this.currentFooter;

    // Append everything
    this.container.appendChild(titleEl);
    this.container.appendChild(scrollableDiv);
    this.container.appendChild(footerDiv);

    // Insert dropdown into its placeholder
    const placeholder = scrollableDiv.querySelector('#infobox-dropdown-placeholder');
    if (placeholder) {
      placeholder.replaceWith(this.dropdown);
    } else {
      // Fallback
      this.container.appendChild(this.dropdown);
    }

    this.container.style.display = 'flex';
  }

  async updateData(
    articleMap: Map<string, Record<string, unknown>[]>,
    articleSources: ArticleSources,
  ): Promise<void> {
    this.articleMap = articleMap;

    if (this.currentSnapshot) {
      const url = this.currentSnapshot.sourceUrl;
      const oldSources = this.articleSources.get(url) || {};
      const newSources = articleSources.get(url) || {};
      const merged = { ...oldSources, ...newSources };
      const updatedSources = new Map(articleSources);
      updatedSources.set(url, merged);
      this.articleSources = updatedSources;
    } else {
      this.articleSources = articleSources;
    }

    if (this.currentSnapshot) {
      const sources = this.articleSources.get(this.currentSnapshot.sourceUrl) || {};
      const best = selectBestSource(sources);
      if (best) {
        this.currentSource = best.source;
      }
      const { title, body, footer } = await renderGdelt(
        this.currentSnapshot,
        articleMap,
        this.articleSources,
        this.currentSource,
      );
      this.currentTitle = title;
      this.currentScrollable = body;
      this.currentFooter = footer;
      this.show();
    }
  }

  destroy(): void {
    this.removeListener();
    this.container.remove();
  }
}
