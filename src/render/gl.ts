/**
 * WebGL2 pipeline (multi-region).
 *
 * Display pass: each region's warp mesh (positions = its slice of the
 * mosaic canvas, uvs = region-local) is rasterized with the shared
 * content texture. The fragment shader derives the content UV from the
 * region's src window and computes the blend alpha from the LOCAL uv in
 * content pixels — so blend ramps ride the warp and follow keystoned or
 * curved seams.
 *
 * UV-export pass: a region's mesh (region-local positions) is rasterized
 * into an offscreen target at that region's output resolution, writing
 * the absolute content-space UV (v flipped to bottom-left origin per the
 * PFM/MPCDI convention). Reading it back yields the per-pixel warp map —
 * rasterization performs the forward->inverse inversion for us.
 *
 * Coordinate conventions:
 *   - display positions are mosaic-canvas fractions, (0,0)=top-left
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
uniform vec4 uSrc;    // content window: x, y, w, h (fractions)
uniform vec2 uSrcPx;  // content window size in content px
uniform vec4 uBW;     // blend widths (l, r, t, b) in content px
uniform vec4 uBG;     // blend gammas
uniform float uLift;
in vec2 vUV;          // region-local uv
out vec4 outColor;
// MUST stay identical to edgeFalloff() in render/blend.ts — normalized
// power ramp, so neighbouring regions' ramps sum to 1 at every gamma.
float edgeF(float d, float w, float g) {
  if (w <= 0.0) return 1.0;
  float t = clamp(d / w, 0.0, 1.0);
  if (t <= 0.0) return 0.0;
  if (t >= 1.0) return 1.0;
  float a = pow(t, g);
  float b = pow(1.0 - t, g);
  return a / (a + b);
}
void main() {
  vec2 cuv = uSrc.xy + vUV * uSrc.zw;
  vec3 c = texture(uTex, cuv).rgb;
  float a = edgeF(vUV.x * uSrcPx.x, uBW.x, uBG.x)
          * edgeF((1.0 - vUV.x) * uSrcPx.x, uBW.y, uBG.y)
          * edgeF(vUV.y * uSrcPx.y, uBW.z, uBG.z)
          * edgeF((1.0 - vUV.y) * uSrcPx.y, uBW.w, uBG.w);
  vec3 col = c * a * (1.0 - uLift) + vec3(uLift);
  outColor = vec4(col, 1.0);
}`;

const FS_UV_FLOAT = `#version 300 es
precision highp float;
uniform vec4 uSrc;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec2 cuv = uSrc.xy + vUV * uSrc.zw;
  outColor = vec4(cuv.x, 1.0 - cuv.y, 0.0, 1.0);
}`;

// Fallback when float render targets are unavailable: 16-bit big-endian
// packing of one channel per pass into RG of an RGBA8 target.
const FS_UV_PACKED = `#version 300 es
precision highp float;
uniform vec4 uSrc;
uniform int uChannel; // 0 = u, 1 = v
in vec2 vUV;
out vec4 outColor;
void main() {
  vec2 cuv = uSrc.xy + vUV * uSrc.zw;
  float val = uChannel == 0 ? cuv.x : 1.0 - cuv.y;
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

/** Per-region draw parameters (content window + blend). */
export interface RegionDrawUniforms {
  src: [number, number, number, number];
  srcPx: [number, number];
  blendWidths: [number, number, number, number];
  blendGammas: [number, number, number, number];
  lift: number;
}

