/**
 * canvas-manager.js
 * Handles drawing, zoom/pan, gesture state machine, and undo/redo
 * for one or more canvas views.
 *
 * Gesture state machine:
 *   IDLE      → 1st pointer down (buffered 80ms) → DRAWING
 *   IDLE      → 2nd pointer arrives within 80ms   → ZOOMING
 *   DRAWING   → 2nd pointer down                  → cancel stroke, ZOOMING
 *   ZOOMING   → 1 pointer lifted                  → ZOOMING (stay)
 *   ZOOMING   → all pointers lifted                → IDLE
 *   DRAWING   → pointer lifted                    → commit stroke, IDLE
 */

const GESTURE = { IDLE: 'idle', DRAWING: 'drawing', ZOOMING: 'zooming' };
const DRAW_BUFFER_MS = 80;
const MAX_UNDO = 50;

class CanvasView {
  /**
   * @param {HTMLCanvasElement} displayCanvas  — visible to user
   * @param {Object} silhouetteDef  — from SILHOUETTES[view]
   * @param {string} viewName       — 'front'|'back'|'headNeck'
   */
  constructor(displayCanvas, silhouetteDef, viewName) {
    this.canvas   = displayCanvas;
    this.ctx      = displayCanvas.getContext('2d');
    this.silDef   = silhouetteDef;
    this.viewName = viewName;

    // Transform state
    this.scale    = 1;       // zoom level (1 = fit to canvas)
    this.panX     = 0;
    this.panY     = 0;
    this.baseScale  = 1;     // the "fit" scale (set by layout)
    this.offsetX    = 0;     // silhouette offset within canvas (fit mode)
    this.offsetY    = 0;

    // Stroke history
    this.undoStack = [];  // committed strokes
    this.redoStack = [];

    // Gesture
    this.gestureState  = GESTURE.IDLE;
    this.activePointers = new Map();  // pointerId → {x,y}
    this._bufferTimer   = null;
    this._pendingStroke = null;       // stroke being buffered

    // Current stroke being drawn (not yet committed)
    this._currentStroke = null;

    // Pinch reference
    this._pinchRef = null;  // { midX, midY, dist, panX, panY, scale }

    // Bind all pointer handlers
    this._onPointerDown   = this._onPointerDown.bind(this);
    this._onPointerMove   = this._onPointerMove.bind(this);
    this._onPointerUp     = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);

    this.canvas.addEventListener('pointerdown',   this._onPointerDown);
    this.canvas.addEventListener('pointermove',   this._onPointerMove);
    this.canvas.addEventListener('pointerup',     this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.style.touchAction = 'none';
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown',   this._onPointerDown);
    this.canvas.removeEventListener('pointermove',   this._onPointerMove);
    this.canvas.removeEventListener('pointerup',     this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
  }

  // ─── Layout ──────────────────────────────────────────────────

  /**
   * Called after the canvas CSS / physical size is set.
   * Computes baseScale and offset to fit the silhouette centred.
   */
  layout(cssWidth, cssHeight, dpr) {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const scaleX = (cssWidth  * dpr) / svgW;
    const scaleY = (cssHeight * dpr) / svgH;
    this.baseScale = Math.min(scaleX, scaleY) * 0.85;
    this.offsetX = ((cssWidth  * dpr) - svgW * this.baseScale) / 2;
    this.offsetY = ((cssHeight * dpr) - svgH * this.baseScale) / 2;
    this.dpr = dpr;
    this.cssWidth  = cssWidth;
    this.cssHeight = cssHeight;
    // Reset zoom to 1 on layout change
    this.scale = 1;
    this.panX  = 0;
    this.panY  = 0;
  }

  /** Returns dimensions needed for the region-map builder */
  getDimensions() {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    return {
      width:   this.canvas.width,
      height:  this.canvas.height,
      scale:   this.baseScale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      svgW, svgH,
    };
  }

  // ─── Drawing API ─────────────────────────────────────────────

  get brushSize()  { return window.appState ? window.appState.brushSize  : 20; }
  get toolMode()   { return window.appState ? window.appState.toolMode   : 'draw'; }

  redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._drawSilhouette();
    this._applyTransform(() => {
      for (const stroke of this.undoStack) {
        this._renderStroke(stroke);
      }
    });
    this._drawRegionBoundaries();
  }

