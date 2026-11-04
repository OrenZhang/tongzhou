<p align="center"><img src="docs/assets/logo.svg" width="78" alt="CoSail" /></p>
<h1 align="center">CoSail 同舟</h1>
<p align="center"><strong>Code, handle tasks, and deliver work with AI.</strong></p>
<p align="center">Windows · macOS · Linux · Open source · Local first</p>
<p align="center"><a href="README.md">简体中文</a> · English</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou/releases/latest">Download</a> · <a href="docs/USAGE.md">User guide</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">Report an issue</a></p>

CoSail is an open-source AI desktop workspace for developers and creators working on real projects. It brings models, project files, task conversations, knowledge, and creative tools into one application: AI can read context, use tools, edit files, run checks, and save results where you can keep working with them.

Work toward a concrete goal across sessions: **understand a project → edit code → run checks → save delivery notes → continue with task memory**.

## Core capabilities

### Coding and task execution

- **Work in real projects**: Read and search files, follow project instructions, edit code, run terminal commands, and inspect Git changes.
- **Make verification part of the task**: Register test or build commands as completion checks. Failed checks return to the same task thread for another attempt, with bounded retries and results you can inspect.
- **Keep tasks moving**: Add follow-up instructions, queue work, stop tasks, resume conversations, and record progress, decisions, and next steps in task memory.
- **Choose your models**: Connect ChatGPT, Kimi, or MiniMax accounts, or configure APIs using Chat Completions, Responses, Anthropic, or Gemini protocols. Connect local models through compatible APIs and configure model routing by task type. Capabilities depend on the connection and model.

### Let AI use the workspace

The application's modules are also available as AI tools. Ask AI to search knowledge, organize materials, save delivery notes to the content library, read them back, or work with a workflow canvas and whiteboard.

Documents saved and canvases updated by AI remain in their respective modules, where you can open, inspect, edit, and reuse them. Plugin settings, session permissions, and operation confirmations still apply; steps that need a login or manual action are handed back to you.

### Visual workflows and media creation

- **Build a canvas through conversation**: Connect text, resource, Agent, image, video, audio, and tool nodes, then run a selection or the whole workflow.
- **Orchestrate complex workflows**: Use conditions, iteration, parallel execution of independent nodes, failure branches, and joins. Loop items run sequentially, while independent nodes within an item can run in parallel. Inspect individual results and errors, and reuse valid successful results where the node caching policy allows.
- **Configure media nodes**: Set prompts, reference images, first and last frames, aspect ratios, resolution, and destinations according to each node plugin's capabilities. Preview generated results and save them as artifacts, content-library items, or local files.
- **Reuse existing workflows**: Connect your ComfyUI service, import workflows, save templates, or export canvas projects with their resources.
- **Draw with AI**: Use the integrated Excalidraw whiteboard to sketch diagrams by hand, ask AI to create shapes, edit selections, and adjust layouts.

Media generation requires a configured service or plugin. Available parameters, output types, and quotas depend on that service. See [canvas nodes](docs/CANVAS_NODES.md), [node plugins](docs/CANVAS_PLUGINS.md), and [ComfyUI](docs/COMFYUI.md).

### Knowledge, memory, and extensions

| Capability                    | What it enables                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Knowledge and content library | Collect materials, preserve originals and sources, manage tags and versions, and find and reuse task results.   |
| Task memory and daily memory  | Preserve handoff notes and organize reusable conversation knowledge in the background for review in Knowledge.  |
| MCP and Skills                | Connect external tools and install or configure task skills to bring existing workflows into conversations.     |
| Channels and scheduled tasks  | Receive tasks through configured messaging channels and schedule work; the local client must stay running.      |
| Local permissions             | Choose read-only, ask-when-needed, or full-access permissions per session, alongside plugin and OS permissions. |

## Tasks to try

**Fix code and deliver the result**

> Investigate the export feature in this project, preserving my existing changes. Reproduce the problem, fix it, and run the relevant tests. Save the change notes and verification results to the content library, and leave task memory for the next session.

**Turn reference materials into reusable work**

> Read these API documents and prepare an integration guide based on the current project. Include sources and open questions, save it to Knowledge, and refer to it when we write the code later.

**Build a batch creation workflow**

> Build a canvas that processes these inputs one at a time, chooses a processing path by condition, and runs independent steps in parallel. Record failures, then collect and save the results. Let me review the workflow before running it.

Completion depends on the model, tools, environment, and granted permissions. Tests and completion checks provide execution evidence; review the final work against your actual requirements.

## Download and install

