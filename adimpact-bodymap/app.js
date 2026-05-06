/**
 * app.js
 * Main application logic: state, UI wiring, BSA calculation lifecycle.
 */

// ── Global app state (read by CanvasView instances) ─────────────
window.appState = {
  toolMode:  'draw',   // 'draw' | 'erase'
  brushSize: 20,       // in SVG coordinate space — updated after layout
};

// ── Main App ─────────────────────────────────────────────────────
class App {
  constructor() {
    this.canvasManager = new CanvasManager();
    this.regionMap     = new RegionMap();
    this.exporter      = null;   // created after layout
    this.scores        = { head: 0, trunk: 0, upperLimbs: 0, lowerLimbs: 0, total: 0 };
    this.activeView    = 'front';
    this._calcDebounce = null;
    this._calcSpinnerTimer = null;

    this._init();
  }

  _init() {
    this._buildUI();
    this._layoutCanvases();
    this._buildRegionMap();
    this._setActiveTool('draw');
    this._setActiveView('front');
    this._startCalculation();

    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('stroke-committed', () => this._scheduleCalculation());
  }

  // ── UI Construction ───────────────────────────────────────────

  _buildUI() {
    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setActiveView(btn.dataset.view));
    });

    // Tool buttons
    document.getElementById('btn-draw').addEventListener('click', () => this._setActiveTool('draw'));
    document.getElementById('btn-erase').addEventListener('click', () => this._setActiveTool('erase'));

    // Undo / Redo
    document.getElementById('btn-undo').addEventListener('click', () => {
      this.canvasManager.undo();
      this._updateUndoButtons();
    });
    document.getElementById('btn-redo').addEventListener('click', () => {
      this.canvasManager.redo();
      this._updateUndoButtons();
    });

    // Zoom reset
    document.getElementById('btn-reset-zoom').addEventListener('click', () => {
      this.canvasManager.resetZoom();
    });

    // Clear all
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (confirm('Clear all drawings from ALL views? This cannot be undone.')) {
        this.canvasManager.clearAllViews();
        this._scheduleCalculation();
        this._updateUndoButtons();
      }
    });

    // Brush slider
    const slider    = document.getElementById('brush-slider');
    const preview   = document.getElementById('brush-preview');
    slider.addEventListener('input', () => {
      this._updateBrushSize(+slider.value);
    });

    // Export
    document.getElementById('btn-export').addEventListener('click', () => this._showExportModal());
    document.getElementById('modal-close').addEventListener('click', () => this._hideExportModal());
    document.getElementById('export-png').addEventListener('click', async () => {
      await this.exporter.exportPNG(this.scores);
    });
    document.getElementById('export-strokes').addEventListener('click', () => {
      this.exporter.exportStrokeCSV();
    });
    document.getElementById('export-bsa').addEventListener('click', () => {
      this.exporter.exportBSACSV(this.scores);
    });
    document.getElementById('export-all').addEventListener('click', async () => {
      await this.exporter.exportAll(this.scores);
    });

    // Score panel toggle (mobile)
    const toggleBtn = document.getElementById('btn-score-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        document.getElementById('score-panel').classList.toggle('open');
      });
    }

    // Recalculate button
    document.getElementById('btn-recalculate')?.addEventListener('click', () => {
      this._startCalculation();
    });
  }

  // ── Layout ────────────────────────────────────────────────────

  _layoutCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const wrapper = document.getElementById('canvas-wrapper');
    const rect    = wrapper.getBoundingClientRect();
    const cssW    = rect.width;
    const cssH    = rect.height;

    const views = {
      front:    { canvas: document.getElementById('canvas-front'),    sil: SILHOUETTES.front },
      back:     { canvas: document.getElementById('canvas-back'),     sil: SILHOUETTES.back  },
      headNeck: { canvas: document.getElementById('canvas-headNeck'), sil: SILHOUETTES.headNeck },
    };

    for (const [name, { canvas, sil }] of Object.entries(views)) {
      this.canvasManager.registerView(name, canvas, sil);
    }

    this.canvasManager.layoutAll(cssW, cssH, dpr);

    // Compute dynamic brush sizes from silhouette pixel area
    this._computeDynamicBrush();

    this.exporter = new Exporter(this.canvasManager, this.regionMap);
  }

  _computeDynamicBrush() {
    // Use front view as reference for sizing
    const view = this.canvasManager.getView('front');
    if (!view) return;

    // Build region map first to measure pixels, or use approximate
    // We'll compute after region map is built
    const totalPx = 50000; // will be updated in _buildRegionMap
    const minR = view.computeMinBrushRadius(totalPx);
    const minBrush = minR;
    const maxBrush = minBrush * 10;
    const defBrush = minBrush * 2;

    this._minBrush = minBrush;
    this._maxBrush = maxBrush;

    window.appState.brushSize = defBrush;

    const slider = document.getElementById('brush-slider');
    slider.min   = minBrush.toFixed(2);
    slider.max   = maxBrush.toFixed(2);
    slider.step  = ((maxBrush - minBrush) / 100).toFixed(3);
    slider.value = defBrush.toFixed(2);

    this._updateBrushPreview(defBrush);
  }

  _buildRegionMap() {
    const dims = this.canvasManager.getDimensions();
    this.regionMap.build(dims);

    // Recompute brush with actual pixel counts
    const totalPx = this.regionMap.getTotalSilhouettePixels('front');
    const view     = this.canvasManager.getView('front');
    if (!view) return;
    const minR     = view.computeMinBrushRadius(totalPx);
    const minBrush = minR;
    const maxBrush = minBrush * 10;
    const defBrush = minBrush * 2;

    this._minBrush = minBrush;
    this._maxBrush = maxBrush;

    const slider = document.getElementById('brush-slider');
    slider.min   = minBrush.toFixed(2);
    slider.max   = maxBrush.toFixed(2);
    slider.step  = ((maxBrush - minBrush) / 100).toFixed(3);
    slider.value = defBrush.toFixed(2);

    window.appState.brushSize = defBrush;
    this._updateBrushPreview(defBrush);

    // Initial render
    this.canvasManager.redrawAll();
  }

  _onResize() {
    const dpr     = window.devicePixelRatio || 1;
    const wrapper = document.getElementById('canvas-wrapper');
    const rect    = wrapper.getBoundingClientRect();

    this.canvasManager.layoutAll(rect.width, rect.height, dpr);
    this._buildRegionMap();
    this._startCalculation();
  }

  // ── View Switching ────────────────────────────────────────────

  _setActiveView(viewName) {
    this.activeView = viewName;
    this.canvasManager.setActiveView(viewName);

    // Show/hide canvases
    document.querySelectorAll('.canvas-layer').forEach(c => {
      c.style.display = c.dataset.view === viewName ? 'block' : 'none';
    });

    // Update tab highlight
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    this._updateUndoButtons();
    this._scheduleCalculation();
  }

  // ── Tool Management ───────────────────────────────────────────

  _setActiveTool(tool) {
    window.appState.toolMode = tool;
    document.getElementById('btn-draw').classList.toggle('active', tool === 'draw');
    document.getElementById('btn-erase').classList.toggle('active', tool === 'erase');

    const canvasWrapper = document.getElementById('canvas-wrapper');
    canvasWrapper.style.cursor = tool === 'erase' ? 'cell' : 'crosshair';
  }

  _updateBrushSize(val) {
    window.appState.brushSize = val;
    this._updateBrushPreview(val);
  }

  _updateBrushPreview(brushSvg) {
    const preview = document.getElementById('brush-preview');
    const view    = this.canvasManager.getView('front');
    if (!view || !preview) return;
    const dpr      = window.devicePixelRatio || 1;
    const cssR     = (brushSvg * view.baseScale) / dpr;
    const diameter = Math.max(4, Math.min(60, cssR * 2));
    preview.style.width  = diameter + 'px';
    preview.style.height = diameter + 'px';
    preview.style.borderRadius = '50%';
  }

  // ── BSA Calculation ───────────────────────────────────────────

  _scheduleCalculation() {
    clearTimeout(this._calcDebounce);
    this._calcDebounce = setTimeout(() => this._startCalculation(), 300);
  }

  _startCalculation() {
    const start = performance.now();

    this._calcSpinnerTimer = setTimeout(() => {
      document.getElementById('calc-spinner')?.classList.remove('hidden');
    }, 200);

    // Run async to not block UI
    requestAnimationFrame(() => {
      const drawingCanvases    = this.canvasManager.getDrawingCanvases();
      const headNeckHasStrokes = this.canvasManager.headNeckHasStrokes();
      this.scores = this.regionMap.calculate(drawingCanvases, headNeckHasStrokes);

      clearTimeout(this._calcSpinnerTimer);
      document.getElementById('calc-spinner')?.classList.add('hidden');

      this._updateScorePanel(this.scores);
      this._updateUndoButtons();
    });
  }

  _updateScorePanel(scores) {
    const fmt = v => (v ?? 0).toFixed(1);

    const regions = [
      { key: 'head',       id: 'score-head'  },
      { key: 'trunk',      id: 'score-trunk' },
      { key: 'upperLimbs', id: 'score-upper' },
      { key: 'lowerLimbs', id: 'score-lower' },
    ];

    for (const r of regions) {
      const pct = scores[r.key] ?? 0;
      const el  = document.getElementById(r.id);
      if (!el) continue;
      el.querySelector('.score-value').textContent = fmt(pct) + '%';
      const bar = el.querySelector('.score-bar-fill');
      if (bar) bar.style.width = Math.min(100, pct) + '%';
    }

    const totalEl = document.getElementById('score-total');
    if (totalEl) totalEl.textContent = fmt(scores.total) + '%';
  }

  _updateUndoButtons() {
    const view = this.canvasManager.getActiveView();
    document.getElementById('btn-undo').disabled = !view || view.undoStack.length === 0;
    document.getElementById('btn-redo').disabled = !view || view.redoStack.length === 0;
  }

  // ── Export Modal ──────────────────────────────────────────────

  _showExportModal() {
    document.getElementById('export-modal').classList.remove('hidden');
  }

  _hideExportModal() {
    document.getElementById('export-modal').classList.add('hidden');
  }
}

// ── Bootstrap ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  window._app = new App();
});
