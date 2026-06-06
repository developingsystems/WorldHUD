import { Viewer, Entity } from 'cesium';
import DOMPurify, { type Config } from 'dompurify';
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
// Snapshot type – properties captured when an entity is selected
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
  entityId: string;
}

// =============================================================================
// Template: GDELT event – shows all events from the same article
// =============================================================================

type ArticleSources = Map<string, { fundus?: string; stage1?: string; stage2?: string }>;

function renderGdelt(
  snapshot: Snapshot,
  articleMap: Map<string, Record<string, unknown>[]>,
  articleSources: ArticleSources,
  currentSource: 'fundus' | 'stage1' | 'stage2',
): { title: string; body: string } {
  const { sourceUrl, headlines, globalEventId, entityId } = snapshot;

  const headline = headlines[0] || 'GDELT Event';

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const safeUrl = esc(sourceUrl);
  const safeHeadline = esc(headline);

  // Title HTML – clickable headline
  const rawTitle = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${safeHeadline}</a>`;
  const title = sanitize(rawTitle);

  // Body: all events from this article, compact format
  const siblings = articleMap.get(sourceUrl) || [];
  let eventsHtml = '';
  siblings.forEach((evt) => {
    const gid  = (evt.globalEventId as string) || '';
    const a1   = (evt.actor1 as string) || '';
    const a2   = (evt.actor2 as string) || '';
    const code = (evt.eventCode as string) || '';
    const gold = (evt.goldstein as number) || 0;
    const ment = (evt.numMentions as number) || 0;
    const ton  = (evt.tone as number) || 0;
    const isClicked = gid === globalEventId;

    const highlightStyle = isClicked
      ? 'border-left: 2px solid #66aaff; padding-left: 6px;'
      : 'border-left: 2px solid transparent; padding-left: 6px;';

    eventsHtml += `
      <div style="${highlightStyle} margin-bottom: 7px; font-size: 12px;" title="Global Event ID: ${esc(gid)}">
                <strong>${esc(a1)} <span title="${esc(getVerb(code))}">${esc(getRootVerbPast(code))}</span> ${esc(a2)}</strong> | goldstein: ${gold.toFixed(1)} | tone: ${ton.toFixed(2)} | mentions: ${ment}
      </div>`;
  });

  // Full‑text article from the currently selected source
  const sources = articleSources.get(sourceUrl) || {};
  const articleText = sources[currentSource] || sources.stage2 || sources.stage1 || sources.fundus || '';

  const rawBody = `
    <div class="infobox-body">
      ${eventsHtml}
      <hr>
      <div class="infobox-article">
        ${articleText ? `<p>${esc(articleText)}</p>` : '<p style="color: gray;">Article text not yet available for this source.</p>'}
      </div>
      <hr>
      <p class="infobox-uuid">Entity UUID: ${esc(entityId)}</p>
    </div>
  `;

  const body = sanitize(rawBody);
  return { title, body };
}

// =============================================================================
// InfoBox class
// =============================================================================
export class InfoBox {
  private container: HTMLDivElement;
  private removeListener: () => void;
  private articleMap: Map<string, Record<string, unknown>[]>;
  private articleSources: ArticleSources;
  private dropdown: HTMLSelectElement;
  private currentSource: 'fundus' | 'stage1' | 'stage2' = 'stage1';
  private currentTitle: string = '';
  private currentBody: string = '';
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
        .infobox-body {
          font-family: sans-serif;
        }
        .infobox-uuid {
          font-size: 0.7em;
          color: gray;
          margin-bottom: 0;
        }
        .infobox-article {
          max-height: 40vh;
          overflow-y: auto;
          margin-top: 8px;
          white-space: pre-wrap;
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
      max-height: 70vh;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.80);
      color: white;
      padding: 12px;
      border-radius: 4px;
      font-size: 13px;
      z-index: 1000;
      display: none;
    `;
    viewer.container.appendChild(this.container);

    // Build dropdown (visible only when an entity is selected)
    this.dropdown = document.createElement('select');
    this.dropdown.className = 'infobox-source-select';
    this.dropdown.style.display = 'none';
    this.dropdown.addEventListener('change', () => {
      this.currentSource = this.dropdown.value as 'fundus' | 'stage1' | 'stage2';
      this.refreshArticle();
    });

    // Listen for entity selection changes
    this.removeListener = viewer.selectedEntityChanged.addEventListener(
      (entity: Entity | undefined) => this.onSelectionChanged(entity),
    );
  }

  private onSelectionChanged(entity: Entity | undefined): void {
    if (!entity || !entity.properties) {
      this.hide();
      return;
    }

    // Capture a snapshot of the entity's properties now
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
      entityId: entity.id,
    };
    this.currentSnapshot = snapshot;

    // Determine the best available source for this article
    const sources = this.articleSources.get(snapshot.sourceUrl) || {};
    const candidates: { source: 'fundus' | 'stage1' | 'stage2'; text: string }[] = [];
    if (sources.fundus) candidates.push({ source: 'fundus', text: sources.fundus });
    if (sources.stage1) candidates.push({ source: 'stage1', text: sources.stage1 });
    if (sources.stage2) candidates.push({ source: 'stage2', text: sources.stage2 });
    if (candidates.length > 0) {
      this.currentSource = candidates.reduce((best, cur) =>
        cur.text.length > best.text.length ? cur : best
      ).source;
    }

    const { title, body } = renderGdelt(snapshot, this.articleMap, this.articleSources, this.currentSource);
    this.currentTitle = title;
    this.currentBody = body;
    this.show();
  }

  private refreshArticle(): void {
    if (!this.currentSnapshot) return;
    const { title, body } = renderGdelt(
      this.currentSnapshot,
      this.articleMap,
      this.articleSources,
      this.currentSource,
    );
    this.currentTitle = title;
    this.currentBody = body;
    this.show();
  }

  private show(): void {
    this.container.innerHTML = '';

    // Dropdown
    const url = this.currentSnapshot?.sourceUrl || '';
    const sources = this.articleSources.get(url) || {};
    this.dropdown.innerHTML = '';
    const options: { value: 'fundus' | 'stage1' | 'stage2'; label: string }[] = [
      { value: 'fundus', label: 'Fundus' },
      { value: 'stage1', label: 'NGram Stage 1' },
      { value: 'stage2', label: 'NGram Stage 2' },
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
    this.container.appendChild(this.dropdown);

    // Title
    const titleEl = document.createElement('div');
    titleEl.style.cssText =
      'font-weight: bold; font-size: 18px; margin-bottom: 12px; border-bottom: 1px solid #555; padding-bottom: 6px;';
    titleEl.innerHTML = this.currentTitle;

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'infobox-body';
    bodyEl.innerHTML = this.currentBody;

    this.container.appendChild(titleEl);
    this.container.appendChild(bodyEl);
    this.container.style.display = 'block';
  }

  private hide(): void {
    this.container.style.display = 'none';
    this.container.innerHTML = '';
    this.dropdown.style.display = 'none';
    this.currentSnapshot = null;
  }

  /** Replace the underlying data and refresh if a snapshot is open. */
  updateData(
    articleMap: Map<string, Record<string, unknown>[]>,
    articleSources: ArticleSources,
  ) {
    this.articleMap = articleMap;
    this.articleSources = articleSources;
    if (this.currentSnapshot) {
      // Re‑select the best source with the new data
      const sources = articleSources.get(this.currentSnapshot.sourceUrl) || {};
      const candidates: { source: 'fundus' | 'stage1' | 'stage2'; text: string }[] = [];
      if (sources.fundus) candidates.push({ source: 'fundus', text: sources.fundus });
      if (sources.stage1) candidates.push({ source: 'stage1', text: sources.stage1 });
      if (sources.stage2) candidates.push({ source: 'stage2', text: sources.stage2 });
      if (candidates.length > 0) {
        this.currentSource = candidates.reduce((best, cur) =>
          cur.text.length > best.text.length ? cur : best
        ).source;
      }
      const { title, body } = renderGdelt(
        this.currentSnapshot,
        articleMap,
        articleSources,
        this.currentSource,
      );
      this.currentTitle = title;
      this.currentBody = body;
      this.show();
    }
  }

  destroy(): void {
    this.removeListener();
    this.container.remove();
  }
}
