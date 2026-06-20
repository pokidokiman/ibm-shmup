extends Node

## Central game state machine + scoring.
## Autoload name: "GameManager"
##
## States: BOOT → TITLE → PLAYING → GAME_OVER → TITLE (loop)

enum GameState { BOOT, TITLE, PLAYING, PAUSED, GAME_OVER }

var state: GameState: set = _set_state
var score: int: set = _set_score
var high_score: int
var lives: int: set = _set_lives
var wave: int: set = _set_wave
var combo: int: set = _set_combo
var power_level: int: set = _set_power

const SAVE_PATH := "user://highscore.cfg"
const INITIAL_LIVES := 3
const MAX_POWER := 4

var _combo_timer: float = 0.0
const COMBO_WINDOW := 2.0  # seconds between kills to maintain combo

func _ready() -> void:
	_load_high_score()
	reset()

func reset() -> void:
	score = 0
	lives = INITIAL_LIVES
	wave = 0
	combo = 0
	power_level = 1
	_combo_timer = 0.0
	SignalBus.game_state_changed.emit("reset")

func add_score(points: int) -> void:
	var multiplier = 1 + floori(combo * 0.1)
	var total = points * multiplier
	score += total
	SignalBus.score_changed.emit(score, total)

func add_combo() -> void:
	combo += 1
	_combo_timer = COMBO_WINDOW
	SignalBus.combo_changed.emit(combo)

func _process(delta: float) -> void:
	if combo > 0:
		_combo_timer -= delta
		if _combo_timer <= 0.0:
			combo = 0
			SignalBus.combo_changed.emit(0)

func player_hit() -> void:
	if state != GameState.PLAYING:
		return
	lives -= 1
	power_level = maxi(1, power_level - 1)
	SignalBus.player_hit.emit()
	if lives <= 0:
		if score > high_score:
			high_score = score
			_save_high_score()
		_set_state(GameState.GAME_OVER)
		SignalBus.game_over.emit(score, high_score)

func start_playing() -> void:
	reset()
	_set_state(GameState.PLAYING)

func _set_score(v: int) -> void:
	score = v
	SignalBus.score_changed.emit(score, 0)

func _set_lives(v: int) -> void:
	lives = v
	SignalBus.lives_changed.emit(lives)

func _set_wave(v: int) -> void:
	wave = v
	SignalBus.wave_changed.emit(wave)

func _set_combo(v: int) -> void:
	combo = v
	SignalBus.combo_changed.emit(combo)

func _set_power(v: int) -> void:
	power_level = clampi(v, 1, MAX_POWER)
	SignalBus.player_power_changed.emit(power_level)

func _set_state(v: GameState) -> void:
	state = v
	SignalBus.game_state_changed.emit(GameState.keys()[v])

func _load_high_score() -> void:
	var cfg := ConfigFile.new()
	if cfg.load(SAVE_PATH) == OK:
		high_score = cfg.get_value("score", "high", 0)

func _save_high_score() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value("score", "high", high_score)
	cfg.save(SAVE_PATH)
