extends Node

## Centralized audio manager. Lazy-loads all SFX and provides playback methods.
## Autoload name: "AudioManager"
## Uses AudioStreamPlayer2D for spatial audio on game SFX.
## Master bus -> SFX bus -> individual players.

const BUS_SFX := "SFX"
const BUS_FLOPPY := "Floppy"

# Sound file paths (lazy-loaded to avoid compile errors when WAVs dont exist yet)
const SFX_PATHS := {
	shoot = "res://assets/audio/sfx_shoot.wav",
	hit = "res://assets/audio/sfx_hit.wav",
	explode = "res://assets/audio/sfx_explode.wav",
	powerup = "res://assets/audio/sfx_powerup.wav",
	gameover = "res://assets/audio/sfx_gameover.wav",
	floppy_seek = "res://assets/audio/sfx_floppy_seek.wav",
}

var _streams := {}
var _players: Dictionary

func _ready() -> void:
	_create_buses_if_missing()
	for key in SFX_PATHS.keys():
		_players[key] = []
		# Lazy load
		var stream := load(SFX_PATHS[key]) as AudioStream
		if stream:
			_streams[key] = stream

func _create_buses_if_missing() -> void:
	var ab := AudioServer.bus_count
	var names := []
	for i in ab:
		names.append(AudioServer.get_bus_name(i))
	if not "SFX" in names:
		AudioServer.add_bus()
		AudioServer.set_bus_name(ab, "SFX")
	if not "Floppy" in names:
		AudioServer.add_bus()
		AudioServer.set_bus_name(ab + 1, "Floppy")

func play(name: String, position: Vector2 = Vector2.ZERO) -> void:
	if not name in _streams:
		push_warning("AudioManager: unknown sfx %s" % name)
		return
	_play_at(name, position)

func play_shoot(pos: Vector2) -> void:    _play_at("shoot", pos)
func play_hit(pos: Vector2) -> void:      _play_at("hit", pos)
func play_explode(pos: Vector2) -> void:  _play_at("explode", pos)
func play_powerup(pos: Vector2) -> void:  _play_at("powerup", pos)
func play_gameover() -> void:              _play_at("gameover")
func play_floppy_seek() -> void:           _play_at("floppy_seek")

func _play_at(name: String, position: Vector2 = Vector2.ZERO) -> void:
	var stream: AudioStream = _streams.get(name) as AudioStream
	if stream == null:
		return
	
	# Reuse an idle player or create a new one
	var player_node: AudioStreamPlayer2D = null
	for p in _players[name]:
		if not p.playing:
			player_node = p
			break
	
	if player_node == null:
		player_node = AudioStreamPlayer2D.new()
		player_node.stream = stream
		player_node.bus = BUS_SFX if name != "floppy_seek" else BUS_FLOPPY
		add_child(player_node)
		_players[name].append(player_node)
	
	player_node.global_position = position
	player_node.play()

## Pre-generate WAV files at project startup if they do not exist.
static func generate_sfx_wavs(output_dir: String = "res://assets/audio/") -> void:
	var dir := DirAccess.open(output_dir)
	if dir == null:
		var err := DirAccess.make_dir_recursive_absolute(output_dir)
		if err != OK:
			return
	
	var files_to_generate := {
		"sfx_shoot.wav": _gen_shoot(),
		"sfx_hit.wav": _gen_hit(),
		"sfx_explode.wav": _gen_explode(),
		"sfx_powerup.wav": _gen_powerup(),
		"sfx_gameover.wav": _gen_gameover(),
		"sfx_floppy_seek.wav": _gen_floppy_seek(),
	}
	
	for filename in files_to_generate:
		var path := output_dir.path_join(filename)
		if not FileAccess.file_exists(path):
			var data: PackedByteArray = files_to_generate[filename]
			var f := FileAccess.open(path, FileAccess.WRITE)
			if f:
				f.store_buffer(data)
				print("Generated: ", path)

static func _wav_header(data_size: int, sample_rate: int) -> PackedByteArray:
	var h := PackedByteArray()
	h.append_array("RIFF".to_ascii_buffer())
	var total_size := 36 + data_size
	h.append_array(_le32(total_size))
	h.append_array("WAVE".to_ascii_buffer())
	h.append_array("fmt ".to_ascii_buffer())
	h.append_array(_le32(16))
	h.append_array(_le16(1))
	h.append_array(_le16(1))
	h.append_array(_le32(sample_rate))
	h.append_array(_le32(sample_rate))
	h.append_array(_le16(1))
	h.append_array(_le16(8))
	h.append_array("data".to_ascii_buffer())
	h.append_array(_le32(data_size))
	return h