Choose a package for your operating system and processor from the [latest release](https://github.com/OrenZhang/tongzhou/releases/latest):

| Platform              | Architecture | Package               |
| --------------------- | ------------ | --------------------- |
| Windows               | x64          | `.exe` installer      |
| macOS · Apple Silicon | ARM64        | `.dmg` or `.zip`      |
| macOS · Intel         | x64          | `.dmg` or `.zip`      |
| Linux                 | x64          | `.AppImage` or `.deb` |

- Use the release's `SHA256SUMS-*` files to verify downloads. Check the corresponding release notes for signing status and installation instructions.
- Computer interaction on Linux requires X11 / XWayland; native Wayland is not supported yet. System integration features vary by platform.
- Update behavior varies by platform. You can also download a newer installer from Releases. See the [release notes](docs/RELEASE_NOTES.md).

## Get started in three steps

1. **Connect a model**: Open **Models** in the sidebar and sign in with a supported account, or enter an API endpoint, key, and model. You will need the access or credits required by that service.
2. **Start a concrete task**: Create a conversation and select a project folder when coding. Describe the goal, what must be preserved, and how to verify the result; choose an appropriate permission mode.
3. **Connect modules as needed**: Enable tools in **Plugins**, organize materials in **Knowledge**, and open a canvas or whiteboard in **Studio**. Configure **Channels** and **Scheduled tasks** when you need remote entry points or automation.

The interface supports English and Simplified Chinese. Switch under **Settings → Appearance & fonts → Language**. See the [user guide](docs/USAGE.md) for the complete workflow.

## Local data and practical limits

- **Local first does not mean offline**: Conversations, materials, and application settings are stored on your machine. Cloud models and plugins receive the content needed for their tasks; local models require separate setup.
- **Backups have a defined scope**: Export and restore encrypted backups of application-managed data, canvases, and associated resources. Login credentials are excluded. Back up external project folders separately. See [local files and data](docs/LOCAL_FILES.md).
- **Import has format limits**: Knowledge extraction currently focuses on text, without built-in PDF / Office parsing, OCR, or audio/video transcription. A media preview does not mean its contents have been extracted.
- **Background work can consume credits**: Daily memory organization is enabled by default and can be paused or configured in **Scheduled tasks**. Runs may use the selected model's quota. Channels, scheduled tasks, and background organization require the client to be running, the device awake, and any necessary network connection available.
- **Permissions affect real operations**: Full access can automatically approve operations from enabled tools, and terminal commands run as your OS user. OS authorization and plugin settings still apply. The application does not include model-service credits.

CoSail is under active development. See [implementation status](docs/IMPLEMENTATION_STATUS.md) and [validation records](docs/VALIDATION.md) for the implemented scope and verification evidence.

## Run from source

You need Node.js **22.19+**, npm, and Git:

```bash
git clone https://github.com/OrenZhang/tongzhou.git
cd tongzhou
npm ci
npm run dev
```

Building the native computer-interaction component on Linux also requires a C/C++ toolchain and X11 / XTest development libraries: `libx11-dev` and `libxtst-dev` on Debian / Ubuntu. See [Contributing](CONTRIBUTING.md) for more environment requirements.

Common checks and build commands:

```bash
npm run typecheck
npm test
npm run test:work-capabilities
npm run build
npm run test:desktop
npm run check:i18n
```

`test:work-capabilities` checks the complete path through coding, correction after a failed check, content-library delivery, and task memory. It uses locally scripted model responses without paid model calls. Build before running desktop checks, and use an environment with a graphical display. Live-service verification requires separate account configuration; local tests do not establish model quality.

## Documentation and contributing

The detailed guides below are currently in Chinese.

- **Getting started**: [User guide](docs/USAGE.md) · [Project context](docs/PROJECT_CONTEXT.md) · [Knowledge](docs/KNOWLEDGE-CENTER.md)
- **Creation and extensions**: [Canvas nodes](docs/CANVAS_NODES.md) · [Node plugins](docs/CANVAS_PLUGINS.md) · [ComfyUI](docs/COMFYUI.md)
- **AI and application tools**: [Client capabilities](docs/CLIENT_CAPABILITIES.md) · [Model capabilities](docs/MODEL-CAPABILITIES.md)
- **Development**: [Contributing](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Code structure](docs/CODE_STRUCTURE.md) · [Releasing](docs/RELEASING.md)

Report bugs or propose improvements through [Issues](https://github.com/OrenZhang/tongzhou/issues), or contribute a pull request. Include your OS, app version, reproduction steps, and relevant logs, with credentials and personal information removed.

## License

Application code is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party notices. The included AI-drwa comic-production skill materials have a separate [CC BY-NC 4.0 license](skills/manju-production/LICENSE) and are not covered by the application's Apache-2.0 license.

CoSail is an independent open-source project, not an official product of any model or service provider.
