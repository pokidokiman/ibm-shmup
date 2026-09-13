/**
 * src/render/crt.mjs — the glass in front of the tube.
 *
 * The playfield is rendered by `three-scene.mjs` into an offscreen render
 * target; this module owns the final full-screen pass that blows that target
 * onto the screen through a CRT ShaderMaterial: barrel curvature, scanlines,
 * an aperture-grille mask, chromatic aberration, phosphor bloom/glow, warm
 * colour bleed, a faint rolling refresh and a heavy vignette.
 *
 * There is no binary overlay and no CSS filter involved: everything the old
 * single-file game faked with `filter: url(#crt-barrel)` plus stacked divs is
 * one shader here, so the effect scales with the render resolution and stays
 * honest on high-DPI displays.
 *
 * Typical wiring (from `three-scene.mjs`):
 *
 *   const target = new THREE.WebGLRenderTarget(w, h);
 *   const crt = createCRT({ width: w, height: h });
 *   // frame:
 *   renderer.setRenderTarget(target);
 *   renderer.render(world, camera);
 *   crt.update(dt);
 *   crt.render(renderer, target.texture);
 *   // resize:
 *   crt.setSize(w, h);
 *
 * The pass is deliberately self-contained: it owns its scene, camera, quad and
 * material, and `render()` always draws to the default framebuffer.
 */
import * as THREE from 'three';

/** Barrel curvature is applied in normalised UV space; this is the max bend. */
export const CRT_DEFAULTS = Object.freeze({
  /** Scanline + aperture-grille strength, 0..1. */
  scan: 0.18,
  /** Screen curvature along both axes. */
  curv: 0.30,
  /** Chromatic aberration at the tube edge, in UV units. */
  aberr: 0.0016,
  /** Vignette falloff exponent; larger = tighter corner darkening. */
  vignette: 0.42,
  /** Phosphor bloom/glow mix. */
  glow: 0.40,
  /** Warm phosphor tint amount, 0..1. */
  warm: 0.55,
  /** Overall gain applied before the mask. */
  brightness: 1.06,
});

/** Maps `CRT_DEFAULTS` keys to their uniform names (used by `set()`). */
const PARAM_UNIFORMS = Object.freeze({
  scan: 'uScan',
  curv: 'uCurv',
  aberr: 'uAberr',
  vignette: 'uVignette',
  glow: 'uGlow',
  warm: 'uWarm',
  brightness: 'uBrightness',
});

/**
 * Full-screen triangle-strip vertex shader. `PlaneGeometry(2, 2)` already spans
 * clip space, so `position.xy` is emitted directly and `uv` is passed through.
 */
export const CRT_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * The CRT fragment shader. Uniform contract (asserted by tests/render.test.mjs):
 *   tDiffuse     sampler2D  the rendered playfield
 *   uResolution  vec2       render resolution, for pixel-accurate scanlines
 *   uTime        float      seconds, drives flicker and the refresh roll
 *   uScan        float      scanline / grille depth
 *   uCurv        float      barrel curvature
 *   uAberr       float      chromatic aberration
 *   uVignette    float      vignette exponent
 *   uGlow        float      phosphor bloom mix
 *   uWarm        float      warm colour bleed + flicker amount
 *   uBrightness  float      pre-mask gain
 */
