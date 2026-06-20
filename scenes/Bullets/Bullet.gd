extends Area2D

## Player bullet — moves upward, damages enemies on contact.

@export var speed: float = 400.0
var velocity: Vector2 = Vector2.ZERO

func _ready() -> void:
	add_to_group("player_bullets")
	area_entered.connect(_on_hit_enemy)

func _physics_process(delta: float) -> void:
	global_position += (Vector2(0, -speed) + velocity) * delta
	
	# Off-screen cleanup
	var vp := get_viewport_rect()
	if global_position.y < -20 or global_position.y > vp.size.y + 20 or \
	   global_position.x < -20 or global_position.x > vp.size.x + 20:
		queue_free()

func _on_hit_enemy(area: Area2D) -> void:
	if area.is_in_group("enemies"):
		area.take_damage(1)
		queue_free()
