/**
 * region-map.js
 * Builds hidden off-screen canvases that encode EASI region membership
 * as unique colours. Used exclusively for BSA% calculation.
 *
 * Colour encoding:
 *   Head & Neck  → [255,   0,   0, 255]  (red)
 *   Trunk        → [  0, 255,   0, 255]  (green)
 *   Upper Limbs  → [  0,   0, 255, 255]  (blue)
 *   Lower Limbs  → [255, 255,   0, 255]  (yellow)
 *
 * The head & neck detail view maps every pixel → red (head).
 *
 * BSA head/neck overlap rule:
 *   If any strokes exist in the headNeck detail view, use those pixels
 *   for the head/neck BSA calculation instead of the front view's head
 *   region. This prevents double-counting.
 */

const REGION_COLORS = {
  head:       [255,   0,   0, 255],
  trunk:      [  0, 255,   0, 255],
  upperLimbs: [  0,   0, 255, 255],
  lowerLimbs: [255, 255,   0, 255],
};

// EASI weights per region
const EASI_WEIGHTS = {
  head:       0.10,
  trunk:      0.30,
  upperLimbs: 0.20,
  lowerLimbs: 0.40,
};

class RegionMap {
  constructor() {
    // One off-screen canvas per view
    this.maps = {
      front:    null,
      back:     null,
      headNeck: null,
    };
    this._ready = false;
  }

  /**
   * Build all three region-map canvases.
   * Must be called after the display canvases are sized.
   * @param {Object} canvasDimensions  { front, back, headNeck } each { width, height, scale, offsetX, offsetY, svgW, svgH }
   */
  build(canvasDimensions) {
    for (const view of ['front', 'back', 'headNeck']) {
      const dim = canvasDimensions[view];
      const canvas = document.createElement('canvas');
      canvas.width  = dim.width;
      canvas.height = dim.height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const sil = SILHOUETTES[view];
      const { scale, offsetX, offsetY } = dim;

      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      if (view === 'headNeck') {
        // Entire silhouette = head & neck
        this._fillRegion(ctx, sil.regions.head, REGION_COLORS.head);
      } else {
        // Draw each region with its colour
        if (sil.regions.head)       this._fillRegion(ctx, sil.regions.head,       REGION_COLORS.head);
        if (sil.regions.trunk)      this._fillRegion(ctx, sil.regions.trunk,       REGION_COLORS.trunk);
        if (sil.regions.upperLimbs) this._fillRegion(ctx, sil.regions.upperLimbs, REGION_COLORS.upperLimbs);
        if (sil.regions.lowerLimbs) this._fillRegion(ctx, sil.regions.lowerLimbs, REGION_COLORS.lowerLimbs);
      }

      ctx.restore();
      this.maps[view] = canvas;
    }
    this._ready = true;
  }

  _fillRegion(ctx, pathStr, color) {
    if (!pathStr) return;
    const [r, g, b, a] = color;
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    const path = new Path2D(pathStr);
    ctx.fill(path);
  }

  /**
   * Identify which region a pixel belongs to in a given view.
   * @returns {string|null} 'head'|'trunk'|'upperLimbs'|'lowerLimbs'|null
   */
  getRegionAtPixel(view, px, py) {
    if (!this._ready) return null;
    const canvas = this.maps[view];
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(px, py, 1, 1).data;
    return this._colorToRegion(d[0], d[1], d[2], d[3]);
  }

  _colorToRegion(r, g, b, a) {
    if (a < 128) return null;
    if (r > 200 && g < 50  && b < 50)  return 'head';
    if (r < 50  && g > 200 && b < 50)  return 'trunk';
    if (r < 50  && g < 50  && b > 200) return 'upperLimbs';
    if (r > 200 && g > 200 && b < 50)  return 'lowerLimbs';
    return null;
  }