static func _le16(v: int) -> PackedByteArray:
	return PackedByteArray([v & 0xFF, (v >> 8) & 0xFF])

static func _le32(v: int) -> PackedByteArray:
	return PackedByteArray([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF])

static func _gen_shoot() -> PackedByteArray:
	var sr := 22050
	var samples := int(sr * 0.08)
	var data := PackedByteArray()
	for i in range(samples):
		var t := float(i) / sr
		var env := 1.0 - t / 0.08
		var phase := fmod(t * 800.0 * 2.0, 2.0)
		var val := 1.0 if phase < 1.0 else -1.0
		var s := int(clamp((val * env * 0.5 + 0.5) * 255.0, 0.0, 255.0))
		data.append(s)
	var hdr := _wav_header(len(data), sr)
	hdr.append_array(data)
	return hdr

static func _gen_hit() -> PackedByteArray:
	var sr := 22050
	var samples := int(sr * 0.15)
	var data := PackedByteArray()
	for i in range(samples):
		var t := float(i) / sr
		var env := 1.0 - t / 0.15
		var phase := fmod(t * 200.0, 1.0)
		var val := phase * 2.0 - 1.0
		var s := int(clamp((val * env * 0.5 + 0.5) * 255.0, 0.0, 255.0))
		data.append(s)
	var hdr := _wav_header(len(data), sr)
	hdr.append_array(data)
	return hdr

static func _gen_explode() -> PackedByteArray:
	var sr := 22050
	var samples := int(sr * 0.4)
	var data := PackedByteArray()
	for i in range(samples):
		var t := float(i) / sr
		var env := 1.0 - t / 0.4
		var saw := fmod(t * 100.0, 1.0) * 2.0 - 1.0
		var sq_phase := fmod(t * 60.0 * 2.0, 2.0)
		var sq := 1.0 if sq_phase < 1.0 else -1.0
		var val := saw * 0.5 + sq * 0.5
		var s := int(clamp((val * env * 0.5 + 0.5) * 255.0, 0.0, 255.0))
		data.append(s)
	var hdr := _wav_header(len(data), sr)
	hdr.append_array(data)
	return hdr

static func _gen_powerup() -> PackedByteArray:
	var sr := 22050
	var samples := int(sr * 0.2)
	var data := PackedByteArray()
	for i in range(samples):
		var t := float(i) / sr
		var freq := 600.0 if t < 0.1 else 900.0
		var env := 1.0 - t / 0.2
		var phase := fmod(t * freq * 2.0, 2.0)
		var val := 1.0 if phase < 1.0 else -1.0
		var s := int(clamp((val * env * 0.4 + 0.5) * 255.0, 0.0, 255.0))
		data.append(s)
	var hdr := _wav_header(len(data), sr)
	hdr.append_array(data)
	return hdr

static func _gen_gameover() -> PackedByteArray:
	var sr := 22050
	var samples := int(sr * 0.6)
	var data := PackedByteArray()
	for i in range(samples):
		var t := float(i) / sr
		var env := 1.0 - t / 0.6
		var freq := 300.0 - (t / 0.6) * 200.0
		var phase := fmod(t * freq * 2.0, 2.0)
		var val := 1.0 if phase < 1.0 else -1.0
		var s := int(clamp((val * env * 0.4 + 0.5) * 255.0, 0.0, 255.0))
		data.append(s)
	var hdr := _wav_header(len(data), sr)
	hdr.append_array(data)
	return hdr

static func _gen_floppy_seek() -> PackedByteArray:
	var sr := 22050
	var samples := int(sr * 0.8)
	var data := PackedByteArray()
	for i in range(samples):
		var t := float(i) / sr
		var noise := randf() * 2.0 - 1.0
		var click_phase := fmod(t * 60.0, 1.0)
		var click := 1.0 if click_phase < 0.05 else 0.0
		var rumble := noise * 0.3
		var scrape := (randf() * 2.0 - 1.0) * 0.5
		var val := rumble + scrape + click * 0.8
		var s := int(clamp((val * 0.4 + 0.5) * 255.0, 0.0, 255.0))
		data.append(s)
	var hdr := _wav_header(len(data), sr)
	hdr.append_array(data)
	return hdr