  _applyTransform(fn) {
    this.ctx.save();
    this.ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
    this.ctx.scale(this.scale, this.scale);
    fn();
    this.ctx.restore();
  }

  _drawSilhouette() {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);

    // Body fill
    ctx.fillStyle   = '#E0E0E0';
    ctx.strokeStyle = '#999999';
    ctx.lineWidth   = 1.5;
    const outline = new Path2D(this.silDef.outline);
    ctx.fill(outline);
    ctx.stroke(outline);

    // Facial details (headNeck view only)
    if (this.silDef.details) {
      ctx.strokeStyle = '#AAAAAA';
      ctx.lineWidth   = 1;
      const details = new Path2D(this.silDef.details);
      ctx.stroke(details);
    }

    ctx.restore();
  }

  _drawRegionBoundaries() {
    if (!this.silDef.regionBoundaries?.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);

    ctx.strokeStyle = '#CCCCCC';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    for (const boundary of this.silDef.regionBoundaries) {
      const p = new Path2D(boundary.d);
      ctx.stroke(p);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  _renderStroke(stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);

    if (stroke.mode === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.45)';
    }
    ctx.lineWidth   = stroke.brushSize;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    ctx.beginPath();
    const pts = stroke.points;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) {
      ctx.arc(pts[0].x, pts[0].y, stroke.brushSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.mode === 'erase' ? 'rgba(0,0,0,1)' : 'rgba(255,0,0,0.45)';
      ctx.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // ─── Coordinate Mapping ──────────────────────────────────────

  /** Convert canvas CSS pixel → SVG coordinate space */
  _canvasToSvg(cx, cy) {
    const dpr = this.dpr || window.devicePixelRatio || 1;
    // Physical pixel
    const px = cx * dpr;
    const py = cy * dpr;
    // Undo zoom+pan
    const ux = (px - this.panX * dpr) / this.scale;
    const uy = (py - this.panY * dpr) / this.scale;
    // Undo silhouette offset + baseScale
    const sx = (ux - this.offsetX) / this.baseScale;
    const sy = (uy - this.offsetY) / this.baseScale;
    return { x: sx, y: sy };
  }

  _getPointerXY(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ─── Gesture State Machine ───────────────────────────────────

  _onPointerDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    // Palm rejection: ignore very large contacts if touch
    if (e.pointerType === 'touch' && e.width > 60 && e.height > 60) return;

    const pos = this._getPointerXY(e);
    this.activePointers.set(e.pointerId, pos);

    if (this.activePointers.size === 1) {
      // First finger — start 80ms buffer before committing to draw
      this._cancelBuffer();
      this._pendingStroke = { pointerId: e.pointerId, startPos: pos };
      this._bufferTimer = setTimeout(() => {
        if (this.gestureState === GESTURE.IDLE && this.activePointers.size === 1) {
          this.gestureState = GESTURE.DRAWING;
          this._startStroke(pos);
        }
        this._bufferTimer = null;
        this._pendingStroke = null;
      }, DRAW_BUFFER_MS);

    } else if (this.activePointers.size === 2) {
      // Second finger — cancel any pending draw buffer and switch to zoom
      this._cancelBuffer();
      if (this.gestureState === GESTURE.DRAWING) {
        // Abort the current stroke
        this._currentStroke = null;
        this.redraw();
      }
      this.gestureState = GESTURE.ZOOMING;
      this._initPinch();
    }
  }

  _onPointerMove(e) {
    e.preventDefault();
    if (!this.activePointers.has(e.pointerId)) return;
    const pos = this._getPointerXY(e);
    this.activePointers.set(e.pointerId, pos);

    if (this.gestureState === GESTURE.DRAWING) {
      this._continueStroke(pos);
    } else if (this.gestureState === GESTURE.ZOOMING && this.activePointers.size === 2) {
      this._updatePinch();
    }
  }

  _onPointerUp(e) {
    e.preventDefault();
    this.activePointers.delete(e.pointerId);

    if (this.gestureState === GESTURE.DRAWING) {
      this._commitStroke();
      this.gestureState = GESTURE.IDLE;
    } else if (this.gestureState === GESTURE.ZOOMING) {
      if (this.activePointers.size < 2) {
        // Keep in ZOOMING until all fingers lift
        if (this.activePointers.size === 0) {
          this.gestureState = GESTURE.IDLE;
          this._pinchRef = null;
        } else {
          // One finger still down — re-init for potential single-finger pan
          this._pinchRef = null;
        }
      }
    } else if (this._bufferTimer !== null) {
      // Lifted during buffer window — treat as a tap
      this._cancelBuffer();
      // Commit a single-point stroke
      const pos = this._getPointerXY(e);
      this._startStroke(pos);
      this._commitStroke();
    }

    if (this.activePointers.size === 0) {
      this._cancelBuffer();
    }
  }

  _onPointerCancel(e) {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) {
      this._cancelBuffer();
      this._currentStroke = null;
      this.gestureState = GESTURE.IDLE;
      this.redraw();
    }
  }

  _cancelBuffer() {
    if (this._bufferTimer !== null) {
      clearTimeout(this._bufferTimer);
      this._bufferTimer = null;
    }
    this._pendingStroke = null;
  }

  // ─── Stroke Operations ───────────────────────────────────────

  _startStroke(cssPos) {
    const svgPos = this._canvasToSvg(cssPos.x, cssPos.y);
    const brushSvg = this.brushSize / this.baseScale;
    this._currentStroke = {
      points:    [{ x: svgPos.x, y: svgPos.y, t: Date.now() }],
      brushSize: brushSvg,
      mode:      this.toolMode,
    };
  }

  _continueStroke(cssPos) {
    if (!this._currentStroke) return;
    const svgPos = this._canvasToSvg(cssPos.x, cssPos.y);
    this._currentStroke.points.push({ x: svgPos.x, y: svgPos.y, t: Date.now() });

    // Incremental render for 60fps feel
    requestAnimationFrame(() => {
      if (!this._currentStroke) return;
      this.redraw();
      this._renderStroke(this._currentStroke);
    });
  }

  _commitStroke() {
    if (!this._currentStroke) return;
    if (this._currentStroke.points.length > 0) {
      this.undoStack.push(this._currentStroke);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = []; // clear redo on new stroke
      window.dispatchEvent(new CustomEvent('stroke-committed', { detail: { view: this.viewName } }));
    }
    this._currentStroke = null;
    this.redraw();
  }

  // ─── Undo / Redo ─────────────────────────────────────────────

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.undoStack.pop());
    this.redraw();
    window.dispatchEvent(new CustomEvent('stroke-committed', { detail: { view: this.viewName } }));
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.redoStack.pop());
    this.redraw();
    window.dispatchEvent(new CustomEvent('stroke-committed', { detail: { view: this.viewName } }));
    return true;
  }

  clearAll() {
    this.undoStack = [];
    this.redoStack = [];
    this._currentStroke = null;
    this.redraw();
    window.dispatchEvent(new CustomEvent('stroke-committed', { detail: { view: this.viewName } }));
  }

  hasStrokes() {
    return this.undoStack.length > 0;
  }

  // ─── Zoom / Pan ───────────────────────────────────────────────

  _initPinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    this._pinchRef = {
      midX, midY, dist,
      startScale: this.scale,
      startPanX:  this.panX,
      startPanY:  this.panY,
    };
  }

  _updatePinch() {
    if (!this._pinchRef) { this._initPinch(); return; }
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);

    const { startScale, startPanX, startPanY, midX: refMidX, midY: refMidY, dist: refDist } = this._pinchRef;

    const newScale = Math.min(8, Math.max(1, startScale * (dist / refDist)));

    // Pan: midpoint of fingers should map to the same world point
    const dMidX = midX - refMidX;
    const dMidY = midY - refMidY;

    // Zoom around the starting midpoint
    const pivotX = refMidX;
    const pivotY = refMidY;
    const scaleFactor = newScale / startScale;
    const newPanX = pivotX - scaleFactor * (pivotX - startPanX) + dMidX;
    const newPanY = pivotY - scaleFactor * (pivotY - startPanY) + dMidY;

    this.scale = newScale;
    this.panX  = this._clampPan('x', newPanX);
    this.panY  = this._clampPan('y', newPanY);

    requestAnimationFrame(() => this.redraw());
  }

  _clampPan(axis, val) {
    // Allow panning only within silhouette bounds + some padding
    const dpr      = this.dpr || 1;
    const viewW    = this.cssWidth;
    const viewH    = this.cssHeight;
    const scaledW  = viewW  * this.scale;
    const scaledH  = viewH  * this.scale;
    const padding  = 50;

    if (axis === 'x') {
      const minPan = viewW - scaledW - padding;
      const maxPan = padding;
      return Math.min(maxPan, Math.max(minPan, val));
    } else {
      const minPan = viewH - scaledH - padding;
      const maxPan = padding;
      return Math.min(maxPan, Math.max(minPan, val));
    }
  }

  resetZoom() {
    this.scale = 1;
    this.panX  = 0;
    this.panY  = 0;
    this.redraw();
  }

  // ─── Compositing for Export ───────────────────────────────────

  /**
   * Returns a canvas with silhouette + all strokes rendered (no zoom/pan applied).
   */
  getExportCanvas() {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const exportScale = 2;
    const w = Math.round(svgW * this.baseScale * exportScale);
    const h = Math.round(svgH * this.baseScale * exportScale);

    const offscreen = document.createElement('canvas');
    offscreen.width  = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d');

    // Temporarily redirect renders to this offscreen canvas
    const savedCtx   = this.ctx;
    const savedScale = this.scale;
    const savedPanX  = this.panX;
    const savedPanY  = this.panY;
    const savedDpr   = this.dpr;

    this.ctx   = ctx;
    this.scale = exportScale;
    this.panX  = 0;
    this.panY  = 0;
    this.dpr   = 1;

    this.redraw();

    this.ctx   = savedCtx;
    this.scale = savedScale;
    this.panX  = savedPanX;
    this.panY  = savedPanY;
    this.dpr   = savedDpr;

    return offscreen;
  }

  /**
   * Returns a canvas containing ONLY user strokes on a transparent background.
   * Used for BSA pixel counting — no silhouette fill, no region boundaries.
   * Coordinates match the region-map canvas exactly (scale=1, no zoom/pan).
   */
  getDrawOnlyCanvas() {
    const offscreen = document.createElement('canvas');
    offscreen.width  = this.canvas.width;
    offscreen.height = this.canvas.height;
    const ctx = offscreen.getContext('2d');
    // Transparent background — only strokes get alpha > 0

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);

    for (const stroke of this.undoStack) {
      if (!stroke.points || stroke.points.length === 0) continue;
      ctx.save();
      if (stroke.mode === 'erase') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.fillStyle   = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(255,0,0,1)';  // fully opaque for counting
        ctx.fillStyle   = 'rgba(255,0,0,1)';
      }
      ctx.lineWidth = stroke.brushSize;
      ctx.lineCap   = 'round';
      ctx.lineJoin  = 'round';

      const pts = stroke.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, stroke.brushSize / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
    ctx.restore();
    return offscreen;
  }

  /** Normalised stroke data for CSV export */
  getStrokeData(viewName) {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const rows = [];
    this.undoStack.forEach((stroke, strokeIdx) => {
      stroke.points.forEach((pt, ptIdx) => {
        rows.push({
          view:        viewName,
          stroke_id:   strokeIdx,
          point_index: ptIdx,
          x:           +(pt.x / svgW).toFixed(6),
          y:           +(pt.y / svgH).toFixed(6),
          timestamp:   pt.t || 0,
          brush_size:  +stroke.brushSize.toFixed(4),
          mode:        stroke.mode,
        });
      });
    });
    return rows;
  }

  /** Compute dynamic minimum brush size based on silhouette area */
  computeMinBrushRadius(totalSilPixels) {
    // min brush covers ~1% of body BSA
    const area   = totalSilPixels * 0.01;
    const radius = Math.sqrt(area / Math.PI);
    // Convert from physical pixels back to SVG coords
    return radius / this.baseScale;
  }
}


