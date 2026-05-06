/**
 * canvas-manager.js
 * Two-layer canvas per view:
 *   bgCanvas   — silhouette + region boundaries, never erased
 *   drawCanvas — user strokes only, transparent background (safe to erase)
 *
 * Touch events are registered on the canvas-WRAPPER div (not the canvas
 * element itself) via CanvasManager.bindWrapper() — Safari reliably delivers
 * multi-touch events to a regular div but can be inconsistent on <canvas>.
 *
 * Gestures:
 *   1 finger  → draw stroke
 *   2 fingers → pinch-to-zoom + two-finger pan
 */

const GESTURE  = { IDLE: 'idle', DRAWING: 'drawing', ZOOMING: 'zooming' };
const MAX_UNDO  = 50;
const MIN_SCALE = 1;
const MAX_SCALE = 8;

class CanvasView {
  constructor(bgCanvas, drawCanvas, silDef, viewName) {
    this.bgCanvas  = bgCanvas;
    this.canvas    = drawCanvas;
    this.bgCtx     = bgCanvas.getContext('2d');
    this.ctx       = drawCanvas.getContext('2d');
    this.silDef    = silDef;
    this.viewName  = viewName;

    // Transform state
    this.scale     = 1;
    this.panX      = 0;
    this.panY      = 0;
    this.baseScale = 1;
    this.offsetX   = 0;
    this.offsetY   = 0;
    this.dpr       = 1;
    this.cssWidth  = 0;
    this.cssHeight = 0;

    // Stroke history
    this.undoStack = [];
    this.redoStack = [];

    // Gesture state — driven by CanvasManager.bindWrapper() touch listeners
    this.gestureState   = GESTURE.IDLE;
    this._currentStroke = null;
    this._pinchRef      = null;
    this._activeTouchId = null;

    // Mouse-only pointer events on the draw canvas
    this._onPtrDown   = this._onPtrDown.bind(this);
    this._onPtrMove   = this._onPtrMove.bind(this);
    this._onPtrUp     = this._onPtrUp.bind(this);
    this._onPtrCancel = this._onPtrCancel.bind(this);
    this.canvas.addEventListener('pointerdown',   this._onPtrDown);
    this.canvas.addEventListener('pointermove',   this._onPtrMove);
    this.canvas.addEventListener('pointerup',     this._onPtrUp);
    this.canvas.addEventListener('pointercancel', this._onPtrCancel);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown',   this._onPtrDown);
    this.canvas.removeEventListener('pointermove',   this._onPtrMove);
    this.canvas.removeEventListener('pointerup',     this._onPtrUp);
    this.canvas.removeEventListener('pointercancel', this._onPtrCancel);
  }

  // ── Layout ────────────────────────────────────────────────────

  layout(cssWidth, cssHeight, dpr) {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const scaleX   = (cssWidth  * dpr) / svgW;
    const scaleY   = (cssHeight * dpr) / svgH;
    this.baseScale = Math.min(scaleX, scaleY) * 0.85;
    this.offsetX   = ((cssWidth  * dpr) - svgW * this.baseScale) / 2;
    this.offsetY   = ((cssHeight * dpr) - svgH * this.baseScale) / 2;
    this.dpr       = dpr;
    this.cssWidth  = cssWidth;
    this.cssHeight = cssHeight;
    this.scale     = 1;
    this.panX      = 0;
    this.panY      = 0;
  }

  getDimensions() {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    return { width: this.canvas.width, height: this.canvas.height,
             scale: this.baseScale, offsetX: this.offsetX, offsetY: this.offsetY, svgW, svgH };
  }

  // ── Background (silhouette) ───────────────────────────────────

  redrawBg() {
    const ctx = this.bgCtx;
    const w   = this.bgCanvas.width;
    const h   = this.bgCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);

    ctx.fillStyle   = '#E0E0E0';
    ctx.strokeStyle = '#999999';
    ctx.lineWidth   = 1.5 / this.baseScale;
    const outline = new Path2D(this.silDef.outline);
    ctx.fill(outline);
    ctx.stroke(outline);

    if (this.silDef.details) {
      ctx.strokeStyle = '#BBBBBB';
      ctx.lineWidth   = 1 / this.baseScale;
      ctx.stroke(new Path2D(this.silDef.details));
    }

