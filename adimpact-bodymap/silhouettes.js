/**
 * silhouettes.js
 * SVG path data. ViewBox 0 0 200 400 for front/back, 0 0 200 300 for head detail.
 *
 * Region colour encoding (region-map.js):
 *   Head & Neck  → red   [255,0,0]
 *   Trunk        → green [0,255,0]
 *   Upper Limbs  → blue  [0,0,255]
 *   Lower Limbs  → yellow[255,255,0]
 *
 * The four region paths must together tile the entire silhouette with no gaps.
 * Trunk includes the shoulder-slope trapezoid between neck and armpits.
 * Arms (upper limbs) are the full arm shapes hanging beside the trunk.
 */

// ─── Shared body outline (front & back are near-identical shapes) ────────────
//
// Anatomical proportions (200×400 viewBox):
//   Head ellipse: cx=100 cy=30 rx=21 ry=24  (y: 6–54)
//   Neck: y=54–70, width 24 (x: 88–112)
//   Shoulder tips: left (38,86)  right (162,86)
//   Armpits: left (62,98)  right (138,98)
//   Waist: x=67–133  y=162
//   Hips: x=62–138   y=195
//   Groin: y=218
//   Knee: y=286
//   Ankle: y=348
//   Foot: y=368

const _BODY_OUTLINE = `
  M 100 6
  C 121 6 131 17 131 30
  C 131 45 121 54 109 56
  C 109 60 111 64 112 70
  C 126 73 150 80 162 88
  C 172 95 178 112 178 132
  C 178 152 172 172 165 192
  C 159 208 155 220 155 228
  C 154 232 152 236 149 237
  C 146 238 143 236 142 231
  C 141 226 143 216 146 202
  C 149 188 150 172 148 156
  C 146 140 140 126 138 110
  C 137 102 136 95 134 88
  C 130 98 132 130 132 162
  C 132 178 134 194 136 208
  C 138 218 140 230 140 252
  C 140 278 140 308 138 338
  C 137 350 135 358 133 364
  C 136 366 140 370 148 372
  C 155 372 160 370 158 364
  C 156 358 152 350 120 350
  C 120 340 120 308 120 278
  C 120 256 118 238 116 220
  C 110 222 100 224 90 222
  C 84 238 80 256 80 278
  C 80 308 80 340 80 350
  C 48 350 44 358 42 364
  C 40 370 45 372 52 372
  C 60 372 64 368 67 364
  C 65 358 63 350 62 338
  C 60 308 60 278 60 252
  C 60 230 62 218 64 208
  C 66 194 68 178 68 162
  C 68 130 70 98 66 88
  C 64 95 63 102 62 110
  C 60 126 54 140 52 156
  C 50 172 51 188 54 202
  C 57 216 59 226 58 231
  C 57 236 54 238 51 237
  C 48 236 46 232 45 228
  C 45 220 41 208 35 192
  C 28 172 22 152 22 132
  C 22 112 28 95 38 88
  C 50 80 74 73 88 70
  C 89 64 91 60 91 56
  C 79 54 69 45 69 30
  C 69 17 79 6 100 6
  Z
`;

// Dashed boundary lines shown on the display silhouette
const _FRONT_BOUNDARIES = [
  // 1. Neck base — separates Head & Neck from Trunk
  { d: 'M 88 70 Q 100 74 112 70' },
  // 2. Left armpit — separates left arm from trunk (angled line)
  { d: 'M 62 98 L 68 88' },
  // 3. Right armpit — separates right arm from trunk
  { d: 'M 138 98 L 132 88' },
  // 4. Hip/groin — separates Trunk from Lower Limbs
  { d: 'M 64 208 Q 100 222 136 208' },
];

// ─── Region paths (for the hidden region-map canvas) ─────────────────────────
//
// Head+Neck region:  head ellipse + neck column, closed at y=70
// Trunk region:      shoulder trapezoid + torso, from y=70 to groin y=218
// Upper limbs:       two arm shapes, from shoulder tips to hands and back up to armpits
// Lower limbs:       two leg shapes, from hip/groin down to feet

const _HEAD_REGION = `
  M 100 6
  C 121 6 131 17 131 30
  C 131 45 121 54 109 56
  C 109 60 111 64 112 70
  L 88 70
  C 89 64 91 60 91 56
  C 79 54 69 45 69 30
  C 69 17 79 6 100 6
  Z
`;

// Trunk: from neck base to groin, between the two armpits.
// Top boundary: straight line y=70 (neck base).
// Side boundaries: from neck-shoulder junction → armpit → down torso sides.
// Bottom boundary: groin curve at y=218.
const _TRUNK_REGION = `
  M 88 70
  L 112 70
  C 126 73 150 80 162 88
  L 134 88
  C 130 98 132 130 132 162
  C 132 178 134 194 136 208
  L 116 220
  C 110 222 100 224 90 222
  L 64 208
  C 66 194 68 178 68 162
  C 68 130 70 98 66 88
  L 38 88
  C 50 80 74 73 88 70
  Z
`;

