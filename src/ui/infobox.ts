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
// Template: GDELT event – now shows all events from the same article
// =============================================================================
function renderGdelt(
  entity: Entity,
  articleMap: Map<string, Record<string, unknown>[]>,
): { title: string; body: string } {
  const p = entity.properties?.getValue() || {};
  const sourceUrl = (p.sourceUrl as string) || '';
  const headlines = (p.headlines as string[]) || [];
  const headline  = headlines[0] || 'GDELT Event';
  const clickedId = (p.globalEventId as string) || '';

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const safeUrl = esc(sourceUrl);
  const safeHeadline = esc(headline);

  // Title HTML – clickable headline
  const rawTitle = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${safeHeadline}</a>`;
  const title = sanitize(rawTitle);

  // Body: all events from this article, compact format
  const siblings = articleMap.get(sourceUrl) || [p];
  let eventsHtml = '';
  siblings.forEach((evt) => {
    const gid  = (evt.globalEventId as string) || '';
    const a1   = (evt.actor1 as string) || '';
    const a2   = (evt.actor2 as string) || '';
    const code = (evt.eventCode as string) || '';
    const gold = (evt.goldstein as number) || 0;
    const ment = (evt.numMentions as number) || 0;
    const ton  = (evt.tone as number) || 0;
    const isClicked = gid === clickedId;

    const highlightStyle = isClicked
      ? 'border-left: 2px solid #66aaff; padding-left: 6px;'
      : 'border-left: 2px solid transparent; padding-left: 6px;';

    // Dual‑hover: row title shows Global Event ID, verb span shows full CAMEO phrase
    eventsHtml += `
      <div style="${highlightStyle} margin-bottom: 7px; font-size: 12px;" title="Global Event ID: ${esc(gid)}">
                <strong>${esc(a1)} <span title="${esc(getVerb(code))}">${esc(getRootVerbPast(code))}</span> ${esc(a2)}</strong> | goldstein: ${gold.toFixed(1)} | tone: ${ton.toFixed(2)} | mentions: ${ment}
      </div>`;
  });

  const rawBody = `
    <div class="infobox-body">
      ${eventsHtml}
      <hr>
      <p class="infobox-uuid">Entity UUID: ${esc(entity.id)}</p>
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

  constructor(viewer: Viewer, articleMap: Map<string, Record<string, unknown>[]>) {
    this.articleMap = articleMap;

    // Inject CSS for the InfoBox (once)
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
      `;
      document.head.appendChild(styleEl);
    }

    // Create the DOM container for the InfoBox
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
    const { title, body } = renderGdelt(entity, this.articleMap);
    this.show(title, body);
  }

  private show(titleHtml: string, bodyHtml: string): void {
    this.container.innerHTML = '';

    const titleEl = document.createElement('div');
    titleEl.style.cssText =
      'font-weight: bold; font-size: 18px; margin-bottom: 12px; border-bottom: 1px solid #555; padding-bottom: 6px;';
    titleEl.innerHTML = titleHtml;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'infobox-body';
    bodyEl.innerHTML = bodyHtml;

    this.container.appendChild(titleEl);
    this.container.appendChild(bodyEl);
    this.container.style.display = 'block';
  }

  private hide(): void {
    this.container.style.display = 'none';
    this.container.innerHTML = '';
  }

  destroy(): void {
    this.removeListener();
    this.container.remove();
  }
}
