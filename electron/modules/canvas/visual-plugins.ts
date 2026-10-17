import { z } from 'zod';
import { canvasVisualPlugins } from '../../../src/shared/canvas-plugins';
import type { CanvasNode, CanvasOutput } from '../../../src/shared/canvas';
import type { CanvasNodePlugins } from './node-plugins';

export function registerVisualPlugins(
  registry: CanvasNodePlugins,
  resolve: (node: CanvasNode) => Promise<CanvasOutput>,
) {
  const dispose = canvasVisualPlugins.map((definition) =>
    registry.register({
      definition,
      schema:
        definition.id === 'visual.sticky-note'
          ? z
              .object({
                color: z
                  .enum(['yellow', 'pink', 'blue', 'green'])
                  .default('yellow')
                  .meta({ title: '便签颜色' }),
              })
              .strict()
          : definition.id === 'visual.panorama'
            ? z
                .object({
                  yaw: z.number().min(-180).max(180).default(0).meta({ title: '水平角度' }),
                  pitch: z.number().min(-85).max(85).default(0).meta({ title: '俯仰角度' }),
                  fov: z.number().min(30).max(110).default(75).meta({ title: '视野角度' }),
                })
                .strict()
            : z.object({}).strict(),
      execute: async ({ node }) => {
        if (definition.id === 'visual.panorama') {
          if (!node.resource) throw new Error('请先选择全景图片');
          return resolve(node);
        }
        return { text: node.text ?? '', resources: [] };
      },
    }),
  );
  return () => dispose.reverse().forEach((fn) => fn());
}
