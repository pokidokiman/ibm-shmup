shader_type canvas_item;

// IBM 5153 CRT Monitor Simulation
// Barrel distortion, scanlines, chromatic aberration, vignette, phosphor glow

uniform float barrel_power : hint_range(0.0, 2.0) = 1.5;
uniform float scanline_intensity : hint_range(0.0, 0.7) = 0.35;
uniform float vignette_intensity : hint_range(0.0, 1.0) = 0.8;
uniform float phosphor_brightness : hint_range(0.0, 1.0) = 0.85;
uniform float phosphor_warmth : hint_range(0.0, 1.0) = 0.6;
// phosphor_warmth: 0.0=pure green (IBM amber), 1.0=wash out to white. 0.6=classic IBM green glow.

void fragment() {
	vec2 uv = UV;

	// === Barrel distortion (screen curves like a tube) ===
	vec2 centered = uv * 2.0 - 1.0;
	float r = length(centered);
	vec2 curved = centered * (1.0 + barrel_power * r * r);
	vec2 sample_uv = curved * 0.5 + 0.5;

	// Edge clamp — black outside tube
	if (sample_uv.x < 0.0 || sample_uv.x > 1.0 || sample_uv.y < 0.0 || sample_uv.y > 1.0) {
		COLOR = vec4(0.0);
		return;
	}

	// === Sample texture ===
	vec4 tex = texture(TEXTURE, sample_uv);

	// === Convert to luminance (grayscale) ===
	float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));

	// === Map luminance to IBM green phosphor color ===
	// Classic P2/P31 monochrome: nearly pure green with slight blue tint on dark pixels.
	vec3 pureGreen = vec3(0.0, 1.0, 0.0);
	vec3 warmWhite = vec3(0.85, 0.95, 0.75);
	// Bright pixels go toward green phosphor peak, dark pixels slightly cooler/dimmer
	vec3 phosphorColor = mix(vec3(0.0), pureGreen, phosphor_brightness);
	phosphorColor = mix(phosphorColor, warmWhite, (1.0 - phosphor_brightness) * phosphor_warmth);

	// Final green monochrome — luminance modulates the phosphor intensity
	vec3 col = lum * phosphorColor;

	// Add subtle glow: bloom-like effect via second read at slightly offset UV
	// Simulates phosphor bleeding on old monitors
	float glowIntensity = 0.12;
	vec4 blurTex = texture(TEXTURE, sample_uv + vec2(0.002, 0.002));
	float blurLum = dot(blurTex.rgb, vec3(0.299, 0.587, 0.114));
	col += blurLum * phosphorColor * glowIntensity;

	// === Scanlines (horizontal lines — classic CRT raster) ===
	float scanline = sin(sample_uv.y * SCREEN_PIXEL_SIZE.y * 3.14159);
	scanline = mix(1.0, pow(scanline + 0.5, 2.0), scanline_intensity);
	col *= scanline;

	// === Vignette (tube edge darkening) ===
	float vig = sample_uv.x * sample_uv.y * (1.0 - sample_uv.x) * (1.0 - sample_uv.y);
	vig = pow(16.0 * vig, 0.25);
	col *= mix(vec3(1.0), vig, vignette_intensity);

	// Gamma adjustment to mimic CRT response curve (~2.2 display on phosphor)
	col = pow(col, vec3(0.85));

	COLOR = vec4(col, tex.a);
}
