// Orb —— React Bits <Orb /> 组件的 vanilla 移植（基于 ogl WebGL 着色器）
// 与原版差异：
//   1) 去掉所有鼠标 hover 监听（按需求：鼠标移动到该区域不需要有反应）
//   2) hover / rotation 由语音状态驱动，而非鼠标位置
//   3) 以 class 形式暴露，方便在普通 ES module 项目中挂载
import { Mesh, Program, Renderer, Triangle, Vec3 } from './vendor/ogl.js';

const vert = /* glsl */ `
  precision highp float;
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const frag = /* glsl */ `
  precision highp float;

  uniform float iTime;
  uniform vec3 iResolution;
  uniform float hue;
  uniform float hover;
  uniform float rot;
  uniform float hoverIntensity;
  uniform vec3 backgroundColor;
  varying vec2 vUv;

  vec3 rgb2yiq(vec3 c) {
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    float i = dot(c, vec3(0.596, -0.274, -0.322));
    float q = dot(c, vec3(0.211, -0.523, 0.312));
    return vec3(y, i, q);
  }

  vec3 yiq2rgb(vec3 c) {
    float r = c.x + 0.956 * c.y + 0.621 * c.z;
    float g = c.x - 0.272 * c.y - 0.647 * c.z;
    float b = c.x - 1.106 * c.y + 1.703 * c.z;
    return vec3(r, g, b);
  }

  vec3 adjustHue(vec3 color, float hueDeg) {
    float hueRad = hueDeg * 3.14159265 / 180.0;
    vec3 yiq = rgb2yiq(color);
    float cosA = cos(hueRad);
    float sinA = sin(hueRad);
    float i = yiq.y * cosA - yiq.z * sinA;
    float q = yiq.y * sinA + yiq.z * cosA;
    yiq.y = i;
    yiq.z = q;
    return yiq2rgb(yiq);
  }

  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
    p3 += dot(p3, p3.yxz + 19.19);
    return -1.0 + 2.0 * fract(vec3(
      p3.x + p3.y,
      p3.x + p3.z,
      p3.y + p3.z
    ) * p3.zyx);
  }

  float snoise3(vec3 p) {
    const float K1 = 0.333333333;
    const float K2 = 0.166666667;
    vec3 i = floor(p + (p.x + p.y + p.z) * K1);
    vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
    vec3 e = step(vec3(0.0), d0 - d0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec3 d1 = d0 - (i1 - K2);
    vec3 d2 = d0 - (i2 - K1);
    vec3 d3 = d0 - 0.5;
    vec4 h = max(0.6 - vec4(
      dot(d0, d0),
      dot(d1, d1),
      dot(d2, d2),
      dot(d3, d3)
    ), 0.0);
    vec4 n = h * h * h * h * vec4(
      dot(d0, hash33(i)),
      dot(d1, hash33(i + i1)),
      dot(d2, hash33(i + i2)),
      dot(d3, hash33(i + 1.0))
    );
    return dot(vec4(31.316), n);
  }

  vec4 extractAlpha(vec3 colorIn) {
    float a = max(max(colorIn.r, colorIn.g), colorIn.b);
    return vec4(colorIn.rgb / (a + 1e-5), a);
  }

  const vec3 baseColor1 = vec3(0.611765, 0.262745, 0.996078);
  const vec3 baseColor2 = vec3(0.298039, 0.760784, 0.913725);
  const vec3 baseColor3 = vec3(0.062745, 0.078431, 0.600000);
  const float innerRadius = 0.6;
  const float noiseScale = 0.65;

  float light1(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * attenuation);
  }
  float light2(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * dist * attenuation);
  }

  vec4 draw(vec2 uv) {
    vec3 color1 = adjustHue(baseColor1, hue);
    vec3 color2 = adjustHue(baseColor2, hue);
    vec3 color3 = adjustHue(baseColor3, hue);

    float ang = atan(uv.y, uv.x);
    float len = length(uv);
    float invLen = len > 0.0 ? 1.0 / len : 0.0;

    float bgLuminance = dot(backgroundColor, vec3(0.299, 0.587, 0.114));

    float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
    float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0);
    float d0 = distance(uv, (r0 * invLen) * uv);
    float v0 = light1(1.0, 10.0, d0);

    v0 *= smoothstep(r0 * 1.05, r0, len);
    float innerFade = smoothstep(r0 * 0.8, r0 * 0.95, len);
    v0 *= mix(innerFade, 1.0, bgLuminance * 0.7);
    float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;

    float a = iTime * -1.0;
    vec2 pos = vec2(cos(a), sin(a)) * r0;
    float d = distance(uv, pos);
    float v1 = light2(1.5, 5.0, d);
    v1 *= light1(1.0, 50.0, d0);

    float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
    float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);

    vec3 colBase = mix(color1, color2, cl);
    float fadeAmount = mix(1.0, 0.1, bgLuminance);

    vec3 darkCol = mix(color3, colBase, v0);
    darkCol = (darkCol + v1) * v2 * v3;
    darkCol = clamp(darkCol, 0.0, 1.0);

    vec3 lightCol = (colBase + v1) * mix(1.0, v2 * v3, fadeAmount);
    lightCol = mix(backgroundColor, lightCol, v0);
    lightCol = clamp(lightCol, 0.0, 1.0);

    vec3 finalCol = mix(darkCol, lightCol, bgLuminance);

    return extractAlpha(finalCol);
  }

  vec4 mainImage(vec2 fragCoord) {
    vec2 center = iResolution.xy * 0.5;
    float size = min(iResolution.x, iResolution.y);
    vec2 uv = (fragCoord - center) / size * 2.0;

    float angle = rot;
    float s = sin(angle);
    float c = cos(angle);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

    uv.x += hover * hoverIntensity * 0.1 * sin(uv.y * 10.0 + iTime);
    uv.y += hover * hoverIntensity * 0.1 * sin(uv.x * 10.0 + iTime);

    return draw(uv);
  }

  void main() {
    vec2 fragCoord = vUv * iResolution.xy;
    vec4 col = mainImage(fragCoord);
    gl_FragColor = vec4(col.rgb * col.a, col.a);
  }