    if (this.silDef.regionBoundaries?.length) {
      ctx.strokeStyle = '#AAAAAA';
      ctx.lineWidth   = 1 / this.baseScale;
      ctx.setLineDash([4 / this.baseScale, 4 / this.baseScale]);
      for (const b of this.silDef.regionBoundaries) ctx.stroke(new Path2D(b.d));
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // ── Stroke layer ──────────────────────────────────────────────

  redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);
    for (const stroke of this.undoStack) this._renderStroke(ctx, stroke);
    ctx.restore();
  }

  _renderStroke(ctx, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    ctx.save();
    if (stroke.mode === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle   = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,0,0,0.5)';
      ctx.fillStyle   = 'rgba(255,0,0,0.5)';
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
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // ── Coordinate helpers ────────────────────────────────────────

  _canvasToSvg(cx, cy) {
    const dpr = this.dpr;
    const ux  = (cx * dpr - this.panX * dpr) / this.scale;
    const uy  = (cy * dpr - this.panY * dpr) / this.scale;
    return { x: (ux - this.offsetX) / this.baseScale,
             y: (uy - this.offsetY) / this.baseScale };
  }

  _getPointerXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _getTouchPos(touch) {
    const r = this.canvas.getBoundingClientRect();
    return { x: touch.clientX - r.left, y: touch.clientY - r.top };
  }

  // ── Touch handlers — called from CanvasManager.bindWrapper() ──
  // (not registered on the canvas; wrapper div is the listener target)

  handleTouchStart(e) {
    if (e.touches.length === 1) {
      if (this.gestureState !== GESTURE.IDLE) return;
      this._activeTouchId = e.touches[0].identifier;
      this.gestureState   = GESTURE.DRAWING;
      this._startStroke(this._getTouchPos(e.touches[0]));

    } else if (e.touches.length >= 2) {
      if (this.gestureState === GESTURE.DRAWING) {
        this._currentStroke = null;
        this.redraw();
      }
      this._activeTouchId = null;
      this.gestureState   = GESTURE.ZOOMING;
      this._initPinch(e.touches);
    }
  }

  handleTouchMove(e) {
    if (this.gestureState === GESTURE.DRAWING && e.touches.length === 1) {
      const t = Array.from(e.touches).find(t => t.identifier === this._activeTouchId);
      if (t) this._continueStroke(this._getTouchPos(t));

    } else if (e.touches.length >= 2) {
      if (this.gestureState === GESTURE.DRAWING) {
        // Second finger arrived mid-stroke — cancel stroke and switch to pinch
        this._currentStroke = null;
        this.redraw();
        this._activeTouchId = null;
        this.gestureState   = GESTURE.ZOOMING;
        this._initPinch(e.touches);
      } else if (this.gestureState === GESTURE.ZOOMING) {
        this._updatePinch(e.touches);
      }
    }
  }

  handleTouchEnd(e) {
    if (this.gestureState === GESTURE.DRAWING && e.touches.length === 0) {
      this._commitStroke();
      this.gestureState   = GESTURE.IDLE;
      this._activeTouchId = null;

    } else if (this.gestureState === GESTURE.ZOOMING && e.touches.length < 2) {
      // Don't auto-restart drawing when one pinch finger lifts
      this._pinchRef      = null;
      this.gestureState   = GESTURE.IDLE;
      this._activeTouchId = null;
    }
  }

  handleTouchCancel(e) {
    if (this.gestureState === GESTURE.DRAWING) {
      this._currentStroke = null;
      this.redraw();
    }
    this.gestureState   = GESTURE.IDLE;
    this._pinchRef      = null;
    this._activeTouchId = null;
  }

  cancelGesture() {
    if (this.gestureState === GESTURE.DRAWING) {
      this._currentStroke = null;
      this.redraw();
    }
    this.gestureState   = GESTURE.IDLE;
    this._pinchRef      = null;
    this._activeTouchId = null;
  }

  // ── Mouse pointer events (non-touch) ─────────────────────────

  _onPtrDown(e) {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    if (this.gestureState !== GESTURE.IDLE) return;
    this.gestureState = GESTURE.DRAWING;
    this._startStroke(this._getPointerXY(e));
  }

  _onPtrMove(e) {
    if (e.pointerType === 'touch') return;
    if (this.gestureState !== GESTURE.DRAWING) return;
    this._continueStroke(this._getPointerXY(e));
  }

  _onPtrUp(e) {
    if (e.pointerType === 'touch') return;
    if (this.gestureState === GESTURE.DRAWING) {
      this._commitStroke();
      this.gestureState = GESTURE.IDLE;
    }
  }

  _onPtrCancel(e) {
    if (e.pointerType === 'touch') return;
    if (this.gestureState === GESTURE.DRAWING) {
      this._currentStroke = null;
      this.redraw();
      this.gestureState = GESTURE.IDLE;
    }
  }

  // ── Pinch + two-finger pan ────────────────────────────────────

  _initPinch(touches) {
    const a = this._getTouchPos(touches[0]);
    const b = this._getTouchPos(touches[1]);
    this._pinchRef = {
      midX: (a.x + b.x) / 2,  midY: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      startScale: this.scale, startPanX: this.panX, startPanY: this.panY,
    };
  }

  _updatePinch(touches) {
    if (!this._pinchRef) { this._initPinch(touches); return; }
    const a    = this._getTouchPos(touches[0]);
    const b    = this._getTouchPos(touches[1]);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);

    const { startScale, startPanX, startPanY, midX: rMX, midY: rMY, dist: rD } = this._pinchRef;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale * (dist / rD)));
    const sf       = newScale / startScale;
    const newPanX  = rMX - sf * (rMX - startPanX) + (midX - rMX);
    const newPanY  = rMY - sf * (rMY - startPanY) + (midY - rMY);

    this.scale = newScale;
    this.panX  = this._clampPan('x', newPanX);
    this.panY  = this._clampPan('y', newPanY);
    requestAnimationFrame(() => { this.redrawBg(); this.redraw(); });
  }

  _clampPan(axis, val) {
    const pad = 50;
    if (axis === 'x') return Math.min(pad, Math.max(this.cssWidth  - this.cssWidth  * this.scale - pad, val));
    else              return Math.min(pad, Math.max(this.cssHeight - this.cssHeight * this.scale - pad, val));
  }

  resetZoom() {
    this.scale = 1; this.panX = 0; this.panY = 0;
    this.redrawBg(); this.redraw();
  }

  // ── Stroke operations ─────────────────────────────────────────

  _startStroke(cssPos) {
    const svgPos   = this._canvasToSvg(cssPos.x, cssPos.y);
    const brushSvg = (window.appState?.brushSize ?? 20) / this.baseScale;
    this._currentStroke = {
      points:    [{ x: svgPos.x, y: svgPos.y, t: Date.now() }],
      brushSize: brushSvg,
      mode:      window.appState?.toolMode ?? 'draw',
    };
  }

  _continueStroke(cssPos) {
    if (!this._currentStroke) return;
    const svgPos = this._canvasToSvg(cssPos.x, cssPos.y);
    this._currentStroke.points.push({ x: svgPos.x, y: svgPos.y, t: Date.now() });
    requestAnimationFrame(() => {
      if (!this._currentStroke) return;
      this.redraw();
      this.ctx.save();
      this.ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
      this.ctx.scale(this.scale, this.scale);
      this.ctx.translate(this.offsetX, this.offsetY);
      this.ctx.scale(this.baseScale, this.baseScale);
      this._renderStroke(this.ctx, this._currentStroke);
      this.ctx.restore();
    });
  }

  _commitStroke() {
    if (!this._currentStroke) return;
    if (this._currentStroke.points.length > 0) {
      this.undoStack.push(this._currentStroke);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
      window.dispatchEvent(new CustomEvent('stroke-committed', { detail: { view: this.viewName } }));
    }
    this._currentStroke = null;
    this.redraw();
  }

  // ── Undo / Redo ───────────────────────────────────────────────

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

  hasStrokes() { return this.undoStack.length > 0; }

  // ── Export helpers ────────────────────────────────────────────

  getExportCanvas() {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const expScale = 2;
    const w = Math.round(svgW * this.baseScale * expScale);
    const h = Math.round(svgH * this.baseScale * expScale);

    const off = document.createElement('canvas');
    off.width  = w;
    off.height = h;
    const ctx  = off.getContext('2d');

    ctx.save();
    ctx.scale(expScale, expScale);
    ctx.translate(this.offsetX / this.baseScale, this.offsetY / this.baseScale);
    ctx.scale(this.baseScale, this.baseScale);
    ctx.fillStyle   = '#E0E0E0';
    ctx.strokeStyle = '#999999';
    ctx.lineWidth   = 1.5;
    const outline = new Path2D(this.silDef.outline);
    ctx.fill(outline);
    ctx.stroke(outline);
    if (this.silDef.details) {
      ctx.strokeStyle = '#BBBBBB';
      ctx.lineWidth   = 1;
      ctx.stroke(new Path2D(this.silDef.details));
    }
    if (this.silDef.regionBoundaries?.length) {
      ctx.strokeStyle = '#AAAAAA';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      for (const b of this.silDef.regionBoundaries) ctx.stroke(new Path2D(b.d));
      ctx.setLineDash([]);
    }
    ctx.restore();

    ctx.save();
    ctx.scale(expScale, expScale);
    ctx.translate(this.offsetX / this.baseScale, this.offsetY / this.baseScale);
    ctx.scale(this.baseScale, this.baseScale);
    for (const stroke of this.undoStack) this._renderStroke(ctx, stroke);
    ctx.restore();

    return off;
  }

  getDrawOnlyCanvas() {
    const off = document.createElement('canvas');
    off.width  = this.canvas.width;
    off.height = this.canvas.height;
    const ctx  = off.getContext('2d');
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);
    for (const stroke of this.undoStack) this._renderStroke(ctx, stroke);
    ctx.restore();
    return off;
  }

  getStrokeData(viewName) {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const rows = [];
    this.undoStack.forEach((stroke, si) => {
      stroke.points.forEach((pt, pi) => {
        rows.push({ view: viewName, stroke_id: si, point_index: pi,
                    x: +(pt.x / svgW).toFixed(6), y: +(pt.y / svgH).toFixed(6),
                    timestamp: pt.t || 0, brush_size: +stroke.brushSize.toFixed(4),
                    mode: stroke.mode });
      });
    });
    return rows;
  }

  computeMinBrushRadius(totalSilPixels) {
    const area = totalSilPixels * 0.01;
    return Math.sqrt(area / Math.PI) / this.baseScale;
  }
}


