extends Parallax2D

## Scrolling parallax background — stars, cityscape, ground strip.

@onready var stars_far: Sprite2D = $StarsFar
@onready var stars_mid: Sprite2D = $StarsMid
@onready var stars_near: Sprite2D = $StarsNear
@onready var city_layer: Sprite2D = $CityLayer
@onready var ground: ColorRect = $Ground

func _ready() -> void:
	# Configure parallax scrolling speeds
	stars_far.motion_scale = Vector2(0.1, 0.1)
	stars_mid.motion_scale = Vector2(0.3, 0.3)
	stars_near.motion_scale = Vector2(0.6, 0.6)
	city_layer.motion_scale = Vector2(0.3, 0.3)
