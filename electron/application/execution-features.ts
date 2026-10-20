import { importsPlugin } from './features/imports';
import { networkPlugin } from './features/network';
import { appearancePlugin } from './features/appearance';
import { canvasPlugin } from './features/canvas';
import { botsPlugin } from './features/bots';
import { attachmentsPlugin } from './features/attachments';
import { projectsPlugin } from './features/projects';
import { channelsPlugin } from './features/channels';
import { connectionsPlugin } from './features/connections';
import { sessionsPlugin } from './features/sessions';
import { capabilitiesPlugin } from './features/capabilities';
import { workspacePlugin } from './features/workspace';
import { tasksPlugin } from './features/tasks';
import { knowledgePlugin } from './features/knowledge';
import { contentPlugin } from './features/content';
import { automationPlugin } from './features/automation';
import { artifactsPlugin } from './features/artifacts';
import { pluginsPlugin } from './features/plugins';
import { agentsPlugin } from './features/agents';

export const executionFeatures = [
  importsPlugin,
  networkPlugin,
  appearancePlugin,
  attachmentsPlugin,
  projectsPlugin,
  channelsPlugin,
  botsPlugin,
  connectionsPlugin,
  sessionsPlugin,
  capabilitiesPlugin,
  workspacePlugin,
  tasksPlugin,
  knowledgePlugin,
  contentPlugin,
  canvasPlugin,
  automationPlugin,
  artifactsPlugin,
  pluginsPlugin,
  agentsPlugin,
];
