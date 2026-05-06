/**
 * canvas-manager.js
 * Two-layer canvas per view:
 *   bgCanvas   — silhouette + region boundaries, never erased
 *   drawCanvas — user strokes only, transparent background (safe to erase)
 *
 * Gesture state machine:
 *   IDLE → 1st pointer (80ms buffer) → DRAWING
 *   IDLE → 2nd pointer within buffer  → ZOOMING
 *   DRAWING → 2nd pointer down         → cancel stroke, ZOOMING
 *   ZOOMING → all pointers lifted       → IDLE
 *   DRAWING → pointer lifted            → commit stroke, IDLE
 */

const GESTURE = { IDLE: 'idle', DRAWING: 'drawing', ZOOMING: 'zooming' };
const DRAW_BUFFER_MS = 80;
const MAX_UNDO = 50;

class CanvasView {
  constructor(bgCanvas, drawCanvas, silDef, viewName) {
    this.bgCanvas   = bgCanvas;
    this.canvas     = drawCanvas;   // pointer events + stroke rendering
    this.bgCtx      = bgCanvas.getContext('2d');
    this.ctx        = drawCanvas.getContext('2d');
    this.silDef     = silDef;
    this.viewName   = viewName;

    // Transform state (shared — both canvases use same transform)
    this.scale      = 1;
    this.panX       = 0;
    this.panY       = 0;
    this.baseScale  = 1;
    this.offsetX    = 0;
    this.offsetY    = 0;
    this.dpr        = 1;
    this.cssWidth   = 0;
    this.cssHeight  = 0;

    // Stroke history
    this.undoStack  = [];
    this.redoStack  = [];

    // Gesture
    this.gestureState   = GESTURE.IDLE;
    this.activePointers = new Map();
    this._bufferTimer   = null;
    this._pendingStroke = null;
    this._currentStroke = null;
    this._pinchRef      = null;

    this._onPointerDown   = this._onPointerDown.bind(this);
    this._onPointerMove   = this._onPointerMove.bind(this);
    this._onPointerUp     = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);

    // Pointer events go on the draw canvas (top layer)
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

  layout(cssWidth, cssHeight, dpr) {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const scaleX = (cssWidth  * dpr) / svgW;
    const scaleY = (cssHeight * dpr) / svgH;
    this.baseScale  = Math.min(scaleX, scaleY) * 0.85;
    this.offsetX    = ((cssWidth  * dpr) - svgW * this.baseScale) / 2;
    this.offsetY    = ((cssHeight * dpr) - svgH * this.baseScale) / 2;
    this.dpr        = dpr;
    this.cssWidth   = cssWidth;
    this.cssHeight  = cssHeight;
    this.scale      = 1;
    this.panX       = 0;
    this.panY       = 0;
  }

  getDimensions() {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    return { width: this.canvas.width, height: this.canvas.height,
             scale: this.baseScale, offsetX: this.offsetX, offsetY: this.offsetY, svgW, svgH };
  }

  // ─── Background (silhouette) ─────────────────────────────────

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

    // Body fill + outline
    ctx.fillStyle   = '#E0E0E0';
    ctx.strokeStyle = '#999999';
    ctx.lineWidth   = 1.5 / this.baseScale;
    const outline = new Path2D(this.silDef.outline);
    ctx.fill(outline);
    ctx.stroke(outline);

    // Facial details (head & neck view)
    if (this.silDef.details) {
      ctx.strokeStyle = '#BBBBBB';
      ctx.lineWidth   = 1 / this.baseScale;
      ctx.stroke(new Path2D(this.silDef.details));
    }

    // Dashed region boundaries
    if (this.silDef.regionBoundaries?.length) {
      ctx.strokeStyle = '#AAAAAA';
      ctx.lineWidth   = 1 / this.baseScale;
      ctx.setLineDash([4 / this.baseScale, 4 / this.baseScale]);
      for (const b of this.silDef.regionBoundaries) {
        ctx.stroke(new Path2D(b.d));
      }
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  // ─── Stroke layer ────────────────────────────────────────────

  redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Apply zoom+pan then draw all committed strokes
    ctx.save();
    ctx.translate(this.panX * this.dpr, this.panY * this.dpr);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);
    for (const stroke of this.undoStack) {
      this._renderStroke(ctx, stroke);
    }
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

  // ─── Coordinate mapping ──────────────────────────────────────

  _canvasToSvg(cx, cy) {
    const dpr = this.dpr;
    const px  = cx * dpr;
    const py  = cy * dpr;
    const ux  = (px - this.panX * dpr) / this.scale;
    const uy  = (py - this.panY * dpr) / this.scale;
    return { x: (ux - this.offsetX) / this.baseScale,
             y: (uy - this.offsetY) / this.baseScale };
  }

