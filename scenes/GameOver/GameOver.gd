extends CanvasLayer

## Game Over screen — shows final score, high score, press to retry.

@onready var game_over_label := $GameOverLabel
@onready var score_label := $ScoreLabel
@onready var high_score_label := $HighScoreLabel
@onready var restart_label := $RestartLabel

var _blink: float = 0.0

func _ready() -> void:
	SignalBus.game_over.connect(_on_game_over)
	SignalBus.game_state_changed.connect(_on_state_changed)
	hide()

func _on_game_over(final_score: int, high_score: int) -> void:
	show()
	score_label.text = "SCORE: %05d" % final_score
	high_score_label.text = "HI: %05d" % high_score
	game_over_label.modulate.a = 1.0

func _process(delta: float) -> void:
	if not visible:
		return
	_blink += delta
	restart_label.modulate.a = 1.0 if sin(_blink * 4.0) > 0 else 0.2

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("confirm") and visible:
		hide()
		GameManager.start_playing()

func _on_state_changed(state_name: String) -> void:
	if state_name == "PLAYING":
		hide()
