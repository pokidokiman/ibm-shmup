extends Node2D

## Powerup pickup — upgrade player weapon or bonus points.

var type: String = "p"  # "p" = power, "b" = bomb

func _ready() -> void:
	add_to_group("powerups")
	# Pulsing animation
	var tween := create_tween().set_loops()
	tween.tween_property(self, "modulate:a", 0.6, 0.4)
	tween.tween_property(self, "modulate:a", 1.0, 0.4)

func _process(delta: float) -> void:
	position.y += 100.0 * delta
	var vp := get_viewport_rect()
	if position.y > vp.size.y + 20:
		queue_free()

func collect() -> void:
	if type == "p":
		if GameManager.power_level < GameManager.MAX_POWER:
			GameManager.power_level += 1
		else:
			GameManager.add_score(500)
	AudioManager.play_powerup(global_position)
	SignalBus.powerup_collected.emit(type)
	queue_free()
