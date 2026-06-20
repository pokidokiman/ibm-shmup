shader_type canvas_item;

// =============================================================================
// Matrix Rain Shader — Authentic Katakana / ASCII-style character column rain
// =============================================================================
// Head: bright white -> white-green transition (1 cell)
// Near trail: bright green, fast drop-off (~2 cells)
// Mid trail:  green  -> dark-green (~5 cells)
// Far tail:   dark-green -> black     (~13 cells)
// Per-column speed variation + per-cell glyph rendering inside a dot-matrix.
// =============================================================================

uniform float speed     : hint_range(0.1, 2.0) = 0.8;
uniform float intensity  : hint_range(0.0, 1.0) = 0.5;
uniform float time       : hint_range(0.0, 100.0) = 0.0;

// --- hash helpers -----------------------------------------------------------

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453);
}

// --- glyph engines ----------------------------------------------------------

// Glyph style A: sparse "letter-like" dot matrix (5x5 sub-grid)
float glyph_a(vec2 uv, float seed) {
    vec2 g = floor(uv * 5.0);
    float v = hash(g + seed * 100.0);
    float h = step(0.30, v);                        // horizontal streak bias
    float vb = abs(g.y - 2.0) < 1.5 ? -0.10 : 0.15;  // top/bottom heavier
    return step(0.75 - float(h), v + vb);
}

// Glyph style B: dense Katakana-like block (6x6 sub-grid)
float glyph_b(vec2 uv, float seed) {
    vec2 g = floor(uv * 6.0);
    float v1 = hash(g     + seed * 73.0);
    float v2 = hash2(g.yx + seed * 47.0);
    return step(0.45, (v1 + v2) * 0.5);
}

// Pick a glyph value based on which style we prefer for this column.
float pick_glyph(vec2 uv, float cid, float col) {
    // Every third column uses dense glyphs; others use letter-style.
    if (mod(col, 3.0) > 2.0)
        return glyph_b(uv, cid);
    else
        return glyph_a(uv, cid);
}

// --- fragment ---------------------------------------------------------------

void fragment() {
    vec4 base = texture(TEXTURE, UV);

    // Grid sizing (approx. 17 px per character cell)
    float cw  = 17.0 / SCREEN_PIXEL_SIZE.x;
    float chr = 17.0 / SCREEN_PIXEL_SIZE.y;

    float col = floor(UV.x / cw);
    float row = floor(UV.y / chr);
    vec2 cuv = fract(vec2(UV.x / cw, UV.y / chr));   // [0..1] inside cell

    // Per-column randomness (hash needs vec2, pass col as x component)
    float cs  = hash(vec2(col, 0.0));              // identity        [0,1)
    float csm = 0.5 + cs;                          // speed multiplier [0.5,1.5]
    float co  = hash2(vec2(col, 7.0)) * 200.0;     // initial offset
    float crs = hash2(vec2(col, 91.0)) * 30.0;     // reset buffer per column

    // Head row index (continuous, wraps)
    float num_rows = SCREEN_PIXEL_SIZE.y / chr + crs;
    float head_y = mod(time * speed * csm * 3.0 + co, num_rows);

    float rd = row - head_y;                 // 0 = at head, >0 = trail behind

    const float TL = 20.0;                   // trail length in cells

    vec3 col_rain = vec3(0.0);
    float br = 0.0;

    if (rd >= -0.5 && rd < TL) {
        // Character id for seed variation per cell (time-based flicker)
        float cid_base = hash(vec2(col, row + col * 0.5));
        float flicker = hash(vec2(col + row * 37.0 + floor(time * 4.0), 101.0));
        float cid = cid_base + step(0.90, flicker) * 42.0;

        // ---------- colour gradient across trail -----------

        if (rd >= -0.5 && rd < 0.5) {
            // HEAD: white -> green over 1 cell
            float t = max(0.0, rd) * 2.0;
            col_rain = mix(vec3(1.0), vec3(0.0, 1.0, 0.0), smoothstep(0.0, 1.0, t));
            br = intensity;

        } else if (rd < 2.5) {
            // Bright green, soft fade
            col_rain = vec3(0.0, 1.0, 0.0);
            br = intensity * (1.0 - (rd - 0.5) / 4.0);

        } else if (rd < 8.0) {
            // Mid-trail: green -> dark green
            float t = (rd - 2.5) / 5.5;
            col_rain = mix(vec3(0.0, 1.0, 0.0), vec3(0.0, 0.4, 0.0), smoothstep(0.0, 1.0, t));
            br = intensity * (1.0 - t * 0.7);

        } else {
            // Far tail: dark green -> black
            float t = (rd - 8.0) / max(TL - 8.0, 1.0);
            col_rain = mix(vec3(0.0, 0.4, 0.0), vec3(0.0), smoothstep(0.0, 1.0, t));
            br = intensity * (1.0 - t) * 0.35;
        }

        // ---------- glyph overlay inside cell --------------

        float mrg = 0.08;
        vec2 iuv = (cuv - mrg) / (1.0 - 2.0 * mrg);

        float gv = 0.0;
        if (iuv.x >= 0.0 && iuv.x <= 1.0 && iuv.y >= 0.0 && iuv.y <= 1.0) {
            gv = pick_glyph(iuv, cid, col);
        }

        // Keep some base brightness even on "gaps" so the column is still visible
        br *= mix(0.35, 1.0, gv);

        // ---------- head glow ------------------------------

        if (rd >= -0.5 && rd < 2.0) {
            float gw = smoothstep(2.0, -0.5, rd);
            col_rain += vec3(gw * 0.15, gw * 0.25, gw * 0.1);
        }
    }

    col_rain *= br;

    COLOR = vec4(col_rain + base.rgb * base.a, 1.0);
}
