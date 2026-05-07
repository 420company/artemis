// HTML page that loads two image textures, runs a Saga shader, and exposes
// a `window.__sagaShaderRender(progress)` function that the host (Playwright)
// invokes per frame. The host then captures the canvas via screenshot.
//
// The template is parameterized at build-time with:
//   {{WIDTH}} / {{HEIGHT}} — canvas pixel dimensions
//   {{ACCENT_HEX}}         — accent color (e.g. "f8c96a")
//   {{IMG_A_DATA}}         — data URL for segment A's last frame
//   {{IMG_B_DATA}}         — data URL for segment B's first frame
//   {{FRAGMENT_GLSL}}      — fragment shader source

const TEMPLATE = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Saga Shader Renderer</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="c" width="{{WIDTH}}" height="{{HEIGHT}}"></canvas>
<script>
  const W = {{WIDTH}};
  const H = {{HEIGHT}};
  const ACCENT_HEX = "{{ACCENT_HEX}}";

  const accent = [
    parseInt(ACCENT_HEX.slice(0, 2), 16) / 255,
    parseInt(ACCENT_HEX.slice(2, 4), 16) / 255,
    parseInt(ACCENT_HEX.slice(4, 6), 16) / 255,
  ];

  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: true });
  if (!gl) {
    document.body.innerHTML = '<pre style="color:#fff">WebGL not available</pre>';
    window.__sagaShaderError = 'no_webgl';
    throw new Error('saga: WebGL unavailable');
  }

  const VERT = "attribute vec2 aPos; varying vec2 vUv; void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }";
  const FRAG = {{FRAGMENT_GLSL}};

  function compile(source, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      throw new Error('saga shader compile error: ' + log);
    }
    return shader;
  }

  const vs = compile(VERT, gl.VERTEX_SHADER);
  const fs = compile(FRAG, gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('saga shader link error: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  // Full-screen triangle pair.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uA = gl.getUniformLocation(prog, 'uA');
  const uB = gl.getUniformLocation(prog, 'uB');
  const uProgress = gl.getUniformLocation(prog, 'uProgress');
  const uResolution = gl.getUniformLocation(prog, 'uResolution');
  const uAccent = gl.getUniformLocation(prog, 'uAccent');

  function loadTexture(unit, dataUrl) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        resolve(tex);
      };
      img.onerror = function (e) { reject(new Error('saga: image load failed')); };
      img.src = dataUrl;
    });
  }

  let texA = null;
  let texB = null;

  Promise.all([
    loadTexture(0, "{{IMG_A_DATA}}"),
    loadTexture(1, "{{IMG_B_DATA}}"),
  ]).then(function (results) {
    texA = results[0];
    texB = results[1];
    window.__sagaShaderReady = true;
  }).catch(function (err) {
    window.__sagaShaderError = err.message;
  });

  gl.viewport(0, 0, W, H);

  window.__sagaShaderRender = function (progress) {
    if (!texA || !texB) return false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.uniform1i(uA, 0);
    gl.uniform1i(uB, 1);
    gl.uniform1f(uProgress, progress);
    gl.uniform2f(uResolution, W, H);
    gl.uniform3f(uAccent, accent[0], accent[1], accent[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
    return true;
  };
</script>
</body>
</html>
`;

export type SagaShaderTemplateInput = {
  width: number;
  height: number;
  accentHex: string; // e.g. "f8c96a"
  imageADataUrl: string; // data:image/png;base64,...
  imageBDataUrl: string;
  fragmentSource: string;
};

export function buildSagaShaderHtml(input: SagaShaderTemplateInput): string {
  // Embed the fragment shader as a JS template literal so it carries newlines
  // safely. Escape backticks and \${} interpolations defensively.
  const safeFragment = '`' + input.fragmentSource.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
  const accent = input.accentHex.replace(/^#/, '').padStart(6, '0').slice(0, 6).toLowerCase();
  return TEMPLATE
    .replace(/\{\{WIDTH\}\}/g, String(input.width))
    .replace(/\{\{HEIGHT\}\}/g, String(input.height))
    .replace(/\{\{ACCENT_HEX\}\}/g, accent)
    .replace(/\{\{IMG_A_DATA\}\}/g, input.imageADataUrl)
    .replace(/\{\{IMG_B_DATA\}\}/g, input.imageBDataUrl)
    .replace(/\{\{FRAGMENT_GLSL\}\}/g, safeFragment);
}
