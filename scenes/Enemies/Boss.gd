extends CharacterBody2D

@export var speed: float = 80.0

var hp: int
var max_hp: int
var score_value: int = 2000
var _phase: int = 0
var _time: float = 0.0
var _shoot_cooldown: float = 0.0
var _entered: bool = false

@onready var shoot_scene := preload("res://scenes/Bullets/EnemyBullet.tscn")
@onready var bullet_container: Node = get_node("/root/Game/EnemyBulletContainer")

func _ready() -> void:
	add_to_group("enemies")
	max_hp = 30 + GameManager.wave * 10
	hp = max_hp
	score_value = 2000 + GameManager.wave * 500
	global_position.x = get_viewport_rect().size.x * 0.5
	SignalBus.boss_spawned.emit()

func take_damage(amount: int) -> void:
	hp -= amount
	modulate = Color(1.0, 0.8, 0.8)
	var t := create_tween()
	t.tween_property(self, "modulate", Color.WHITE, 0.08)
	SignalBus.boss_hp_changed.emit(hp, max_hp)
	
	if hp <= 0:
		_die()
	else:
		AudioManager.play_hit(global_position)

func _die() -> void:
	GameManager.add_score(score_value)
	AudioManager.play_explode(global_position)
	SignalBus.boss_destroyed.emit()
	queue_free()

func _physics_process(delta: float) -> void:
	_time += delta
	
	if not _entered:
		global_position.y -= 30.0 * delta
		if global_position.y <= 80:
			_entered = true
		return
	
	var vp := get_viewport_rect()
	var origin_x := vp.size.x * 0.5
	global_position.x = origin_x + sin(_time * 0.8) * (vp.size.x * 0.3)
	global_position.y = 80 + sin(_time * 1.2) * 30
	
	var hp_ratio := float(hp) / float(max_hp)
	if hp_ratio < 0.3:
		_phase = 3
	elif hp_ratio < 0.6:
		_phase = 2
	elif _phase == 0:
		_phase = 1
	
	_shoot_cooldown -= delta
	if _shoot_cooldown <= 0:
		match _phase:
			1:
				for a in range(-2, 3):
					var b := shoot_scene.instantiate()
					b.global_position = global_position + Vector2(a * 15, 30)
					b.speed = 140.0
					b.rotation = a * 0.25
					bullet_container.add_child(b)
				_shoot_cooldown = 1.5
			2:
				var player := get_node_or_null("/root/Game/Player")
				if player:
					var dir_vec: Vector2 = (player.global_position - global_position).normalized()
					for a in range(-1, 2):
						var b := shoot_scene.instantiate()
						b.global_position = global_position + Vector2(a * 15, 30)
						var rot_vec: Vector2 = dir_vec.rotated(a * 0.3)
						b.velocity = rot_vec * 200.0
						bullet_container.add_child(b)
				_shoot_cooldown = 0.8
			3:
				for a in range(-2, 3):
					var b := shoot_scene.instantiate()
					b.global_position = global_position + Vector2(a * 12, 30)
					b.speed = 180.0 + a * 20
					bullet_container.add_child(b)
				_shoot_cooldown = 0.4

