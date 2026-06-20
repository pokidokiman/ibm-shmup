shader_type canvas_item;

// IBM 5153 CRT Monitor Simulation (Godot 4.x)
// Barrel distortion, chromatic aberration, scanlines, vignette,
// phosphor glow/bloom, raster tear effect.

uniform float barrel_power : hint_range(0.0, 2.0) = 1.2;
uniform float scanline_intensity : hint_range(0.0, 0.7) = 0.15;
uniform float vignette_intensity : hint_range(0.0, 1.0) = 0.6;
uniform float phosphor_green : hint_range(0.0, 1.0) = 0.85;
uniform float aberration_strength : hint_range(0.001, 0.01) = 0.002;

// Bloom / phosphor glow (beyond basic tint - bloom-like soft edge bleed)
uniform float phosphor_glow_intensity : hint_range(0.0, 1.0) = 0.4;
uniform int phosphor_glow_taps : hint_range(1, 8) = 4;

// Raster tear effect (animated horizontal clip with scanline displacement)
uniform bool raster_tear_active = false;
uniform float raster_tear_offset = 0.0;
uniform float raster_tear_y = 200.0;
uniform float raster_tear_height = 40.0;

// Time for animated effects (updated every _process by CRTOverlay.gd)
uniform float time : hint_range(0.0, 1000.0) = 0.0;

void fragment() {
    // === 1. Barrel distortion ===
    vec2 uv = UV * 2.0 - 1.0;
    float r = length(uv);
    vec2 curved = uv * (1.0 + barrel_power * r * r);
    vec2 sample_uv = curved * 0.5 + 0.5;

    // Edge clamp - black outside tube
    if (sample_uv.x < 0.0 || sample_uv.x > 1.0 ||
        sample_uv.y < 0.0 || sample_uv.y > 1.0) {
        COLOR = vec4(0.0);
        return;
    }

    // === 2. Chromatic aberration (sub-pixel RGB offset) ===
    float r_offset = aberration_strength;
    float b_offset = -aberration_strength;
    vec4 col;
    col.r = texture(TEXTURE, sample_uv + vec2(r_offset, 0.0)).r;
    col.g = texture(TEXTURE, sample_uv).g;
    col.b = texture(TEXTURE, sample_uv + vec2(b_offset, 0.0)).b;
    col.a = 1.0;

    // === 3. Phosphor green tint (IBM terminal aesthetic) ===
    float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    vec3 green_phosphor = vec3(0.06 * lum, 0.90 * lum, 0.12 * lum);
    col.rgb = mix(col.rgb, green_phosphor, phosphor_green);

    // === 4. Phosphor glow / bloom-like effect ===
    if (phosphor_glow_intensity > 0.0) {
        float search_scale = 1.73;
        float blur_amount = search_scale * 0.0025;
        vec4 glow = vec4(0.0);
        for (int i = 0; i < phosphor_glow_taps; i++) {
            float angle = float(i) * 103.0;
            vec2 offset = vec2(cos(angle), sin(angle)) * blur_amount;
            glow += texture(TEXTURE, sample_uv + offset);
        }
        glow /= float(phosphor_glow_taps);

        // Tint the glow with the same green phosphor mapping
        float glum = dot(glow.rgb, vec3(0.299, 0.587, 0.114));
        glow.rgb = mix(glow.rgb, vec3(0.06 * glum, 0.90 * glum, 0.12 * glum), phosphor_green);

        col.rgb += (glow.rgb - col.rgb) * phosphor_glow_intensity;
    }

    // === 5. Scanlines ===
    float scanline = sin(sample_uv.y * 800.0) * scanline_intensity;
    col.rgb -= scanline;

    // === 6. Vignette (tube edge darkening) ===
    float vig = sample_uv.x * sample_uv.y * (1.0 - sample_uv.x) * (1.0 - sample_uv.y);
    vig = pow(16.0 * vig, 0.4);
    col.rgb *= mix(vec3(1.0), vig, vignette_intensity);

    // === 7. Raster tear effect ===
    if (raster_tear_active) {
        float vy = UV.y * SCREEN_PIXEL_SIZE.y;
        float tear_top = raster_tear_y - (raster_tear_height * 0.5);
        float tear_bottom = raster_tear_y + (raster_tear_height * 0.5);

        if (vy >= tear_top && vy <= tear_bottom) {
            vec2 teared_uv = sample_uv;
            teared_uv.x += raster_tear_offset * SCREEN_PIXEL_SIZE.x * 0.01;

            // Add scanline distortion within the tear region
            float distort = sin(vy * 20.0 + time * 3.0) * 0.005;
            teared_uv.x += distort;

            // Re-sample RGB with aberration for tear region
            vec4 tear_col;
            tear_col.r = texture(TEXTURE, teared_uv + vec2(r_offset, 0.0)).r;
            tear_col.g = texture(TEXTURE, teared_uv).g;
            tear_col.b = texture(TEXTURE, teared_uv + vec2(b_offset, 0.0)).b;
            tear_col.a = col.a;

            // Apply phosphor tint to tear sample too
            float tlum = dot(tear_col.rgb, vec3(0.299, 0.587, 0.114));
            tear_col.rgb = mix(tear_col.rgb, vec3(0.06 * tlum, 0.90 * tlum, 0.12 * tlum), phosphor_green);

            // Blend with original scanline + vignette applied
            col.rgb = tear_col.rgb;
        }
    }

    // Gamma adjustment to mimic CRT response curve (~2.2 phosphor)
    col.rgb = pow(col.rgb, vec3(0.85));

    COLOR = col;
}
