extends CanvasLayer

## HUD — score, lives, wave, combo, boss HP bar.

@onready var score_label := $ScoreLabel
@onready var high_score_label := $HighScoreLabel
@onready var lives_label := $LivesLabel
@onready var wave_label := $WaveLabel
@onready var combo_label := $ComboLabel
@onready var power_label := $PowerLabel
@onready var boss_hp_bar := $BossHPBar
@onready var boss_hp_bar_bg := $BossHPBar/Background
@onready var boss_hp_fill := $BossHPBar/Fill

func _ready() -> void:
	SignalBus.score_changed.connect(_on_score_changed)
	SignalBus.lives_changed.connect(_on_lives_changed)
	SignalBus.wave_changed.connect(_on_wave_changed)
	SignalBus.combo_changed.connect(_on_combo_changed)
	SignalBus.player_power_changed.connect(_on_power_changed)
	SignalBus.boss_spawned.connect(_on_boss_spawned)
	SignalBus.boss_hp_changed.connect(_on_boss_hp_changed)
	SignalBus.boss_destroyed.connect(_on_boss_destroyed)
	SignalBus.game_state_changed.connect(_on_state_changed)
	
	boss_hp_bar.hide()

func _on_score_changed(new_score: int, _delta: int) -> void:
	# Score popup animation
	score_label.text = "SCORE %05d" % new_score
	var t := create_tween()
	t.tween_property(score_label, "scale", Vector2(1.2, 1.2), 0.05)
	t.tween_property(score_label, "scale", Vector2(1.0, 1.0), 0.1)

func _on_lives_changed(remaining: int) -> void:
	var s := ""
	for i in range(remaining):
		s += "▲ "
	lives_label.text = s

func _on_wave_changed(wave: int) -> void:
	wave_label.text = "WAVE %d" % wave
	# Wave announcement animation
	var t := create_tween()
	t.tween_property(wave_label, "modulate:a", 1.0, 0.0)
	t.tween_property(wave_label, "modulate:a", 0.4, 1.0)

func _on_combo_changed(multiplier: int) -> void:
	if multiplier > 1:
		combo_label.text = "×%d" % multiplier
		combo_label.show()
		var t := create_tween()
		t.tween_property(combo_label, "scale", Vector2(1.5, 1.5), 0.05)
		t.tween_property(combo_label, "scale", Vector2(1.0, 1.0), 0.1)
	else:
		combo_label.hide()

func _on_power_changed(level: int) -> void:
	power_label.text = "PWR:%d" % level

func _on_boss_spawned() -> void:
	boss_hp_bar.show()

func _on_boss_hp_changed(hp: int, max_hp: int) -> void:
	var ratio := float(hp) / float(max_hp)
	boss_hp_fill.scale.x = ratio

func _on_boss_destroyed() -> void:
	boss_hp_bar.hide()

func _on_state_changed(state_name: String) -> void:
	match state_name:
		"PLAYING":
			show()
		_:
			boss_hp_bar.hide()
