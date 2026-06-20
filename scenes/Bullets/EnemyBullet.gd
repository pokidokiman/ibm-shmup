extends Area2D

## Enemy bullet — moves downward, damages player on contact.

@export var speed: float = 150.0

func _ready() -> void:
	add_to_group("enemy_bullets")

func _physics_process(delta: float) -> void:
	global_position.y += speed * delta
	
	var vp := get_viewport_rect()
	if global_position.y > vp.size.y + 20 or global_position.x < -20 or global_position.x > vp.size.x + 20:
		queue_free()