// ─── CanvasManager ───────────────────────────────────────────────────────────

class CanvasManager {
  constructor() {
    this.views      = {};
    this.activeView = 'front';
  }

  registerView(viewName, bgCanvas, drawCanvas, silDef) {
    this.views[viewName] = new CanvasView(bgCanvas, drawCanvas, silDef, viewName);
  }

  /**
   * Attach touch gesture listeners to the canvas-wrapper div.
   * Must be called once after views are registered.
   * A div is used instead of the <canvas> element because Safari reliably
   * delivers multi-touch events to divs but can miss touchstart on canvases.
   */
  bindWrapper(wrapper) {
    const opts = { passive: false };
    wrapper.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.getActiveView()?.handleTouchStart(e);
    }, opts);
    wrapper.addEventListener('touchmove', (e) => {
      e.preventDefault();
      this.getActiveView()?.handleTouchMove(e);
    }, opts);
    wrapper.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.getActiveView()?.handleTouchEnd(e);
    }, opts);
    wrapper.addEventListener('touchcancel', (e) => {
      this.getActiveView()?.handleTouchCancel(e);
    }, opts);
  }

  layoutAll(cssWidth, cssHeight, dpr) {
    for (const [, view] of Object.entries(this.views)) {
      for (const canvas of [view.bgCanvas, view.canvas]) {
        canvas.width        = Math.round(cssWidth  * dpr);
        canvas.height       = Math.round(cssHeight * dpr);
        canvas.style.width  = cssWidth  + 'px';
        canvas.style.height = cssHeight + 'px';
      }
      view.layout(cssWidth, cssHeight, dpr);
    }
  }

  setActiveView(v) {
    if (this.views[v]) {
      this.getActiveView()?.cancelGesture();
      this.activeView = v;
    }
  }

  getActiveView()  { return this.views[this.activeView]; }
  getView(name)    { return this.views[name]; }

  redrawAll() {
    for (const view of Object.values(this.views)) { view.redrawBg(); view.redraw(); }
  }

  undo()      { return this.getActiveView()?.undo(); }
  redo()      { return this.getActiveView()?.redo(); }
  resetZoom() { this.getActiveView()?.resetZoom(); }

  clearAll(viewName) {
    (viewName ? this.views[viewName] : this.getActiveView())?.clearAll();
  }
  clearAllViews() {
    for (const view of Object.values(this.views)) view.clearAll();
  }

  getDimensions() {
    const r = {};
    for (const [n, v] of Object.entries(this.views)) r[n] = v.getDimensions();
    return r;
  }

  getDrawingCanvases() {
    const r = {};
    for (const [n, v] of Object.entries(this.views)) r[n] = v.getDrawOnlyCanvas();
    return r;
  }

  headNeckHasStrokes() { return this.views['headNeck']?.hasStrokes() ?? false; }

  getAllStrokeData() {
    const rows = [];
    for (const [n, v] of Object.entries(this.views)) rows.push(...v.getStrokeData(n));
    return rows;
  }

  getExportCanvases() {
    const r = {};
    for (const [n, v] of Object.entries(this.views)) r[n] = v.getExportCanvas();
    return r;
  }
}