  _getPointerXY(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ─── Gesture state machine ───────────────────────────────────

  _onPointerDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' && e.width > 60 && e.height > 60) return;

    const pos = this._getPointerXY(e);
    this.activePointers.set(e.pointerId, pos);

    if (this.activePointers.size === 1) {
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
      this._cancelBuffer();
      if (this.gestureState === GESTURE.DRAWING) {
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
      if (this.activePointers.size === 0) {
        this.gestureState = GESTURE.IDLE;
        this._pinchRef = null;
      } else {
        this._pinchRef = null;
      }
    } else if (this._bufferTimer !== null) {
      // Tap during buffer window
      this._cancelBuffer();
      const pos = this._getPointerXY(e);
      this._startStroke(pos);
      this._commitStroke();
    }

    if (this.activePointers.size === 0) this._cancelBuffer();
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
    if (this._bufferTimer !== null) { clearTimeout(this._bufferTimer); this._bufferTimer = null; }
    this._pendingStroke = null;
  }

  // ─── Stroke operations ───────────────────────────────────────

  _startStroke(cssPos) {
    const svgPos = this._canvasToSvg(cssPos.x, cssPos.y);
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
      // Draw current stroke on top
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

  hasStrokes() { return this.undoStack.length > 0; }

  // ─── Zoom / Pan ───────────────────────────────────────────────

  _initPinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    this._pinchRef = {
      midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      startScale: this.scale, startPanX: this.panX, startPanY: this.panY,
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

    const { startScale, startPanX, startPanY, midX: rMX, midY: rMY, dist: rD } = this._pinchRef;
    const newScale = Math.min(8, Math.max(1, startScale * (dist / rD)));
    const sf       = newScale / startScale;
    const newPanX  = rMX - sf * (rMX - startPanX) + (midX - rMX);
    const newPanY  = rMY - sf * (rMY - startPanY) + (midY - rMY);

    this.scale = newScale;
    this.panX  = this._clampPan('x', newPanX);
    this.panY  = this._clampPan('y', newPanY);
    requestAnimationFrame(() => { this.redrawBg(); this.redraw(); });
  }

  _clampPan(axis, val) {
    const padding = 50;
    if (axis === 'x') {
      return Math.min(padding, Math.max(this.cssWidth - this.cssWidth * this.scale - padding, val));
    } else {
      return Math.min(padding, Math.max(this.cssHeight - this.cssHeight * this.scale - padding, val));
    }
  }

  resetZoom() {
    this.scale = 1; this.panX = 0; this.panY = 0;
    this.redrawBg(); this.redraw();
  }

  // ─── Export helpers ───────────────────────────────────────────

  /**
   * Composite bg + draw strokes onto a clean offscreen canvas.
   * No zoom/pan applied — produces the "canonical" view.
   */
  getExportCanvas() {
    const [,, svgW, svgH] = this.silDef.viewBox.split(' ').map(Number);
    const expScale = 2;
    const w = Math.round(svgW * this.baseScale * expScale);
    const h = Math.round(svgH * this.baseScale * expScale);

    const off = document.createElement('canvas');
    off.width  = w;
    off.height = h;
    const ctx  = off.getContext('2d');

    // Draw silhouette
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

    // Draw strokes on top
    ctx.save();
    ctx.scale(expScale, expScale);
    ctx.translate(this.offsetX / this.baseScale, this.offsetY / this.baseScale);
    ctx.scale(this.baseScale, this.baseScale);
    for (const stroke of this.undoStack) {
      this._renderStroke(ctx, stroke);
    }
    ctx.restore();

    return off;
  }

  /**
   * Strokes-only canvas (transparent bg) matching the region-map dimensions.
   * Used for BSA pixel counting.
   */
  getDrawOnlyCanvas() {
    const off = document.createElement('canvas');
    off.width  = this.canvas.width;
    off.height = this.canvas.height;
    const ctx  = off.getContext('2d');

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.baseScale, this.baseScale);
    for (const stroke of this.undoStack) {
      this._renderStroke(ctx, stroke);
    }
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

  layoutAll(cssWidth, cssHeight, dpr) {
    for (const [, view] of Object.entries(this.views)) {
      // Size both canvases identically
      for (const canvas of [view.bgCanvas, view.canvas]) {
        canvas.width        = Math.round(cssWidth  * dpr);
        canvas.height       = Math.round(cssHeight * dpr);
        canvas.style.width  = cssWidth  + 'px';
        canvas.style.height = cssHeight + 'px';
      }
      view.layout(cssWidth, cssHeight, dpr);
    }
  }

  setActiveView(v) { if (this.views[v]) this.activeView = v; }
  getActiveView()  { return this.views[this.activeView]; }
  getView(name)    { return this.views[name]; }

  redrawAll() {
    for (const view of Object.values(this.views)) { view.redrawBg(); view.redraw(); }
  }

  undo() { return this.getActiveView()?.undo(); }
  redo() { return this.getActiveView()?.redo(); }
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
