/**
 * WebGL2 pipeline.
 *
 * Display pass: the warp mesh (positions = warped output coords, texcoords
 * = source UV) is rasterized with the pattern texture; edge-blend falloff
 * and black-level lift are applied in the fragment shader (mirroring
 * src/render/blend.ts, the canonical TS implementation used for export).
 *
 * UV-export pass: the same mesh is rasterized into an offscreen target at
 * the configured output resolution with the fragment writing its source UV
 * (v flipped to bottom-left origin per PFM/MPCDI convention). Reading that
 * target back gives the per-output-pixel UV map for the PFM — the GPU does
 * the forward->inverse map inversion for us via rasterization.
 *
 * Coordinate conventions:
 *   - mesh positions are normalized output coords, (0,0)=top-left
 *   - clip space: y is flipped (clipY = 1 - 2*posY), so framebuffer row 0
 *     (bottom) = image bottom => glReadPixels order matches PFM's
 *     bottom-to-top row order directly.
 */
import { WarpMesh } from '../warp/compose';

const VS = `#version 300 es
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

const FS_DISPLAY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uBW;   // blend widths (l, r, t, b), normalized to output size
uniform vec4 uBG;   // blend gammas
uniform float uLift;
uniform vec2 uViewport;
in vec2 vUV;
out vec4 outColor;
float edgeF(float d, float w, float g) {
  return w <= 0.0 ? 1.0 : pow(clamp(d / w, 0.0, 1.0), g);
}
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  vec2 sp = gl_FragCoord.xy / uViewport; // origin bottom-left
  float x = sp.x;
  float yTop = 1.0 - sp.y;
  float a = edgeF(x, uBW.x, uBG.x) * edgeF(1.0 - x, uBW.y, uBG.y)
          * edgeF(yTop, uBW.z, uBG.z) * edgeF(1.0 - yTop, uBW.w, uBG.w);
  vec3 col = c * a * (1.0 - uLift) + vec3(uLift);
  outColor = vec4(col, 1.0);
}`;

