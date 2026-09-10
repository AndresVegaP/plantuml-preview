/**
 * The diagram viewport: zoom, pan and fit.
 *
 * Diagrams are frequently much wider than the editor pane, so a preview that
 * only scrolls is close to unusable. This gives the panning and zooming people
 * expect from an image viewer — Ctrl+wheel to zoom about the pointer, drag to
 * pan, keyboard equivalents for everyone who does not use a mouse — while
 * keeping the DOM to a single transformed element so it stays smooth on large
 * diagrams.
 */

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

export interface ViewerOptions {
  readonly zoomStep: number;
  readonly onZoomChanged: (zoom: number) => void;
  /**
   * Called on a double-click. Receives the element under the pointer so the
   * caller can look up the source line PlantUML stamped on it.
   */
  readonly onActivateSource: (target: Element | undefined) => void;
}

export class Viewer {
  private zoom = 1;
  private offsetX = 0;
  private offsetY = 0;
  private panPointerId: number | undefined;
  private panStartX = 0;
  private panStartY = 0;
  private options: ViewerOptions;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly canvas: HTMLElement,
    options: ViewerOptions,
  ) {
    this.options = options;
    this.attach();
  }

  configure(options: Partial<ViewerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  get currentZoom(): number {
    return this.zoom;
  }

  /** Replaces the displayed diagram and fits it to the viewport. */
  setContent(node: Node): void {
    this.canvas.replaceChildren(node);
    this.fitToWidth();
  }

  clear(): void {
    this.canvas.replaceChildren();
  }

  zoomIn(): void {
    this.setZoomAbout(this.zoom * this.options.zoomStep, this.centre());
  }

  zoomOut(): void {
    this.setZoomAbout(this.zoom / this.options.zoomStep, this.centre());
  }

  resetZoom(): void {
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.apply();
  }

  /**
   * Scales the diagram so it fits the viewport, never enlarging past 100%.
   *
   * Growing a small diagram to fill the pane would be surprising: PlantUML
   * output is designed at a specific size, and blowing it up just makes the
   * strokes coarse.
   */
  fitToWidth(): void {
    const svg = this.canvas.firstElementChild;
    if (!(svg instanceof SVGElement)) {
      return;
    }

    const natural = naturalSize(svg);
    if (natural === undefined) {
      return;
    }

    const availableWidth = Math.max(1, this.viewport.clientWidth - 32);
    const availableHeight = Math.max(1, this.viewport.clientHeight - 32);
    const scale = Math.min(availableWidth / natural.width, availableHeight / natural.height, 1);

    this.zoom = clamp(scale, MIN_ZOOM, MAX_ZOOM);

    // Centre a diagram that does not fill the pane. Left-aligning a small
    // diagram in a wide editor group looks like a layout bug rather than a
    // choice, and centring costs nothing once the scale is known.
    this.offsetX = Math.max(0, (availableWidth - natural.width * this.zoom) / 2);
    this.offsetY = Math.max(0, (availableHeight - natural.height * this.zoom) / 2);
    this.apply();
  }

  private attach(): void {
    // Ctrl/Cmd + wheel zooms about the pointer; a plain wheel scrolls, which is
    // what the surrounding scroll container already does.
    this.viewport.addEventListener(
      'wheel',
      (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) {
          return;
        }
        event.preventDefault();
        const factor = Math.pow(this.options.zoomStep, -Math.sign(event.deltaY));
        this.setZoomAbout(this.zoom * factor, { x: event.clientX, y: event.clientY });
      },
      { passive: false },
    );

    this.viewport.addEventListener('pointerdown', (event: PointerEvent) => {
      // Only a primary, non-modified drag pans; everything else belongs to text
      // selection and link activation.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.target instanceof Element && event.target.closest('a') !== null) {
        return;
      }
      this.panPointerId = event.pointerId;
      this.panStartX = event.clientX - this.offsetX;
      this.panStartY = event.clientY - this.offsetY;
      this.viewport.setPointerCapture(event.pointerId);
      this.viewport.classList.add('viewport--panning');
    });

    this.viewport.addEventListener('pointermove', (event: PointerEvent) => {
      if (this.panPointerId !== event.pointerId) {
        return;
      }
      this.offsetX = event.clientX - this.panStartX;
      this.offsetY = event.clientY - this.panStartY;
      this.apply();
    });

    const endPan = (event: PointerEvent): void => {
      if (this.panPointerId !== event.pointerId) {
        return;
      }
      this.panPointerId = undefined;
      this.viewport.classList.remove('viewport--panning');
      if (this.viewport.hasPointerCapture(event.pointerId)) {
        this.viewport.releasePointerCapture(event.pointerId);
      }
    };
    this.viewport.addEventListener('pointerup', endPan);
    this.viewport.addEventListener('pointercancel', endPan);

    this.viewport.addEventListener('dblclick', (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) {
        return;
      }
      this.options.onActivateSource(event.target instanceof Element ? event.target : undefined);
    });

    this.viewport.addEventListener('keydown', (event: KeyboardEvent) => {
      const step = event.shiftKey ? 120 : 40;
      switch (event.key) {
        case '+':
        case '=':
          this.zoomIn();
          break;
        case '-':
        case '_':
          this.zoomOut();
          break;
        case '0':
          if (event.ctrlKey || event.metaKey) {
            this.resetZoom();
          } else {
            return;
          }
          break;
        case 'ArrowLeft':
          this.offsetX += step;
          this.apply();
          break;
        case 'ArrowRight':
          this.offsetX -= step;
          this.apply();
          break;
        case 'ArrowUp':
          this.offsetY += step;
          this.apply();
          break;
        case 'ArrowDown':
          this.offsetY -= step;
          this.apply();
          break;
        default:
          return;
      }
      event.preventDefault();
    });

    // Refit only while the diagram is still at its fitted scale, so a manual
    // zoom is not undone by resizing the pane.
    let fitted = true;
    const observer = new ResizeObserver(() => {
      if (fitted) {
        this.fitToWidth();
      }
    });
    observer.observe(this.viewport);
    this.viewport.addEventListener('pointerdown', () => {
      fitted = false;
    });
    this.viewport.addEventListener('plantuml-refit', () => {
      fitted = true;
    });
  }

  private centre(): { x: number; y: number } {
    const rect = this.viewport.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** Zooms while keeping the point under `anchor` visually stationary. */
  private setZoomAbout(target: number, anchor: { x: number; y: number }): void {
    const next = clamp(target, MIN_ZOOM, MAX_ZOOM);
    if (next === this.zoom) {
      return;
    }
    const rect = this.viewport.getBoundingClientRect();
    const anchorX = anchor.x - rect.left;
    const anchorY = anchor.y - rect.top;
    const ratio = next / this.zoom;

    this.offsetX = anchorX - (anchorX - this.offsetX) * ratio;
    this.offsetY = anchorY - (anchorY - this.offsetY) * ratio;
    this.zoom = next;
    this.apply();
  }

  private apply(): void {
    this.canvas.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.zoom})`;
    this.options.onZoomChanged(this.zoom);
  }
}

/**
 * Works out an SVG's intrinsic size.
 *
 * PlantUML emits `width`/`height` in points and a `viewBox`; the viewBox is the
 * reliable source because the attributes may carry units.
 */
function naturalSize(svg: SVGElement): { width: number; height: number } | undefined {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox !== null) {
    const parts = viewBox.trim().split(/[\s,]+/u).map(Number);
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      const width = parts[2] ?? 0;
      const height = parts[3] ?? 0;
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
  }

  const width = parseLength(svg.getAttribute('width'));
  const height = parseLength(svg.getAttribute('height'));
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function parseLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const match = /^([\d.]+)/u.exec(value.trim());
  const parsed = match === null ? Number.NaN : Number.parseFloat(match[1] ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
