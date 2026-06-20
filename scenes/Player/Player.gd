extends CharacterBody2D

var speed: float = 300.0
var fire_rate: float = 0.1
var invincibility_duration: float = 2.0

var power_level: int = 1: set = _set_power_level
var invincible: bool = false

@onready var bullet_scene = preload("res://scenes/Bullets/Bullet.tscn")
@onready var bullet_container: Node = get_node("/root/Game/BulletContainer")
@onready var collision: CollisionShape2D = $CollisionShape2D
@onready var fire_timer: Timer = $FireTimer

var screen_size: Vector2

func _ready() -> void:
	screen_size = get_viewport_rect().size
	SignalBus.player_power_changed.connect(_on_power_changed)
	SignalBus.game_state_changed.connect(_on_game_state_changed)
	fire_timer.wait_time = fire_rate
	set_process(false)

func _on_game_state_changed(state_name: String) -> void:
	match state_name:
		"PLAYING":
			set_process(true)
			set_physics_process(true)
			show()
			position = Vector2(screen_size.x * 0.5, screen_size.y - 120)
		_:
			set_process(false)
			set_physics_process(false)

func _process(delta: float) -> void:
	if Input.is_action_pressed("shoot") and fire_timer.is_stopped():
		_fire()
		fire_timer.start()

func _physics_process(delta: float) -> void:
	var move_x := Input.get_axis("move_left", "move_right")
	var move_y := Input.get_axis("move_up", "move_down")
	velocity = Vector2(move_x, move_y) * speed
	move_and_slide()
	global_position = global_position.clamp(
		Vector2(16, 16),
		screen_size - Vector2(16, 16)
	)

func _fire() -> void:
	var b = bullet_scene.instantiate()
	b.global_position = global_position + Vector2(0, -20)
	bullet_container.add_child(b)
	
	if power_level >= 2:
		var bl = bullet_scene.instantiate()
		bl.global_position = global_position + Vector2(-14, -14)
		bl.velocity.x = -60
		bullet_container.add_child(bl)
		
		var br = bullet_scene.instantiate()
		br.global_position = global_position + Vector2(14, -14)
		br.velocity.x = 60
		bullet_container.add_child(br)
	
	if power_level >= 4:
		var bl2 = bullet_scene.instantiate()
		bl2.global_position = global_position + Vector2(-8, -24)
		bl2.velocity = Vector2(0, -500)
		bullet_container.add_child(bl2)
		
		var br2 = bullet_scene.instantiate()
		br2.global_position = global_position + Vector2(8, -24)
		br2.velocity = Vector2(0, -500)
		bullet_container.add_child(br2)
	
	AudioManager.play_shoot(global_position)

func hit() -> void:
	if invincible:
		return
	GameManager.player_hit()
	_start_invincibility()

func _start_invincibility() -> void:
	invincible = true
	collision.set_deferred("disabled", true)
	var tween := create_tween()
	tween.tween_method(_blink_toggle, 0.0, 1.0, invincibility_duration)
	tween.tween_callback(_end_invincibility)

func _blink_toggle(val: float) -> void:
	modulate.a = 1.0 if sin(val * PI * 20) > 0 else 0.3

func _end_invincibility() -> void:
	invincible = false
	collision.disabled = false
	modulate.a = 1.0

func _on_power_changed(level: int) -> void:
	power_level = level
	_update_sprite()

func _set_power_level(v: int) -> void:
	power_level = v
	_update_sprite()

func _update_sprite() -> void:
	match power_level:
		1: modulate = Color(0.4, 1.0, 0.4)
		2: modulate = Color(0.6, 1.0, 0.6)
		3: modulate = Color(0.8, 1.0, 0.3)
		4: modulate = Color(1.0, 1.0, 0.2)

func _on_area_entered(area: Area2D) -> void:
	if area.is_in_group("enemy_bullets"):
		hit()
	elif area.is_in_group("enemies"):
		hit()
	elif area.is_in_group("powerups"):
		area.collect()

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("bomb") and GameManager.state == GameManager.GameState.PLAYING:
		var bullets := get_tree().get_nodes_in_group("enemy_bullets")
		for b in bullets:
			b.queue_free()

