extends CanvasLayer

## CRT overlay — applies the CRT shader as a full-screen post-processing effect.
## Also handles screen shake and raster tear via shader parameters.

@onready var crt_rect := $ColorRect
var crt_material: ShaderMaterial

var shake_intensity: float = 0.0
var raster_tear_active: bool = false
var raster_tear_timer: float = 0.0

func _ready() -> void:
	crt_material = crt_rect.material as ShaderMaterial
	if crt_material:
		crt_material.set_shader_parameter("time", 0.0)

func _process(delta: float) -> void:
	if crt_material:
		crt_material.set_shader_parameter("time", crt_material.get_shader_parameter("time") + delta)
	
	# Screen shake decay
	if shake_intensity > 0.0:
		shake_intensity *= 0.85
		if shake_intensity < 0.3:
			shake_intensity = 0.0
			crt_rect.offset = Vector2.ZERO
		else:
			crt_rect.offset = Vector2(
				(randf() - 0.5) * shake_intensity * 6.0,
				(randf() - 0.5) * shake_intensity * 4.0
			)
	
	# Raster tear decay
	if raster_tear_active:
		raster_tear_timer -= delta
		if raster_tear_timer <= 0.0:
			raster_tear_active = false
			_set_tear(false, 0.0, 0.0)

func trigger_shake(intensity: float = 1.0) -> void:
	shake_intensity = maxf(shake_intensity, intensity)

func trigger_raster_tear() -> void:
	raster_tear_active = true
	raster_tear_timer = 0.4
	_set_tear(true, randf_range(-100.0, 100.0), 200.0 + randf_range(-60.0, 60.0))

func _set_tear(active: bool, offset: float, y: float) -> void:
	if not crt_material:
		return
	crt_material.set_shader_parameter("raster_tear_active", active)
	crt_material.set_shader_parameter("raster_tear_offset", offset)
	crt_material.set_shader_parameter("raster_tear_y", y)