  /**
   * Calculate BSA% for each EASI region by cross-referencing
   * the drawing canvases against region-map canvases.
   *
   * @param {Object} drawingCanvases  { front, back, headNeck } — actual canvas elements
   * @param {boolean} headNeckHasStrokes — if true, use headNeck view for head BSA
   * @returns {Object} { head, trunk, upperLimbs, lowerLimbs, total, weighted }
   */
  calculate(drawingCanvases, headNeckHasStrokes) {
    if (!this._ready) return this._zeroResult();

    // Gather pixel data for all views
    const data = {};
    for (const view of ['front', 'back', 'headNeck']) {
      const dc = drawingCanvases[view];
      const mc = this.maps[view];
      if (!dc || !mc) continue;
      const w = dc.width, h = dc.height;
      const drawCtx = dc.getContext('2d');
      const mapCtx  = mc.getContext('2d');
      data[view] = {
        draw: drawCtx.getImageData(0, 0, w, h).data,
        map:  mapCtx.getImageData(0, 0, w, h).data,
        w, h,
      };
    }

    // Count pixels
    const counts = {
      head:       { drawn: 0, total: 0 },
      trunk:      { drawn: 0, total: 0 },
      upperLimbs: { drawn: 0, total: 0 },
      lowerLimbs: { drawn: 0, total: 0 },
    };

    // Process front view — skip head if headNeck detail is used
    if (data.front) {
      this._countPixels(data.front, counts, headNeckHasStrokes ? ['head'] : []);
    }
    // Process back view
    if (data.back) {
      this._countPixels(data.back, counts, []);
    }
    // Process headNeck detail — only counts if patient has drawn there
    if (data.headNeck && headNeckHasStrokes) {
      this._countPixels(data.headNeck, counts, []);
    }

    // Compute percentages
    const pct = {};
    for (const region of ['head', 'trunk', 'upperLimbs', 'lowerLimbs']) {
      const { drawn, total } = counts[region];
      pct[region] = total > 0 ? (drawn / total) * 100 : 0;
    }

    const weighted =
      pct.head       * EASI_WEIGHTS.head +
      pct.trunk      * EASI_WEIGHTS.trunk +
      pct.upperLimbs * EASI_WEIGHTS.upperLimbs +
      pct.lowerLimbs * EASI_WEIGHTS.lowerLimbs;

    return {
      head:       pct.head,
      trunk:      pct.trunk,
      upperLimbs: pct.upperLimbs,
      lowerLimbs: pct.lowerLimbs,
      total:      weighted,
    };
  }

  /**
   * Walk through pixel data, tallying drawn and total pixels per region.
   * @param {Object} viewData  { draw, map, w, h }
   * @param {Object} counts    accumulator
   * @param {string[]} skipRegions  regions to exclude from tallying
   */
  _countPixels(viewData, counts, skipRegions) {
    const { draw, map, w, h } = viewData;
    const len = w * h * 4;
    for (let i = 0; i < len; i += 4) {
      const mr = map[i], mg = map[i+1], mb = map[i+2], ma = map[i+3];
      if (ma < 128) continue; // not inside silhouette
      const region = this._colorToRegion(mr, mg, mb, ma);
      if (!region || skipRegions.includes(region)) continue;
      counts[region].total++;
      if (draw[i+3] > 10) counts[region].drawn++;
    }
  }

  _zeroResult() {
    return { head: 0, trunk: 0, upperLimbs: 0, lowerLimbs: 0, total: 0 };
  }

  /**
   * Count total silhouette pixels in a view (for dynamic brush sizing).
   * @param {string} view
   * @returns {number}
   */
  getTotalSilhouettePixels(view) {
    const mc = this.maps[view];
    if (!mc) return 50000; // fallback
    const ctx = mc.getContext('2d');
    const { width, height } = mc;
    const imgData = ctx.getImageData(0, 0, width, height).data;
    let count = 0;
    for (let i = 3; i < imgData.length; i += 4) {
      if (imgData[i] > 128) count++;
    }
    return count || 50000;
  }
}