/**
 * CanvasManager — owns all three CanvasView instances and provides
 * a unified API for the app layer.
 */
class CanvasManager {
  constructor() {
    this.views = {};   // { front, back, headNeck }
    this.activeView = 'front';
  }

  /**
   * @param {string} viewName
   * @param {HTMLCanvasElement} canvas
   * @param {Object} silDef  from SILHOUETTES
   */
  registerView(viewName, canvas, silDef) {
    this.views[viewName] = new CanvasView(canvas, silDef, viewName);
  }

  /**
   * Call after canvas CSS sizes are set and devicePixelRatio known.
   */
  layoutAll(cssWidth, cssHeight, dpr) {
    for (const [name, view] of Object.entries(this.views)) {
      view.canvas.width  = Math.round(cssWidth  * dpr);
      view.canvas.height = Math.round(cssHeight * dpr);
      view.canvas.style.width  = cssWidth  + 'px';
      view.canvas.style.height = cssHeight + 'px';
      view.layout(cssWidth, cssHeight, dpr);
    }
  }

  setActiveView(viewName) {
    if (this.views[viewName]) this.activeView = viewName;
  }

  getActiveView() {
    return this.views[this.activeView];
  }

  getView(name) {
    return this.views[name];
  }

  redrawAll() {
    for (const view of Object.values(this.views)) {
      view.redraw();
    }
  }

