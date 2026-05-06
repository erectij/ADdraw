/**
 * export.js
 * Handles PNG, stroke CSV, and BSA CSV exports.
 */

class Exporter {
  constructor(canvasManager, regionMap) {
    this.canvasManager = canvasManager;
    this.regionMap     = regionMap;
  }

  _timestamp() {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${Y}-${M}-${D}_${h}-${m}`;
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }

  // ── PNG Export ────────────────────────────────────────────────

  async exportPNG(scores) {
    const ts      = this._timestamp();
    const exports = this.canvasManager.getExportCanvases();

    // Download individual view images
    for (const [name, canvas] of Object.entries(exports)) {
      await new Promise(resolve => {
        canvas.toBlob(blob => {
          this._download(blob, `ADimpact_bodymap_${name}_${ts}.png`);
          resolve();
        }, 'image/png');
      });
    }

    // Combined summary image
    const combinedCanvas = this._buildCombined(exports, scores);
    await new Promise(resolve => {
      combinedCanvas.toBlob(blob => {
        this._download(blob, `ADimpact_bodymap_combined_${ts}.png`);
        resolve();
      }, 'image/png');
    });
  }

  _buildCombined(exports, scores) {
    const views  = ['front', 'back', 'headNeck'];
    const labels = ['Front', 'Back', 'Head & Neck'];
    const gap    = 20;
    const labelH = 60;
    const scoreH = 80;

    const canvases = views.map(v => exports[v]);
    const totalW   = canvases.reduce((sum, c) => sum + c.width, 0) + gap * (canvases.length + 1);
    const maxH     = Math.max(...canvases.map(c => c.height));
    const totalH   = maxH + labelH + scoreH + gap * 2;

    const combined = document.createElement('canvas');
    combined.width  = totalW;
    combined.height = totalH;
    const ctx = combined.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, totalW, totalH);

    // Title
    ctx.fillStyle   = '#333333';
    ctx.font        = 'bold 28px sans-serif';
    ctx.textAlign   = 'center';
    ctx.fillText('ADimpact Body Map', totalW / 2, 36);

    let x = gap;
    canvases.forEach((canvas, i) => {
      const y = labelH;
      ctx.drawImage(canvas, x, y);

      // View label
      ctx.fillStyle   = '#333333';
      ctx.font        = 'bold 18px sans-serif';
      ctx.textAlign   = 'center';
      ctx.fillText(labels[i], x + canvas.width / 2, labelH - 8);

      x += canvas.width + gap;
    });

    // Score panel below
    if (scores) {
      const scoreY = maxH + labelH + gap;
      ctx.fillStyle = '#F5F5F5';
      ctx.fillRect(gap, scoreY, totalW - gap * 2, scoreH);

      ctx.fillStyle   = '#333333';
      ctx.font        = '16px sans-serif';
      ctx.textAlign   = 'left';

      const regions = [
        { key: 'head',       label: 'Head & Neck',  weight: '10%' },
        { key: 'trunk',      label: 'Trunk',         weight: '30%' },
        { key: 'upperLimbs', label: 'Upper Limbs',   weight: '20%' },
        { key: 'lowerLimbs', label: 'Lower Limbs',   weight: '40%' },
      ];

      const colW = (totalW - gap * 2) / (regions.length + 1);
      regions.forEach((r, i) => {
        const cx = gap + colW * i + colW / 2;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666666';
        ctx.fillText(r.label, cx, scoreY + 20);
        ctx.fillStyle = '#333333';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText(
          scores[r.key] !== undefined ? scores[r.key].toFixed(1) + '%' : '--',
          cx, scoreY + 48
        );
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#999999';
        ctx.fillText('weight: ' + r.weight, cx, scoreY + 66);
      });

      // Total
      const tx = gap + colW * regions.length + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#333333';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('Total BSA%', tx, scoreY + 20);
      ctx.font = 'bold 28px sans-serif';
      ctx.fillStyle = '#B03030';
      ctx.fillText(
        scores.total !== undefined ? scores.total.toFixed(1) + '%' : '--',
        tx, scoreY + 52
      );
    }

    return combined;
  }

  // ── Stroke CSV ────────────────────────────────────────────────

  exportStrokeCSV() {
    const rows = this.canvasManager.getAllStrokeData();
    const header = 'view,stroke_id,point_index,x,y,timestamp,brush_size,mode\n';
    const body   = rows.map(r =>
      `${r.view},${r.stroke_id},${r.point_index},${r.x},${r.y},${r.timestamp},${r.brush_size},${r.mode}`
    ).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    this._download(blob, `ADimpact_strokes_${this._timestamp()}.csv`);
  }

  // ── BSA CSV ───────────────────────────────────────────────────

  exportBSACSV(scores) {
    const regions = [
      { key: 'head',       label: 'Head & Neck',  weight: 0.1 },
      { key: 'trunk',      label: 'Trunk',         weight: 0.3 },
      { key: 'upperLimbs', label: 'Upper Limbs',   weight: 0.2 },
      { key: 'lowerLimbs', label: 'Lower Limbs',   weight: 0.4 },
    ];

    let csv = 'region,bsa_percent,easi_weight,weighted_bsa\n';
    for (const r of regions) {
      const bsa      = scores[r.key] ?? 0;
      const weighted = bsa * r.weight;
      csv += `${r.label},${bsa.toFixed(2)},${r.weight},${weighted.toFixed(2)}\n`;
    }
    const total = scores.total ?? 0;
    csv += `Total,-,-,${total.toFixed(2)}\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    this._download(blob, `ADimpact_bsa_${this._timestamp()}.csv`);
  }

  // ── Export All ────────────────────────────────────────────────

  async exportAll(scores) {
    await this.exportPNG(scores);
    // Slight delay between downloads so browser handles them
    await new Promise(r => setTimeout(r, 300));
    this.exportStrokeCSV();
    await new Promise(r => setTimeout(r, 300));
    this.exportBSACSV(scores);
  }
}
