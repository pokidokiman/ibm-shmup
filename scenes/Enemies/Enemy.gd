class_name EnemyBase
extends CharacterBody2D

enum EnemyType { SCOUT = 0, TANK = 1, ELITE = 2 }

static func type_data(type: EnemyType) -> Dictionary:
	match type:
		EnemyType.SCOUT:
			return {hp=1, speed=120.0, score=100, shoot_rate=1.5, glyph=["╱╲","││","╲╱"]}
		EnemyType.TANK:
			return {hp=2, speed=100.0, score=200, shoot_rate=1.8, glyph=["┌┐","│├┤│","└┘"]}
		EnemyType.ELITE:
			return {hp=4, speed=90.0, score=400, shoot_rate=2.2, glyph=["┌┬┐","│├┼┤│","└┴┘"]}
	return type_data(EnemyType.SCOUT)

@export var enemy_type: EnemyType = EnemyType.SCOUT
@export var movement_pattern: String = "d"
@export var speed_mult: float = 1.0

var hp: int
var max_hp: int
var score_value: int
var shoot_rate: float
var _spawn_pos: Vector2
var _time: float = 0.0
var _shoot_cooldown: float = 0.0

@onready var shoot_scene := preload("res://scenes/Bullets/EnemyBullet.tscn")
@onready var bullet_container: Node = get_node("/root/Game/EnemyBulletContainer")

func _ready() -> void:
	add_to_group("enemies")
	var td := type_data(enemy_type)
	hp = td.hp
	max_hp = td.hp
	score_value = td.score
	shoot_rate = td.shoot_rate
	_spawn_pos = global_position

func take_damage(amount: int) -> void:
	hp -= amount
	modulate = Color.WHITE
	var t := create_tween()
	t.tween_property(self, "modulate", Color(0.3, 1.0, 0.3), 0.08)
	
	if hp <= 0:
		_die()
	else:
		AudioManager.play_hit(global_position)
		GameManager.add_combo()

func _die() -> void:
	GameManager.add_score(score_value)
	AudioManager.play_explode(global_position)
	if randf() < 0.12:
		var pup := preload("res://scenes/Powerup.tscn").instantiate()
		pup.global_position = global_position
		get_node("/root/Game/PowerupContainer").add_child(pup)
	queue_free()

func _physics_process(delta: float) -> void:
	_time += delta
	
	match movement_pattern:
		"sin":
			global_position.x = _spawn_pos.x + sin(_time * 1.5) * 90.0
			global_position.y += speed_mult * 60.0 * delta
		"zig":
			global_position.x += sin(_time * 6.0) * 2.0
			global_position.y += speed_mult * 80.0 * delta
		"duik":
			if _time < 1.0:
				global_position.y += speed_mult * 40.0 * delta
				global_position.x += sin(_time * 3.0) * 1.5
			else:
				global_position.y += speed_mult * 150.0 * delta
		"snell":
			global_position.y += speed_mult * 120.0 * delta
		_:
			global_position.y += speed_mult * 60.0 * delta
	
	_shoot_cooldown -= delta
	if _shoot_cooldown <= 0.0 and global_position.y > 20 and global_position.y < get_viewport_rect().size.y * 0.5:
		var b := shoot_scene.instantiate()
		b.global_position = global_position + Vector2(0, 16)
		bullet_container.add_child(b)
		_shoot_cooldown = shoot_rate
	
	var vp := get_viewport_rect()
	if global_position.y > vp.size.y + 40 or global_position.x < -80 or global_position.x > vp.size.x + 80:
		queue_free()