`;

export class Orb {
  /**
   * @param {HTMLElement} container 承载 canvas 的容器（建议固定尺寸 + 圆角裁剪）
   * @param {object} opts
   *   hue            基础色相（度），默认 0（紫青）
   *   hoverIntensity 激活态扭曲强度，默认 0.3
   *   rotationSpeed  激活态旋转速度（弧度/秒），默认 0.4
   *   backgroundColor 背景色（十六进制 / rgb / hsl），默认 '#000000'
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.hue = opts.hue ?? 0;
    this.hoverIntensity = opts.hoverIntensity ?? 0.3;
    this.rotationSpeed = opts.rotationSpeed ?? 0.4;
    this.backgroundColor = opts.backgroundColor ?? '#000000';

    this.targetHover = 0;   // 由状态驱动，而非鼠标
    this.currentRot = 0;
    this.lastTime = 0;
    this._raf = null;
    this._destroyed = false;

    this._initGL();
    this._observe();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  _initGL() {
    const renderer = new Renderer({ alpha: true, premultipliedAlpha: false });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.canvas.classList.add('orb-canvas');
    this.container.appendChild(gl.canvas);

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: vert,
      fragment: frag,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Vec3(1, 1, 1) },
        hue: { value: this.hue },
        hover: { value: 0 },
        rot: { value: 0 },
        hoverIntensity: { value: this.hoverIntensity },
        backgroundColor: { value: hexToVec3(this.backgroundColor) },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });

    this.gl = gl;
    this.renderer = renderer;
    this.program = program;
    this.mesh = mesh;

    this._resize();
  }

  _resize() {
    const c = this.container;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = c.clientWidth || 140;
    const height = c.clientHeight || 140;
    this.renderer.setSize(width * dpr, height * dpr);
    this.gl.canvas.style.width = width + 'px';
    this.gl.canvas.style.height = height + 'px';
    this.program.uniforms.iResolution.value.set(
      this.gl.canvas.width,
      this.gl.canvas.height,
      this.gl.canvas.width / this.gl.canvas.height
    );
  }

  _observe() {
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.container);
    }
  }

  /** 直接切换激活态（hover=1 发光+旋转，hover=0 静止） */
  setActive(active) {
    this.targetHover = active ? 1 : 0;
  }

  setHue(h) { this.hue = h; }
  setRotationSpeed(s) { this.rotationSpeed = s; }

  /** 按语音状态名驱动 orb（IDLE/LISTENING/THINKING/SPEAKING/PAUSED） */
  setState(name) {
    const map = {
      IDLE:     { active: false, hue: 0,   speed: 0.4 },
      LISTENING:{ active: true,  hue: 0,   speed: 0.35 },
      THINKING: { active: true,  hue: 25,  speed: 0.5 },
      SPEAKING: { active: true,  hue: 200, speed: 0.95 },
      PAUSED:   { active: false, hue: 0,   speed: 0.4 },
    };
    const cfg = map[name] || map.IDLE;
    this.targetHover = cfg.active ? 1 : 0;
    this.hue = cfg.hue;
    this.rotationSpeed = cfg.speed;
  }

  _loop(t) {
    if (this._destroyed) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = this.lastTime ? (t - this.lastTime) * 0.001 : 0;
    this.lastTime = t;

    const u = this.program.uniforms;
    u.iTime.value = t * 0.001;
    u.hue.value = this.hue;
    u.hoverIntensity.value = this.hoverIntensity;
    u.backgroundColor.value = hexToVec3(this.backgroundColor);

    u.hover.value += (this.targetHover - u.hover.value) * 0.1;

    if (this.targetHover > 0.5) {
      this.currentRot += dt * this.rotationSpeed;
    }
    u.rot.value = this.currentRot;

    this.renderer.render({ scene: this.mesh });
  }

  destroy() {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
    if (this.gl && this.gl.canvas && this.gl.canvas.parentNode) {
      this.gl.canvas.parentNode.removeChild(this.gl.canvas);
    }
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ---- 颜色工具（移植自 React Bits 原版） ----
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return new Vec3(r, g, b);
}

function hexToVec3(color) {
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;
    return new Vec3(r, g, b);
  }
  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return new Vec3(parseInt(rgbMatch[1]) / 255, parseInt(rgbMatch[2]) / 255, parseInt(rgbMatch[3]) / 255);
  }
  const hslMatch = color.match(/hsla?\((\d+),\s*(\d+)%,\s*(\d+)%/);
  if (hslMatch) {
    const h = parseInt(hslMatch[1]) / 360;
    const s = parseInt(hslMatch[2]) / 100;
    const l = parseInt(hslMatch[3]) / 100;
    return hslToRgb(h, s, l);
  }
  return new Vec3(0, 0, 0);
}
