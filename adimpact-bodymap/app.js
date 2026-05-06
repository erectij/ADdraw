/**
 * app.js
 * Main application: state, UI wiring, BSA calculation lifecycle.
 */

window.appState = {
  toolMode:  'draw',
  brushSize: 20,
};

class App {
  constructor() {
    this.canvasManager = new CanvasManager();
    this.regionMap     = new RegionMap();
    this.exporter      = null;
    this.scores        = { head: 0, trunk: 0, upperLimbs: 0, lowerLimbs: 0, total: 0 };
    this.activeView    = 'front';
    this._calcDebounce = null;

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

  // ── UI wiring ─────────────────────────────────────────────────

  _buildUI() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setActiveView(btn.dataset.view));
    });

    document.getElementById('btn-draw').addEventListener('click',  () => this._setActiveTool('draw'));
    document.getElementById('btn-erase').addEventListener('click', () => this._setActiveTool('erase'));

    document.getElementById('btn-undo').addEventListener('click', () => {
      this.canvasManager.undo(); this._updateUndoButtons();
    });
    document.getElementById('btn-redo').addEventListener('click', () => {
      this.canvasManager.redo(); this._updateUndoButtons();
    });

    document.getElementById('btn-reset-zoom').addEventListener('click', () => {
      this.canvasManager.resetZoom();
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      if (confirm('Clear all drawings from ALL views? This cannot be undone.')) {
        this.canvasManager.clearAllViews();
        this._scheduleCalculation();
        this._updateUndoButtons();
      }
    });

    document.getElementById('brush-slider').addEventListener('input', e => {
      this._updateBrushSize(+e.target.value);
    });

    document.getElementById('btn-export').addEventListener('click',  () => this._showExportModal());
    document.getElementById('modal-close').addEventListener('click', () => this._hideExportModal());
    document.getElementById('export-png').addEventListener('click',     async () => { await this.exporter.exportPNG(this.scores); });
    document.getElementById('export-strokes').addEventListener('click', () => { this.exporter.exportStrokeCSV(); });
    document.getElementById('export-bsa').addEventListener('click',     () => { this.exporter.exportBSACSV(this.scores); });
    document.getElementById('export-all').addEventListener('click',     async () => { await this.exporter.exportAll(this.scores); });

    document.getElementById('btn-score-toggle')?.addEventListener('click', () => {
      document.getElementById('score-panel').classList.toggle('open');
    });

    document.getElementById('btn-recalculate')?.addEventListener('click', () => {
      this._startCalculation();
    });
  }

  // ── Layout ────────────────────────────────────────────────────

  _layoutCanvases() {
    const dpr     = window.devicePixelRatio || 1;
    const wrapper = document.getElementById('canvas-wrapper');
    const rect    = wrapper.getBoundingClientRect();
    const cssW    = rect.width;
    const cssH    = rect.height;

    const views = {
      front:    { bg: 'canvas-bg-front',    draw: 'canvas-draw-front',    sil: SILHOUETTES.front    },
      back:     { bg: 'canvas-bg-back',     draw: 'canvas-draw-back',     sil: SILHOUETTES.back     },
      headNeck: { bg: 'canvas-bg-headNeck', draw: 'canvas-draw-headNeck', sil: SILHOUETTES.headNeck },
    };

    for (const [name, { bg, draw, sil }] of Object.entries(views)) {
      this.canvasManager.registerView(
        name,
        document.getElementById(bg),
        document.getElementById(draw),
        sil
      );
    }

    this.canvasManager.layoutAll(cssW, cssH, dpr);
    this.canvasManager.bindWrapper(wrapper);
    this.exporter = new Exporter(this.canvasManager, this.regionMap);
  }

  _buildRegionMap() {
    const dims = this.canvasManager.getDimensions();
    this.regionMap.build(dims);

    // Compute dynamic brush from silhouette pixel area
    const totalPx  = this.regionMap.getTotalSilhouettePixels('front');
    const view      = this.canvasManager.getView('front');
    if (!view) return;

    const minBrush = view.computeMinBrushRadius(totalPx);
    const maxBrush = minBrush * 10;
    const defBrush = minBrush * 2;

    window.appState.brushSize = defBrush;

    const slider   = document.getElementById('brush-slider');
    slider.min     = minBrush.toFixed(2);
    slider.max     = maxBrush.toFixed(2);
    slider.step    = ((maxBrush - minBrush) / 100).toFixed(3);
    slider.value   = defBrush.toFixed(2);

    this._updateBrushPreview(defBrush);
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

  // ── View switching ────────────────────────────────────────────

  _setActiveView(viewName) {
    this.activeView = viewName;
    this.canvasManager.setActiveView(viewName);

    // Show/hide BOTH canvas layers per view
    document.querySelectorAll('.canvas-bg, .canvas-draw').forEach(c => {
      const match = c.dataset.view === viewName;
      c.style.display = match ? 'block' : 'none';
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
      btn.setAttribute('aria-selected', btn.dataset.view === viewName ? 'true' : 'false');
    });

    this._updateUndoButtons();
    this._scheduleCalculation();
  }

  // ── Tool management ───────────────────────────────────────────

  _setActiveTool(tool) {
    window.appState.toolMode = tool;
    document.getElementById('btn-draw').classList.toggle('active',  tool === 'draw');
    document.getElementById('btn-erase').classList.toggle('active', tool === 'erase');
    document.getElementById('canvas-wrapper').style.cursor = tool === 'erase' ? 'cell' : 'crosshair';
  }

  _updateBrushSize(val) {
    window.appState.brushSize = val;
    this._updateBrushPreview(val);
  }

  _updateBrushPreview(brushSvg) {
    const preview = document.getElementById('brush-preview');
    const view    = this.canvasManager.getView('front');
    if (!view || !preview) return;
    const cssR    = (brushSvg * view.baseScale) / (window.devicePixelRatio || 1);
    const diam    = Math.max(4, Math.min(60, cssR * 2));
    preview.style.width        = diam + 'px';
    preview.style.height       = diam + 'px';
    preview.style.borderRadius = '50%';
  }

  // ── BSA calculation ───────────────────────────────────────────

  _scheduleCalculation() {
    clearTimeout(this._calcDebounce);
    this._calcDebounce = setTimeout(() => this._startCalculation(), 300);
  }

  _startCalculation() {
    const spinnerTimer = setTimeout(() => {
      document.getElementById('calc-spinner')?.classList.remove('hidden');
    }, 200);

    requestAnimationFrame(() => {
      const canvases          = this.canvasManager.getDrawingCanvases();
      const headNeckHasStrokes = this.canvasManager.headNeckHasStrokes();
      this.scores = this.regionMap.calculate(canvases, headNeckHasStrokes);

      clearTimeout(spinnerTimer);
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
      const el = document.getElementById(r.id);
      if (!el) continue;
      const pct = scores[r.key] ?? 0;
      el.querySelector('.score-value').textContent  = fmt(pct) + '%';
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

  // ── Export modal ──────────────────────────────────────────────

  _showExportModal() { document.getElementById('export-modal').classList.remove('hidden'); }
  _hideExportModal() { document.getElementById('export-modal').classList.add('hidden'); }
}

window.addEventListener('DOMContentLoaded', () => {
  window._app = new App();
});
