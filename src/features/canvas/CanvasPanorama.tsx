import { t as tr } from '../../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import type { CanvasRendererProps } from './node-renderers';

/** Equirectangular projection; local WebGL renderer with no network/CDN runtime. */
export function CanvasPanorama({ api, node, patch }: CanvasRendererProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  const camera = useRef({ yaw: 0, pitch: 0, fov: 75 });
  const draw = useRef(() => {});
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  useEffect(() => {
    camera.current = {
      yaw: Number(node.config?.yaw ?? 0),
      pitch: Number(node.config?.pitch ?? 0),
      fov: Number(node.config?.fov ?? 75),
    };
    draw.current();
  }, [node.config?.yaw, node.config?.pitch, node.config?.fov]);
  useEffect(() => {
    setError('');
    const element = canvas.current!;
    const gl = element.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) {
      setError(tr('当前设备无法使用 WebGL 全景预览'));
      return;
    }
    let alive = true;
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram()!;
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(tr('全景着色器初始化失败'));
      gl.attachShader(program, shader);
    };
    const cleanup = () => {
      alive = false;
      draw.current = () => {};
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      shaders.forEach((shader) => gl.deleteShader(shader));
    };
    try {
      compile(
        gl.VERTEX_SHADER,
        'attribute vec2 p; varying vec2 uv; void main(){ uv=p; gl_Position=vec4(p,0.,1.); }',
      );
      compile(
        gl.FRAGMENT_SHADER,
        `precision mediump float;
        varying vec2 uv; uniform sampler2D picture; uniform vec4 view;
        void main(){
          vec3 ray=normalize(vec3(uv.x*view.w*tan(view.z/2.), uv.y*tan(view.z/2.), 1.));
          ray=vec3(ray.x,ray.y*cos(view.y)+ray.z*sin(view.y),-ray.y*sin(view.y)+ray.z*cos(view.y));
          float u=fract((atan(ray.x,ray.z)+view.x)/6.2831853+0.5);
          float v=0.5-asin(clamp(ray.y,-1.,1.))/3.14159265;
          gl_FragColor=texture2D(picture,vec2(u,v));
        }`,
      );
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(tr('全景程序初始化失败'));
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } catch (e) {
      setError((e as Error).message);
      cleanup();
      return;
    }
    let ready = false;
    draw.current = () => {
      if (!ready || !alive) return;
      element.width = Math.max(1, element.clientWidth * Math.min(devicePixelRatio, 2));
      element.height = Math.max(1, element.clientHeight * Math.min(devicePixelRatio, 2));
      gl.viewport(0, 0, element.width, element.height);
      const c = camera.current,
        rad = Math.PI / 180;
      gl.uniform4f(
        gl.getUniformLocation(program, 'view'),
        c.yaw * rad,
        c.pitch * rad,
        c.fov * rad,
        element.width / element.height,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const observer = new ResizeObserver(() => draw.current());
    observer.observe(element);
    if (node.resource)
      void api
        .canvasResourcePreview(node.resource)
        .then((preview) => {
          if (!alive) return;
          if (preview.type !== 'image' || !preview.content?.startsWith('data:image/'))
            throw new Error(tr('请选择可预览的全景图片'));
          const image = new Image();
          image.onload = () => {
            if (!alive) return;
            if (Math.max(image.width, image.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
              setError(tr('全景图片超过设备纹理尺寸上限，请缩小图片'));
              return;
            }
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            ready = true;
            draw.current();
          };
          image.onerror = () => {
            if (alive) setError(tr('无法解码全景图片'));
          };
          image.src = preview.content;
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      observer.disconnect();
      cleanup();
    };
  }, [api, JSON.stringify(node.resource)]);
  return (
    <div className="canvas-panorama">
      <canvas
        ref={canvas}
        aria-label={tr('全景预览，拖动环视')}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ...camera.current };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const d = drag.current;
          camera.current.yaw =
            ((((d.yaw - (e.clientX - d.x) * 0.3 + 540) % 360) + 360) % 360) - 180;
          camera.current.pitch = Math.max(-85, Math.min(85, d.pitch + (e.clientY - d.y) * 0.3));
          draw.current();
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
          patch({ config: { ...node.config, ...camera.current } });
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const c = camera.current;
          patch({
            config: {
              ...node.config,
              yaw: Math.max(
                -180,
                Math.min(
                  180,
                  c.yaw + (e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0),
                ),
              ),
              pitch: Math.max(
                -85,
                Math.min(85, c.pitch + (e.key === 'ArrowUp' ? 5 : e.key === 'ArrowDown' ? -5 : 0)),
              ),
            },
          });
        }}
      />
      {(!node.resource || error) && <span>{error || tr('在配置面板选择 2:1 全景图片')}</span>}
    </div>
  );
}