// Left arm (visual left = image x<100):
// Outer edge: from shoulder tip (38,88) downward.
// Inner edge: from armpit (62,98) downward (same side, inner).
// Both meet at the hand.
const _LEFT_ARM_REGION = `
  M 38 88
  L 62 98
  C 58 114 54 138 52 156
  C 50 172 51 188 54 202
  C 57 216 59 226 58 231
  C 57 236 54 238 51 237
  C 48 236 46 232 45 228
  C 45 220 41 208 35 192
  C 28 172 22 152 22 132
  C 22 112 28 95 38 88
  Z
`;

// Right arm (visual right = image x>100):
const _RIGHT_ARM_REGION = `
  M 162 88
  L 138 98
  C 142 114 146 138 148 156
  C 150 172 149 188 146 202
  C 143 216 141 226 142 231
  C 143 236 146 238 149 237
  C 152 236 154 232 155 228
  C 155 220 159 208 165 192
  C 172 172 178 152 178 132
  C 178 112 172 95 162 88
  Z
`;

// Left leg:
const _LEFT_LEG_REGION = `
  M 64 208
  L 90 222
  L 80 278
  L 80 340
  L 80 350
  L 67 364
  L 52 372
  L 45 372
  L 42 364
  L 60 350
  L 60 278
  L 60 252
  L 62 218
  Z
`;

// Right leg:
const _RIGHT_LEG_REGION = `
  M 136 208
  L 110 222
  L 120 278
  L 120 340
  L 120 350
  L 133 364
  L 148 372
  L 155 372
  L 158 364
  L 140 350
  L 140 278
  L 140 252
  L 138 218
  Z
`;

// ─── Exported SILHOUETTES object ─────────────────────────────────────────────

const SILHOUETTES = {

  front: {
    viewBox: '0 0 200 400',
    outline: _BODY_OUTLINE,
    details: null,
    regionBoundaries: _FRONT_BOUNDARIES,
    regions: {
      head:       _HEAD_REGION,
      trunk:      _TRUNK_REGION,
      upperLimbs: _LEFT_ARM_REGION + _RIGHT_ARM_REGION,
      lowerLimbs: _LEFT_LEG_REGION + _RIGHT_LEG_REGION,
    },
  },

  back: {
    viewBox: '0 0 200 400',
    outline: _BODY_OUTLINE,
    details: null,
    regionBoundaries: _FRONT_BOUNDARIES,
    regions: {
      head:       _HEAD_REGION,
      trunk:      _TRUNK_REGION,
      upperLimbs: _LEFT_ARM_REGION + _RIGHT_ARM_REGION,
      lowerLimbs: _LEFT_LEG_REGION + _RIGHT_LEG_REGION,
    },
  },

  // Head & Neck detail view — enlarged, maps 100% to head EASI region
  headNeck: {
    viewBox: '0 0 200 300',

    // Enlarged head+neck+upper shoulders, fit in 200×300
    outline: `
      M 100 10
      C 126 10 144 26 144 52
      C 144 78 128 94 112 100
      C 111 106 113 114 116 120
      C 132 126 158 136 172 148
      C 180 156 184 166 184 180
      C 184 194 178 204 170 210
      C 162 216 150 220 136 224
      C 122 228 112 230 100 230
      C 88 230 78 228 64 224
      C 50 220 38 216 30 210
      C 22 204 16 194 16 180
      C 16 166 20 156 28 148
      C 42 136 68 126 84 120
      C 87 114 89 106 88 100
      C 72 94 56 78 56 52
      C 56 26 74 10 100 10
      Z
    `,

    // Subtle facial features for the detail view
    details: `
      M 80 56 C 80 50 86 48 90 52 C 94 56 92 62 88 62 C 84 62 80 60 80 56 Z
      M 110 56 C 110 50 116 48 120 52 C 124 56 122 62 118 62 C 114 62 110 60 110 56 Z
      M 88 78 C 92 82 100 84 100 84 C 100 84 108 82 112 78
      M 84 95 C 90 100 100 102 100 102 C 100 102 110 100 116 95
    `,

    regionBoundaries: [],

    regions: {
      head: `
        M 100 10
        C 126 10 144 26 144 52
        C 144 78 128 94 112 100
        C 111 106 113 114 116 120
        C 132 126 158 136 172 148
        C 180 156 184 166 184 180
        C 184 194 178 204 170 210
        C 162 216 150 220 136 224
        C 122 228 112 230 100 230
        C 88 230 78 228 64 224
        C 50 220 38 216 30 210
        C 22 204 16 194 16 180
        C 16 166 20 156 28 148
        C 42 136 68 126 84 120
        C 87 114 89 106 88 100
        C 72 94 56 78 56 52
        C 56 26 74 10 100 10
        Z
      `,
      trunk: null,
      upperLimbs: null,
      lowerLimbs: null,
    },
  },
};
