extends CanvasLayer

@onready var boot_text := $BootText
@onready var cursor := $Cursor
@onready var matrix_rain := $MatrixRain
@onready var title_screen := $TitleScreen

const BOOT_LINES := [
	{text = "", delay = 0.2},
	{text = "IBM 5153 BIOS v1.11 01/10/84", delay = 0.3},
	{text = "Copyright 1984 IBM Corp.", delay = 0.2},
	{text = "", delay = 0.15},
	{text = "  CPU: Intel 8088 @ 4.77 MHz", delay = 0.15},
	{text = "  Coprocessor: None", delay = 0.1},
	{text = "", delay = 0.1},
	{text = "Memory Test:     ", delay = 0.08, is_memory = true},
	{text = "", delay = 0.15},
	{text = "  IBM SHMUP v1.0 detected", delay = 0.4},
	{text = "", delay = 0.1},
	{text = "  2 Floppy drive(s) detected", delay = 0.3},
	{text = "", delay = 0.15},
	{text = "  Starting MS-DOS...", delay = 0.6},
	{text = "", delay = 0.2},
]

var _current_line: int = 0
var _current_char: int = 0
var _memory_kb: int = 0
var _is_typing: bool = false
var _boot_done: bool = false
var _cancelled: bool = false

func _ready() -> void:
	title_screen.hide()
	matrix_rain.hide()
	SignalBus.game_state_changed.connect(_on_state_changed)
	boot_text.text = ""
	_start_boot()

func _start_boot() -> void:
	_current_line = 0
	_current_char = 0
	_memory_kb = 0
	_boot_done = false
	_cancelled = false
	boot_text.text = ""
	_type_next()

func _type_next() -> void:
	if _cancelled:
		return
	
	if _current_line >= BOOT_LINES.size():
		boot_text.text += "\n$ PRESS SPACE"
		_boot_done = true
		SignalBus.boot_completed.emit()
		_show_title()
		return
	
	var line = BOOT_LINES[_current_line]
	
	if line.get("is_memory", false):
		_memory_count_up()
		return
	
	if _current_char < len(line.text):
		if _current_char == 0 and _current_line > 0:
			boot_text.text += "\n"
		boot_text.text += line.text[_current_char]
		_current_char += 1
		await get_tree().create_timer(0.02 + randf() * 0.02).timeout
		_type_next()
	else:
		_current_line += 1
		_current_char = 0
		await get_tree().create_timer(line.delay).timeout
		_type_next()

func _memory_count_up() -> void:
	if _cancelled:
		return
	
	var line = BOOT_LINES[_current_line]
	var base_text = line.text
	
	var lines: PackedStringArray = boot_text.text.split("\n")
	if lines.size() > 0 and lines[-1].begins_with(base_text.strip_edges()):
		lines.remove_at(lines.size() - 1)
		boot_text.text = "\n".join(lines)
	
	_memory_kb += randi_range(8, 24)
	if _memory_kb >= 640:
		_memory_kb = 640
	
	if lines.size() > 0 or boot_text.text == "":
		if boot_text.text != "":
			boot_text.text += "\n"
		boot_text.text += base_text + "%04d KB" % _memory_kb
	
	if _memory_kb >= 640:
		boot_text.text = boot_text.text.trim_suffix("\n")
		boot_text.text += base_text + "0640 KB OK"
		_current_line += 1
		_current_char = 0
		await get_tree().create_timer(0.2).timeout
		_type_next()
	else:
		await get_tree().create_timer(0.03).timeout
		_memory_count_up()

func _show_title() -> void:
	matrix_rain.show()
	title_screen.show()
	boot_text.hide()
	cursor.hide()
	var mat := matrix_rain.material as ShaderMaterial
	if mat:
		mat.set_shader_parameter("intensity", 0.3)

func skip_to_title() -> void:
	_cancelled = true
	boot_text.text = ""
	_show_title()

func _on_state_changed(state_name: String) -> void:
	match state_name:
		"PLAYING":
			hide()
		"TITLE":
			show()
			if _boot_done:
				_show_title()
			else:
				_start_boot()

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("confirm") and _boot_done and GameManager.state == GameManager.GameState.TITLE:
		GameManager.start_playing()
	elif event.is_action_pressed("confirm") and not _boot_done:
		skip_to_title()

