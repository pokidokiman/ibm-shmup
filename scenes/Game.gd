extends Node2D

func _ready() -> void:
	AudioManager.generate_sfx_wavs("res://assets/audio/")
	SignalBus.player_hit.connect(_on_player_hit)
	SignalBus.boss_destroyed.connect(_on_boss_destroyed)

func _on_player_hit() -> void:
	var crt = get_node_or_null("CRTOverlay")
	if crt and crt.has_method("trigger_shake"):
		crt.trigger_shake(2.0)
		crt.trigger_raster_tear()

func _on_boss_destroyed() -> void:
	var crt = get_node_or_null("CRTOverlay")
	if crt and crt.has_method("trigger_shake"):
		crt.trigger_shake(4.0)
		crt.trigger_raster_tear()