  redrawActive() {
    this.getActiveView()?.redraw();
  }

  undo() {
    return this.getActiveView()?.undo();
  }

  redo() {
    return this.getActiveView()?.redo();
  }

  resetZoom() {
    this.getActiveView()?.resetZoom();
  }

  clearAll(viewName) {
    (viewName ? this.views[viewName] : this.getActiveView())?.clearAll();
  }

  clearAllViews() {
    for (const view of Object.values(this.views)) {
      view.clearAll();
    }
  }

  getDimensions() {
    const result = {};
    for (const [name, view] of Object.entries(this.views)) {
      result[name] = view.getDimensions();
    }
    return result;
  }

  getDrawingCanvases() {
    // Returns stroke-only canvases (no silhouette fill) for accurate BSA pixel counting
    const result = {};
    for (const [name, view] of Object.entries(this.views)) {
      result[name] = view.getDrawOnlyCanvas();
    }
    return result;
  }

  headNeckHasStrokes() {
    return this.views['headNeck']?.hasStrokes() ?? false;
  }

  getAllStrokeData() {
    const rows = [];
    for (const [name, view] of Object.entries(this.views)) {
      rows.push(...view.getStrokeData(name));
    }
    return rows;
  }

  getExportCanvases() {
    const result = {};
    for (const [name, view] of Object.entries(this.views)) {
      result[name] = view.getExportCanvas();
    }
    return result;
  }
}
