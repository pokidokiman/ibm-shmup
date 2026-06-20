extends Node

@export var spawn_margin: float = 40.0

var _wave_delay: float = 1.0
var _spawn_timer: float = 0.0
var _spawn_index: int = 0
var _spawn_count: int = 0
var _is_spawning: bool = false
var _wave_active: bool = false

@onready var enemy_scene := preload("res://scenes/Enemies/Enemy.tscn")
@onready var boss_scene := preload("res://scenes/Enemies/Boss.tscn")
@onready var enemy_container: Node = get_node("/root/Game/EnemyContainer")

func _ready() -> void:
	SignalBus.game_state_changed.connect(_on_state_changed)
	SignalBus.boss_destroyed.connect(_on_boss_destroyed)

func _on_state_changed(state_name: String) -> void:
	if state_name == "PLAYING":
		_start_wave()

func _process(delta: float) -> void:
	if _wave_delay > 0:
		_wave_delay -= delta
		return
	
	if _is_spawning:
		_spawn_timer -= delta
		if _spawn_timer <= 0 and _spawn_index < _spawn_count:
			_spawn_enemy(_spawn_index)
			_spawn_index += 1
			_spawn_timer = 0.4
		elif _spawn_index >= _spawn_count:
			_is_spawning = false
			_wave_active = true
		return
	
	if _wave_active and not _is_boss_wave():
		var enemies := get_tree().get_nodes_in_group("enemies")
		if enemies.size() == 0:
			_wave_active = false
			_wave_delay = 1.0

func _start_wave() -> void:
	GameManager.wave += 1
	AudioManager.play_floppy_seek()
	
	if GameManager.wave % 5 == 0:
		_spawn_boss()
	else:
		_spawn_enemy_wave()

func _spawn_enemy_wave() -> void:
	var wave := GameManager.wave
	_spawn_count = 5 + wave / 2
	
	_spawn_index = 0
	_spawn_timer = 0.0
	_is_spawning = true

func _spawn_enemy(index: int) -> void:
	var wave := GameManager.wave
	# Determine enemy type based on wave
	var type_idx := clampi((wave - 1) / 2, 0, 2)
	var _EB := preload("res://scenes/Enemies/Enemy.gd")
	var type_arr := [_EB.EnemyType.SCOUT, _EB.EnemyType.TANK, _EB.EnemyType.ELITE]
	var etype: int = type_arr[type_idx]
	
	var patterns := ["sin", "zig", "duik", "snell"]
	var pat: String = patterns[index % patterns.size()]
	
	var vp := get_viewport().get_visible_rect()
	var e := enemy_scene.instantiate()
	e.enemy_type = etype
	e.movement_pattern = pat
	e.speed_mult = 1.0 + wave * 0.05
	e.global_position = Vector2(
		spawn_margin + randf() * (vp.size.x - spawn_margin * 2),
		-spawn_margin - index * 50.0
	)
	enemy_container.add_child(e)

func _spawn_boss() -> void:
	var vp := get_viewport().get_visible_rect()
	var b := boss_scene.instantiate()
	b.global_position = Vector2(vp.size.x * 0.5, -60)
	enemy_container.add_child(b)

func _is_boss_wave() -> bool:
	return GameManager.wave % 5 == 0

func _on_boss_destroyed() -> void:
	_wave_active = false
	_wave_delay = 2.0

