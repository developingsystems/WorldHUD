import { Viewer, Entity } from 'cesium';
import DOMPurify from 'dompurify';

// =============================================================================
// Feature detection: Sanitizer API (Firefox 148+, Chrome 146+)
// =============================================================================
function hasNativeSanitizer(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Sanitizer' in window &&
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

/** DOMPurify configuration – exactly as previously designed */
const GDELT_DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: [...GDELT_ALLOWED_TAGS],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  ALLOWED_URI_REGEXP: /^https?:\/\//,
  ALLOW_UNKNOWN_PROTOCOLS: true,
  ADD_ATTR: ['target'],
  KEEP_CONTENT: true,
  USE_PROFILES: { html: true },
} as const;

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
    return temp.innerHTML;
  }
  // Fall back to DOMPurify
  return DOMPurify.sanitize(html, GDELT_DOMPURIFY_CONFIG);
}

// =============================================================================
// Template: GDELT event
// =============================================================================
function renderGdelt(entity: Entity): { title: string; body: string } {
  const p = entity.properties?.getValue() || {};

  const sourceUrl     = (p.sourceUrl     as string)   || '';
  const headlines     = (p.headlines     as string[]) || [];
  const headline      = headlines[0] || 'GDELT Event';
  const globalEventId = (p.globalEventId as string)  || '';
  const actor1        = (p.actor1        as string)   || '';
  const actor2        = (p.actor2        as string)   || '';
  const eventCode     = (p.eventCode     as string)   || '';
  const goldstein     = (p.goldstein     as number)   || 0;
  const numMentions   = (p.numMentions   as number)   || 0;
  const tone          = (p.tone          as number)   || 0;
  const entityId      = entity.id;

  // Escape values that go into attribute quotes (except inside <a> text, where we want literal)
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const safeUrl = esc(sourceUrl);
  const safeHeadline = esc(headline);

  // Title HTML – clickable headline with CSS class
  const rawTitle = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="infobox-title-link">${safeHeadline}</a>`;
  const title = sanitize(rawTitle);

  // Body HTML – no inline styles; styling applied in show()
  const extraHeadlines = headlines.length > 1
    ? `<p><strong>All Headlines (${headlines.length}):</strong></p><ul>${headlines.map(h => `<li>${esc(h)}</li>`).join('')}</ul>`
    : '';

  const rawBody = `
    <p><strong>Source:</strong> <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a></p>
    <hr>
    <p><strong>Actors:</strong> ${esc(actor1)} vs ${esc(actor2)}</p>
    <p><strong>Event Code:</strong> ${esc(eventCode)}</p>
    <p><strong>Goldstein Score:</strong> ${goldstein.toFixed(2)}</p>
    <p><strong>Mentions:</strong> ${numMentions}</p>
    <p><strong>Tone:</strong> ${tone.toFixed(2)}</p>
    <p><strong>Global Event ID:</strong> ${esc(globalEventId)}</p>
    ${extraHeadlines}
    <hr>
    <p class="infobox-uuid">Entity UUID: ${esc(entityId)}</p>
  `;

  const body = sanitize(rawBody);
  return { title, body };
}

// =============================================================================
// InfoBox class
// =============================================================================
export class InfoBox {
  private container: HTMLDivElement;
  private viewer: Viewer;
  private removeListener: () => void;

  constructor(viewer: Viewer) {
    this.viewer = viewer;

    // Inject CSS for the InfoBox (once, if not already present)
    if (!document.getElementById('custom-infobox-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'custom-infobox-styles';
      styleEl.textContent = `
        .infobox-title-link {
          color: white;
          text-decoration: underline;
        }
        .infobox-body {
          font-family: sans-serif;
          max-width: 300px;
        }
        .infobox-uuid {
          font-size: 0.7em;
          color: gray;
        }
      `;
      document.head.appendChild(styleEl);
    }

    // Create the DOM container for the InfoBox
    this.container = document.createElement('div');
    this.container.id = 'custom-infobox';
    this.container.style.cssText = `
      position: absolute;
      top: 10px;
      right: 10px;
      width: 340px;
      max-height: 80vh;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.85);
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
    const { title, body } = renderGdelt(entity);
    this.show(title, body);
  }

  private show(titleHtml: string, bodyHtml: string): void {
    // Clear the container
    this.container.innerHTML = '';

    // Title element – safe to use innerHTML because titleHtml is sanitized
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight: bold; font-size: 14px; margin-bottom: 8px; border-bottom: 1px solid #555; padding-bottom: 6px;';
    titleEl.innerHTML = titleHtml;

    // Body element – safe because bodyHtml is sanitized
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
