shader_type canvas_item;

// Matrix rain effect for title screen
// Falling katakana/ASCII characters with trail glow

uniform float speed : hint_range(0.1, 2.0) = 0.8;
uniform float intensity : hint_range(0.0, 1.0) = 0.5;
uniform float time : hint_range(0.0, 100.0) = 0.0;

// Pseudo-random character selection per pixel column
float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void fragment() {
	vec4 base = texture(TEXTURE, UV);
	
	// Column width ~17px
	float col_width = 17.0 / SCREEN_PIXEL_SIZE.x;
	float row_height = 17.0 / SCREEN_PIXEL_SIZE.y;
	
	float col = floor(UV.x / col_width);
	float row = floor(UV.y / row_height);
	
	// Offset per column for staggered rain
	float offset = hash(vec2(col, 0.0)) * 100.0;
	float drop_pos = fract((time * speed + offset - row * 0.5) / 10.0) * 10.0;
	
	float brightness = 0.0;
	
	// Bright head of drop
	if (drop_pos < 1.0 && abs(UV.y / row_height - floor(UV.y / row_height) - 0.5) < 0.45) {
		brightness = 0.3 * intensity;
	}
	// Dim trail
	if (drop_pos > 1.0 && drop_pos < 4.0 && abs(UV.y / row_height - floor(UV.y / row_height) - 0.5) < 0.45) {
		brightness = 0.08 * intensity * (1.0 - (drop_pos - 1.0) / 3.0);
	}
	
	// Random character visibility per cell
	float visible = hash(vec2(col, floor(UV.y / row_height))) > 0.3 ? 1.0 : 0.0;
	brightness *= visible;
	
	vec3 rain_color = vec3(0.0, brightness, 0.0);
	
	COLOR = mix(base, vec4(rain_color, 1.0), brightness);
}