const FS_UV_FLOAT = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
void main() {
  outColor = vec4(vUV.x, 1.0 - vUV.y, 0.0, 1.0);
}`;

// Fallback when float render targets are unavailable: pack each UV channel
// as 16-bit big-endian into two 8-bit channels (u -> RG, v -> BA via two
// draws is avoidable: u16 in RG, v16 in BA fits one RGBA8 pixel, but alpha
// is needed as a coverage flag — so u in RG, v in B+coverage trick won't
// fit. We use two RGBA8 passes instead: pass 0 packs u, pass 1 packs v.)
const FS_UV_PACKED = `#version 300 es
precision highp float;
uniform int uChannel; // 0 = u, 1 = v
in vec2 vUV;
out vec4 outColor;
void main() {
  float val = uChannel == 0 ? vUV.x : 1.0 - vUV.y;
  float q = floor(clamp(val, 0.0, 1.0) * 65535.0 + 0.5);
  outColor = vec4(floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0, 0.0, 1.0);
}`;

const FS_WIRE = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.bindAttribLocation(prog, 1, 'aUV');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

export interface DrawOpts {
  /** blend widths in output px, [l, r, t, b] */
  blendWidths: [number, number, number, number];
  blendGammas: [number, number, number, number];
  lift: number;
  outputW: number;
  outputH: number;
}

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private progDisplay: WebGLProgram;
  private progUVFloat: WebGLProgram;
  private progUVPacked: WebGLProgram;
  private progWire: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private uvBuf: WebGLBuffer;
  private triBuf: WebGLBuffer;
  private wireBuf: WebGLBuffer;
  private triCount = 0;
  private wireCount = 0;
  private texture: WebGLTexture;
  private hasFloatBuf: boolean;
  private uDisplay: Record<string, WebGLUniformLocation | null>;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.hasFloatBuf = gl.getExtension('EXT_color_buffer_float') !== null;
    this.progDisplay = link(gl, VS, FS_DISPLAY);
    this.progUVFloat = link(gl, VS, FS_UV_FLOAT);
    this.progUVPacked = link(gl, VS, FS_UV_PACKED);
    this.progWire = link(gl, VS, FS_WIRE);
    this.uDisplay = {
      uTex: gl.getUniformLocation(this.progDisplay, 'uTex'),
      uBW: gl.getUniformLocation(this.progDisplay, 'uBW'),
      uBG: gl.getUniformLocation(this.progDisplay, 'uBG'),
      uLift: gl.getUniformLocation(this.progDisplay, 'uLift'),
      uViewport: gl.getUniformLocation(this.progDisplay, 'uViewport'),
    };
    this.vao = gl.createVertexArray()!;
    this.posBuf = gl.createBuffer()!;
    this.uvBuf = gl.createBuffer()!;
    this.triBuf = gl.createBuffer()!;
    this.wireBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  setPattern(src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  setMesh(mesh: WarpMesh): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    this.triCount = mesh.indices.length;
    // Wireframe: a sparse subset of mesh rows/columns, full-resolution along
    // each line so curves stay smooth.
    const n = mesh.tess + 1;
    const stride = Math.max(1, Math.round(mesh.tess / 16));
    const lines: number[] = [];
    for (let r = 0; r < n; r += stride) {
      for (let c = 0; c < n - 1; c++) lines.push(r * n + c, r * n + c + 1);
    }
    for (let c = 0; c < n; c += stride) {
      for (let r = 0; r < n - 1; r++) lines.push(r * n + c, (r + 1) * n + c);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(lines), gl.DYNAMIC_DRAW);
    this.wireCount = lines.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  draw(o: DrawOpts, wireframe: boolean): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progDisplay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uDisplay.uTex, 0);
    gl.uniform4f(
      this.uDisplay.uBW,
      o.blendWidths[0] / o.outputW,
      o.blendWidths[1] / o.outputW,
      o.blendWidths[2] / o.outputH,
      o.blendWidths[3] / o.outputH,
    );
    gl.uniform4f(this.uDisplay.uBG, o.blendGammas[0], o.blendGammas[1], o.blendGammas[2], o.blendGammas[3]);
    gl.uniform1f(this.uDisplay.uLift, o.lift);
    gl.uniform2f(this.uDisplay.uViewport, w, h);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuf);
    gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_INT, 0);
    if (wireframe && this.wireCount > 0) {
      gl.useProgram(this.progWire);
      gl.uniform4f(gl.getUniformLocation(this.progWire, 'uColor'), 0.3, 0.55, 0.3, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireBuf);
      gl.drawElements(gl.LINES, this.wireCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  /**
   * Rasterize the currently-set mesh into a w*h UV map and read it back.
   * Returns RGB float triples (u, v, 0) with rows BOTTOM-TO-TOP — exactly
   * the PFM payload. Pixels not covered by the warp mesh get (-1, -1, 0),
   * which MPCDI consumers treat as unmapped/black.
   */
  renderUVMap(w: number, h: number): Float32Array {
    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const out = new Float32Array(w * h * 3);

    const drawMesh = () => {
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); // alpha 0 marks "unmapped"
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuf);
      gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    };

    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      if (this.hasFloatBuf) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.useProgram(this.progUVFloat);
        drawMesh();
        const px = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        for (let i = 0; i < w * h; i++) {
          const mapped = px[i * 4 + 3] > 0.5;
          out[i * 3] = mapped ? px[i * 4] : -1;
          out[i * 3 + 1] = mapped ? px[i * 4 + 1] : -1;
        }
      } else {
        // 16-bit packed fallback, one pass per channel.
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.useProgram(this.progUVPacked);
        const loc = gl.getUniformLocation(this.progUVPacked, 'uChannel');
        const px = new Uint8Array(w * h * 4);
        for (let ch = 0; ch < 2; ch++) {
          gl.uniform1i(loc, ch);
          drawMesh();
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          for (let i = 0; i < w * h; i++) {
            const mapped = px[i * 4 + 3] > 0;
            out[i * 3 + ch] = mapped ? (px[i * 4] * 256 + px[i * 4 + 1]) / 65535 : -1;
          }
        }
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
    }
    return out;
  }
}
