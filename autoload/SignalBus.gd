extends Node

## Global signal bus — all game-wide signals pass through here.
## Autoload name: "SignalBus"

signal score_changed(new_score: int, delta: int)
signal lives_changed(remaining: int)
signal wave_changed(wave: int)
signal combo_changed(multiplier: int)
signal game_over(final_score: int, high_score: int)
signal boss_spawned()
signal boss_destroyed()
signal boss_hp_changed(hp: int, max_hp: int)
signal powerup_collected(type: String)
signal player_hit()
signal player_death()
signal player_power_changed(level: int)
signal game_state_changed(state: String)
signal boot_completed()
signal pause_toggled(paused: bool)