export const CRT_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uScan;
  uniform float uCurv;
  uniform float uAberr;
  uniform float uVignette;
  uniform float uGlow;
  uniform float uWarm;
  uniform float uBrightness;

  varying vec2 vUv;

  const float PI = 3.141592653589793;

  /** Bulge the image outward from the centre to fake a spherical tube. */
  vec2 barrel(vec2 uv, float amount) {
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    return 0.5 + c * (1.0 + amount * r2);
  }

  float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  void main() {
    vec2 uv = barrel(vUv, uCurv);

    // Outside the curved tube: dead black bezel.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // Chromatic aberration grows toward the edges like a mis-converged yoke.
    vec2 c = uv - 0.5;
    float edge = length(c) * 2.0;
    vec2 split = c * (uAberr * (0.35 + edge * 2.2));
    float r = texture2D(tDiffuse, uv + split).r;
    float g = texture2D(tDiffuse, uv).g;
    float b = texture2D(tDiffuse, uv - split).b;

    // Phosphor bloom: an eight-tap cross blur of the bright parts only.
    vec2 px = 1.0 / max(uResolution, vec2(1.0));
    vec3 glow = vec3(0.0);
    glow += texture2D(tDiffuse, uv + vec2( px.x * 2.0, 0.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2(-px.x * 2.0, 0.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2(0.0,  px.y * 2.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2(0.0, -px.y * 2.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2( px.x * 5.0,  px.y * 5.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2(-px.x * 5.0,  px.y * 5.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2( px.x * 5.0, -px.y * 5.0)).rgb;
    glow += texture2D(tDiffuse, uv + vec2(-px.x * 5.0, -px.y * 5.0)).rgb;
    glow *= 0.125;
    glow *= smoothstep(0.16, 0.85, luma(glow));

    vec3 color = vec3(r, g, b);
    color += glow * uGlow;

    // Warm IBM phosphor bias, then the pre-mask gain.
    color *= uBrightness;
    color.r *= 1.0 - uWarm * 0.10;
    color.b *= 1.0 - uWarm * 0.16;
    color.g *= 1.0 + uWarm * 0.06;

    // Scanlines travel with uTime so the raster never looks like a static texture.
    float line = sin((uv.y + uTime * 0.0008) * uResolution.y * PI);
    color *= 1.0 - uScan * (0.5 + 0.5 * line);

    // Aperture grille: vertical RGB triad stripes.
    float grille = 0.5 + 0.5 * sin(uv.x * uResolution.x * PI);
    color *= mix(1.0, grille, uScan * 0.35);

    // Mains hum flicker + one faint refresh roll down the tube.
    color *= 1.0 + 0.012 * sin(uTime * 11.0) * uWarm;
    float roll = fract(uv.y - uTime * 0.06);
    color *= 1.0 - 0.05 * smoothstep(0.995, 1.0, roll);

    // Vignette: a soft elliptical falloff that never quite reaches black.
    float v = uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
    v = clamp(pow(max(16.0 * v, 0.0001), max(uVignette, 0.001)), 0.0, 1.0);
    color *= mix(0.35, 1.0, v);

    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
  }
`;

/**
 * Build the CRT post pass.
 *
 * @param {object} [options]
 * @param {number} [options.width=1024] render resolution, for scanlines
 * @param {number} [options.height=768]
 * @param {import('three').Texture|null} [options.texture=null] initial source
 * @param {Partial<typeof CRT_DEFAULTS>} [options.params] shader tuning overrides
 * @returns {{
 *   material: import('three').ShaderMaterial,
 *   uniforms: Record<string, {value: any}>,
 *   scene: import('three').Scene,
 *   camera: import('three').OrthographicCamera,
 *   quad: import('three').Mesh,
 *   mesh: import('three').Mesh,
 *   time: number,
 *   setSource(t: any): any,
 *   setSize(w: number, h: number): any,
 *   update(dt?: number): number,
 *   set(patch: Record<string, number>): any,
 *   render(renderer: any, source?: any): any,
 *   dispose(): void,
 * }}
 */
export function createCRT(options = {}) {
  const width = Math.max(1, Number(options.width) || 1024);
  const height = Math.max(1, Number(options.height) || 768);

  const params = { ...CRT_DEFAULTS };
  if (options.params) {
    for (const key of Object.keys(PARAM_UNIFORMS)) {
      const value = Number(options.params[key]);
      if (Number.isFinite(value)) params[key] = value;
    }
  }

  const uniforms = {
    tDiffuse: { value: options.texture || null },
    uResolution: { value: new THREE.Vector2(width, height) },
    uTime: { value: 0 },
    uScan: { value: params.scan },
    uCurv: { value: params.curv },
    uAberr: { value: params.aberr },
    uVignette: { value: params.vignette },
    uGlow: { value: params.glow },
    uWarm: { value: params.warm },
    uBrightness: { value: params.brightness },
  };

  const material = new THREE.ShaderMaterial({
    name: 'CRTPass',
    uniforms,
    vertexShader: CRT_VERTEX_SHADER,
    fragmentShader: CRT_FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    toneMapped: false,
  });

  const scene = new THREE.Scene();
  scene.name = 'crt';
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  camera.position.z = 1;

  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  quad.name = 'crt-quad';
  quad.frustumCulled = false;
  scene.add(quad);

  let elapsed = 0;

  const api = {
    material,
    uniforms,
    scene,
    camera,
    quad,
    /** Alias so callers can treat the pass like any other display object. */
    mesh: quad,

    /** Seconds fed into `update()`, mirrored by the `uTime` uniform. */
    get time() {
      return elapsed;
    },

    /** The tuning values currently live on the uniforms. */
    get params() {
      return { ...params };
    },

    /** Point the pass at a new source texture (e.g. after a target rebuild). */
    setSource(texture) {
      uniforms.tDiffuse.value = texture || null;
      return api;
    },

    /** Resize in device pixels; keeps scanlines one-pixel accurate. */
    setSize(w, h) {
      uniforms.uResolution.value.set(Math.max(1, Math.floor(w) || 1), Math.max(1, Math.floor(h) || 1));
      return api;
    },

    /** Advance the CRT clock. Returns the new elapsed time in seconds. */
    update(dt = 1 / 60) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      elapsed += step;
      uniforms.uTime.value = elapsed;
      return elapsed;
    },

    /** Live-tune any shader parameter without rebuilding the material. */
    set(patch) {
      if (!patch) return api;
      for (const key of Object.keys(PARAM_UNIFORMS)) {
        const value = Number(patch[key]);
        if (Number.isFinite(value)) {
          params[key] = value;
          uniforms[PARAM_UNIFORMS[key]].value = value;
        }
      }
      return api;
    },

    /**
     * Draw the pass to the default framebuffer (the canvas). `source` is a
     * convenience for the common one-target case; pass it once and the uniform
     * keeps pointing at it.
     */
    render(renderer, source) {
      if (!renderer) return api;
      if (source) uniforms.tDiffuse.value = source;
      const previous = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      if (previous && previous !== null) renderer.setRenderTarget(previous);
      return api;
    },

    /** Release GPU resources. The material and quad are single-use. */
    dispose() {
      scene.remove(quad);
      geometry.dispose();
      material.dispose();
      uniforms.tDiffuse.value = null;
    },
  };

  return api;
}

export default createCRT;
