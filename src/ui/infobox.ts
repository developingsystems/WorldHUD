import { Viewer, Entity, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';
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
  'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
] as const;

/** DOMPurify configuration – compatible with v3.x */
const GDELT_DOMPURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [...GDELT_ALLOWED_TAGS],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'title', 'src', 'alt'],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_UNKNOWN_PROTOCOLS: false,
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
  entityId: string;
  articleMap: Map<string, Record<string, unknown>[]>;
}

type ArticleSources = Map<string, { gdeltnews?: unknown; trafilatura?: unknown }>;

// =============================================================================
// Helper: Choose best source based on priority and 50% gdeltnews advantage
// -----------------------------------------------------------------------------
// Priority: Trafilatura > gdeltnews.
// But if gdeltnews text is at least 50% longer than trafilatura, use gdeltnews.
// =============================================================================
function selectBestSource(sources: {
  gdeltnews?: unknown;
  trafilatura?: unknown;
}): { source: 'gdeltnews' | 'trafilatura'; text: string } | null {
  const gdeltnewsText = sources.gdeltnews ? getTextFromSource(sources.gdeltnews) : '';
  const trafilaturaText = sources.trafilatura ? getTextFromSource(sources.trafilatura) : '';

  // Prefer Trafilatura unless gdeltnews is ≥50% longer or Trafilatura is empty
  if (trafilaturaText && (!gdeltnewsText || gdeltnewsText.length < 1.5 * trafilaturaText.length)) {
    return { source: 'trafilatura', text: trafilaturaText };
  } else if (gdeltnewsText) {
    return { source: 'gdeltnews', text: gdeltnewsText };
  }
  return null;
}

// =============================================================================
// Helper: Get tone color with non‑linear mapping and three‑stop gradient
// =============================================================================
function getToneColor(tone: number): string {
  let x = Math.min(100, Math.max(-100, tone));
  const sign = x === 0 ? 0 : Math.sign(x);
  const absX = Math.abs(x);
  const sat = Math.pow(absX / 100, 0.15);
  const normalized = sign > 0 ? 0.5 + sat * 0.5 : 0.5 - sat * 0.5;
  const stops = [
    { pos: 0.0, color: '#FF0000' },
    { pos: 0.5, color: '#808080' },
    { pos: 1.0, color: '#00FF00' }
  ];
  let i = 0;
  while (i < stops.length - 1 && stops[i+1].pos < normalized) i++;
  const s1 = stops[i];
  const s2 = stops[i+1];
  const ratio = (normalized - s1.pos) / (s2.pos - s1.pos);
  return `color-mix(in oklab, ${s1.color} ${(1 - ratio) * 100}%, ${s2.color})`;
}

// =============================================================================
// Format tone number with sign (+ for positive, - for negative)
// =============================================================================
function formatTone(tone: number): string {
  const sign = tone > 0 ? '+' : '';
  return sign + tone.toFixed(2);
}

// =============================================================================
// Web Worker for Markdown parsing (new worker per request)
// =============================================================================
async function renderMarkdown(markdown: string, signal?: AbortSignal): Promise<string> {
  if (!markdown) return '';

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const worker = new Worker(new URL('../workers/markdown-worker.ts', import.meta.url));
  let terminated = false;

  const abortHandler = () => {
    if (!terminated) {
      worker.terminate();
      terminated = true;
    }
  };

  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (!terminated) {
        const { success, html, error } = event.data;
        if (success) {
          resolve(DOMPurify.sanitize(html, GDELT_DOMPURIFY_CONFIG));
        } else {
          reject(new Error(error));
        }
      }
      cleanup();
    };

    const onError = (err: ErrorEvent) => {
      if (!terminated) reject(err);
      cleanup();
    };

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (!terminated) {
        worker.terminate();
        terminated = true;
      }
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(markdown);
  });
}