interface RegionGpu {
  vao: WebGLVertexArrayObject;
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  triBuf: WebGLBuffer;
  wireBuf: WebGLBuffer;
  triCount: number;
  wireCount: number;
}

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private progDisplay: WebGLProgram;
  private progUVFloat: WebGLProgram;
  private progUVPacked: WebGLProgram;
  private progWire: WebGLProgram;
  private regs: RegionGpu[] = [];
  private exportReg: RegionGpu | null = null;
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
      uSrc: gl.getUniformLocation(this.progDisplay, 'uSrc'),
      uSrcPx: gl.getUniformLocation(this.progDisplay, 'uSrcPx'),
      uBW: gl.getUniformLocation(this.progDisplay, 'uBW'),
      uBG: gl.getUniformLocation(this.progDisplay, 'uBG'),
      uLift: gl.getUniformLocation(this.progDisplay, 'uLift'),
    };
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  private createRegionGpu(): RegionGpu {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    const posBuf = gl.createBuffer()!;
    const uvBuf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return {
      vao,
      posBuf,
      uvBuf,
      triBuf: gl.createBuffer()!,
      wireBuf: gl.createBuffer()!,
      triCount: 0,
      wireCount: 0,
    };
  }

  private disposeRegionGpu(r: RegionGpu): void {
    const gl = this.gl;
    gl.deleteVertexArray(r.vao);
    gl.deleteBuffer(r.posBuf);
    gl.deleteBuffer(r.uvBuf);
    gl.deleteBuffer(r.triBuf);
    gl.deleteBuffer(r.wireBuf);
  }

  setRegionCount(n: number): void {
    while (this.regs.length < n) this.regs.push(this.createRegionGpu());
    while (this.regs.length > n) this.disposeRegionGpu(this.regs.pop()!);
  }

  private uploadMesh(reg: RegionGpu, mesh: WarpMesh): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, reg.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, reg.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, reg.triBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    reg.triCount = mesh.indices.length;
    // Wireframe: a sparse subset of mesh rows/columns, full-resolution
    // along each line so curves stay smooth.
    const n = mesh.tess + 1;
    const stride = Math.max(1, Math.round(mesh.tess / 16));
    const lines: number[] = [];
    for (let r = 0; r < n; r += stride) {
      for (let c = 0; c < n - 1; c++) lines.push(r * n + c, r * n + c + 1);
    }
    for (let c = 0; c < n; c += stride) {
      for (let r = 0; r < n - 1; r++) lines.push(r * n + c, (r + 1) * n + c);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, reg.wireBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(lines), gl.DYNAMIC_DRAW);
    reg.wireCount = lines.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  setRegionMesh(i: number, mesh: WarpMesh): void {
    if (i < 0 || i >= this.regs.length) return;
    this.uploadMesh(this.regs[i], mesh);
  }

  setPattern(src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  draw(unis: RegionDrawUniforms[], wireframe: boolean): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const n = Math.min(unis.length, this.regs.length);
    gl.useProgram(this.progDisplay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uDisplay.uTex, 0);
    for (let i = 0; i < n; i++) {
      const reg = this.regs[i];
      const u = unis[i];
      if (reg.triCount === 0) continue;
      gl.uniform4f(this.uDisplay.uSrc, u.src[0], u.src[1], u.src[2], u.src[3]);
      gl.uniform2f(this.uDisplay.uSrcPx, u.srcPx[0], u.srcPx[1]);
      gl.uniform4f(this.uDisplay.uBW, u.blendWidths[0], u.blendWidths[1], u.blendWidths[2], u.blendWidths[3]);
      gl.uniform4f(this.uDisplay.uBG, u.blendGammas[0], u.blendGammas[1], u.blendGammas[2], u.blendGammas[3]);
      gl.uniform1f(this.uDisplay.uLift, u.lift);
      gl.bindVertexArray(reg.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, reg.triBuf);
      gl.drawElements(gl.TRIANGLES, reg.triCount, gl.UNSIGNED_INT, 0);
    }
    if (wireframe) {
      gl.useProgram(this.progWire);
      const loc = gl.getUniformLocation(this.progWire, 'uColor');
      gl.uniform4f(loc, 0.3, 0.55, 0.3, 1);
      for (let i = 0; i < n; i++) {
        const reg = this.regs[i];
        if (reg.wireCount === 0) continue;
        gl.bindVertexArray(reg.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, reg.wireBuf);
        gl.drawElements(gl.LINES, reg.wireCount, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
  }

  /**
   * Rasterize a region-local mesh into a w*h content-UV map and read it
   * back. Returns RGB float triples (u, v, 0) with rows BOTTOM-TO-TOP —
   * exactly the PFM payload (UVs absolute in the mosaic content space).
   * Pixels not covered by the warp mesh get (-1, -1, 0).
   */
  renderUVMap(mesh: WarpMesh, src: [number, number, number, number], w: number, h: number): Float32Array {
    const gl = this.gl;
    if (!this.exportReg) this.exportReg = this.createRegionGpu();
    this.uploadMesh(this.exportReg, mesh);
    const reg = this.exportReg;
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
      gl.bindVertexArray(reg.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, reg.triBuf);
      gl.drawElements(gl.TRIANGLES, reg.triCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    };

    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      if (this.hasFloatBuf) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.useProgram(this.progUVFloat);
        gl.uniform4f(gl.getUniformLocation(this.progUVFloat, 'uSrc'), src[0], src[1], src[2], src[3]);
        drawMesh();
        const px = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        for (let i = 0; i < w * h; i++) {
          const mapped = px[i * 4 + 3] > 0.5;
          out[i * 3] = mapped ? px[i * 4] : -1;
          out[i * 3 + 1] = mapped ? px[i * 4 + 1] : -1;
        }
      } else {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.useProgram(this.progUVPacked);
        gl.uniform4f(gl.getUniformLocation(this.progUVPacked, 'uSrc'), src[0], src[1], src[2], src[3]);
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