// =============================================================================
// Render function with rich Trafilatura support (async, accepts signal)
// =============================================================================
async function renderGdelt(
  snapshot: Snapshot,
  articleMap: Map<string, Record<string, unknown>[]>,
  articleSources: ArticleSources,
  currentSource: 'gdeltnews' | 'trafilatura',
  signal?: AbortSignal,
): Promise<{ title: string; body: string; toneHtml: string; hasArticle: boolean }> {
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
    articleHtml = await renderMarkdown(markdownText, signal);
  } else if (currentSource === 'trafilatura' && typeof sources.trafilatura === 'string') {
    // Plain string fallback (if pipeline saved only text)
    const headline = (headlines && headlines[0]) ? headlines[0] : 'GDELT Event';
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(headline)}</a>`;
    articleHtml = await renderMarkdown(sources.trafilatura, signal);
  } else if (currentSource === 'gdeltnews' && sources.gdeltnews) {
    const headline = (headlines && headlines[0]) ? headlines[0] : 'GDELT Event';
    rawTitle = `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${esc(headline)}</a>`;
    const plainText = getTextFromSource(sources.gdeltnews);
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

  // --- Article‑level tone ---
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

  const hasArticle = !(
    articleHtml === '<p style="color: gray;">Article text not yet available for this source.</p>' ||
    articleHtml === ''
  );

  const title = sanitize(rawTitle);
  const toneHtml = `<div class="article-tone" style="color: ${toneColor};">Article tone: ${toneDisplay}</div>`;
  const scrollableContent = `
    ${descriptionHtml}
    ${eventsHtml}
    <hr>
    <div id="infobox-dropdown-placeholder"></div>
    <div class="infobox-article">
      ${articleHtml}
    </div>
  `;
  return { title, body: scrollableContent, toneHtml, hasArticle };
}

// =============================================================================
// InfoBox class (no Fundus, auto‑select once, ignores undefined on chunk reload)
// =============================================================================
export class InfoBox {
  private container: HTMLDivElement;
  private removeListener: () => void;
  private articleMap: Map<string, Record<string, unknown>[]>;
  private articleSources: ArticleSources;
  private dropdown: HTMLSelectElement;
  private currentSource: 'gdeltnews' | 'trafilatura' = 'trafilatura';
  private currentTitle: string = '';
  private currentScrollable: string = '';
  private currentToneHtml: string = '';
  private currentSnapshot: Snapshot | null = null;
  private currentController: AbortController | null = null;
  private articleDisplayed: boolean = false;

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
          margin-top: 8px;
          white-space: normal;
        }
        .infobox-article img {
          max-width: 100%;
          height: auto;
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
        .article-tone {
          font-weight: bold;
          font-size: 12px;
          margin: 8px 0 12px 0;
          padding-bottom: 8px;
          border-left: 3px solid #66aaff;
          border-bottom: 1px solid #444;
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
      width: 570px;
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
      this.currentSource = this.dropdown.value as 'gdeltnews' | 'trafilatura';
      this.refreshArticle();
    });

    // Listen to selection changes – only update on new entity, never close here
    this.removeListener = viewer.selectedEntityChanged.addEventListener(
      (entity: Entity | undefined) => {
        if (entity) {
          this.onSelectionChanged(entity);
        }
        // Ignore undefined – chunk reloads cause it but we don't close.
      }
    );

    // Close InfoBox when clicking on terrain (not on entities)
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(click.position);
      if (!picked || !picked.id || !(picked.id instanceof Entity)) {
        this.hide();
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  private async onSelectionChanged(entity: Entity): Promise<void> {
    // Cancel any ongoing render
    if (this.currentController) {
      this.currentController.abort();
    }
    this.currentController = new AbortController();
    const signal = this.currentController.signal;

    // Clear previous content and ensure container is visible
    this.container.innerHTML = '';
    this.container.style.display = 'flex';

    const p = entity.properties?.getValue() || {};
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
      articleMap: new Map(this.articleMap),
    };
    this.currentSnapshot = snapshot;

    // Reset flag for this new entity – no article displayed yet
    this.articleDisplayed = false;

    // Attempt to select the best available source now (if any)
    const sources = this.articleSources.get(snapshot.sourceUrl) || {};
    const best = selectBestSource(sources);
    if (best) {
      this.currentSource = best.source;
    }

    try {
      const { title, body, toneHtml, hasArticle } = await renderGdelt(
        snapshot,
        this.articleMap,
        this.articleSources,
        this.currentSource,
        signal,
      );
      if (signal.aborted) return;
      this.currentTitle = title;
      this.currentScrollable = body;
      this.currentToneHtml = toneHtml;
      this.articleDisplayed = hasArticle;
      this.show();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.error('Render error:', err);
      this.container.innerHTML = '<div class="infobox-loading">Failed to load article.</div>';
    } finally {
      if (this.currentController === this.currentController) this.currentController = null;
    }
  }

  private async refreshArticle(): Promise<void> {
    if (!this.currentSnapshot) return;
    if (this.currentController) {
      this.currentController.abort();
    }
    this.currentController = new AbortController();
    const signal = this.currentController.signal;

    // Save current scroll position
    const scrollable = this.container.querySelector('.infobox-scrollable');
    const savedScrollTop = scrollable ? scrollable.scrollTop : 0;

    try {
      const { title, body, toneHtml, hasArticle } = await renderGdelt(
        this.currentSnapshot,
        this.articleMap,
        this.articleSources,
        this.currentSource,
        signal,
      );
      if (signal.aborted) return;
      this.currentTitle = title;
      this.currentScrollable = body;
      this.currentToneHtml = toneHtml;
      this.articleDisplayed = hasArticle;
      this.show();
      if (savedScrollTop > 0) {
        requestAnimationFrame(() => {
          const newScrollable = this.container.querySelector('.infobox-scrollable');
          if (newScrollable) newScrollable.scrollTop = savedScrollTop;
        });
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.error('Refresh error:', err);
    } finally {
      if (this.currentController === this.currentController) this.currentController = null;
    }
  }

  private show(): void {
    this.container.innerHTML = '';

    const url = this.currentSnapshot?.sourceUrl || '';
    const sources = this.articleSources.get(url) || {};
    this.dropdown.innerHTML = '';
    const options: { value: 'gdeltnews' | 'trafilatura'; label: string }[] = [
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

    const titleEl = document.createElement('div');
    titleEl.style.cssText =
      'font-weight: bold; font-size: 18px; margin-bottom: 12px; border-bottom: 1px solid #555; padding-bottom: 6px;';
    titleEl.innerHTML = this.currentTitle;

    const toneEl = document.createElement('div');
    toneEl.innerHTML = this.currentToneHtml;

    const scrollableDiv = document.createElement('div');
    scrollableDiv.className = 'infobox-scrollable';
    scrollableDiv.innerHTML = this.currentScrollable;

    this.container.appendChild(titleEl);
    this.container.appendChild(toneEl);
    this.container.appendChild(scrollableDiv);

    const placeholder = scrollableDiv.querySelector('#infobox-dropdown-placeholder');
    if (placeholder) {
      placeholder.replaceWith(this.dropdown);
    } else {
      this.container.appendChild(this.dropdown);
    }

    this.container.style.display = 'flex';
  }

  private hide(): void {
    if (this.currentController) {
      this.currentController.abort();
      this.currentController = null;
    }
    this.container.style.display = 'none';
  }

  async updateData(
    articleMap: Map<string, Record<string, unknown>[]>,
    articleSources: ArticleSources,
  ): Promise<void> {
    console.log('updateData called');
    this.articleMap = articleMap;

    // Merge new sources for the currently open snapshot (if any)
    if (this.currentSnapshot) {
      const url = this.currentSnapshot.sourceUrl;
      const oldSources = this.articleSources.get(url) || {};
      const newSources = articleSources.get(url) || {};
      const merged = { ...oldSources, ...newSources };
      const updatedSources = new Map(articleSources);
      updatedSources.set(url, merged);
      this.articleSources = updatedSources;
      console.log('Merged sources for', url, merged);
    } else {
      this.articleSources = articleSources;
    }

    // Update dropdown options: enable/disable based on availability
    if (this.currentSnapshot) {
      const url = this.currentSnapshot.sourceUrl;
      const sources = this.articleSources.get(url) || {};
      const options = this.dropdown.options;
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const source = opt.value as 'gdeltnews' | 'trafilatura';
        opt.disabled = !sources[source];
      }

      // Auto‑select the best source if we haven't displayed an article yet
      if (!this.articleDisplayed) {
        console.log('No article displayed yet, attempting auto-select');
        const best = selectBestSource(sources);
        console.log('Best source:', best);
        if (best && best.source !== this.currentSource) {
          console.log('Auto-selecting source:', best.source);
          this.currentSource = best.source;
          // Cancel any ongoing render
          if (this.currentController) {
            this.currentController.abort();
          }
          this.currentController = new AbortController();
          const signal = this.currentController.signal;
          try {
            const { title, body, toneHtml, hasArticle } = await renderGdelt(
              this.currentSnapshot,
              articleMap,
              this.articleSources,
              this.currentSource,
              signal,
            );
            if (signal.aborted) return;
            this.currentTitle = title;
            this.currentScrollable = body;
            this.currentToneHtml = toneHtml;
            this.articleDisplayed = hasArticle;
            console.log('Auto-render done, hasArticle =', hasArticle);
            this.show();
          } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            console.error('Auto‑update render error:', err);
          } finally {
            if (this.currentController === this.currentController) this.currentController = null;
          }
        } else {
          console.log('No better source available, or already best');
        }
      } else {
        console.log('Article already displayed, not auto-selecting');
      }
    }
  }

  destroy(): void {
    if (this.currentController) {
      this.currentController.abort();
      this.currentController = null;
    }
    this.removeListener();
    this.container.remove();
  }
}
