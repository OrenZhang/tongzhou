<p align="center"><img src="docs/assets/logo.svg" width="78" alt="CoSail" /></p>
<h1 align="center">CoSail 同舟</h1>
<p align="center"><strong>Journey with AI. Bring ideas to life.</strong></p>
<p align="center">Windows · macOS · Open source · Local first</p>
<p align="center"><a href="README.md">简体中文</a> · English</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou/releases">Downloads & releases</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">Report an issue</a> · <a href="CONTRIBUTING.md">Contribute</a></p>

CoSail is an open-source, local-first AI workspace. Bring models, conversations, knowledge, and creative work together—and take an idea through to completion.

## What you can do

- **Choose your models**: Connect ChatGPT, Kimi, MiniMax, compatible APIs, and local models. Switch between them within the same conversation.
- **Build your knowledge**: Keep documents, notes, and conversation memories together. Let AI help you find, organize, and reuse them.
- **Create on a canvas**: Build workflows through conversation, connecting text, image, video, audio, and tool nodes.
- **Draw with AI**: Use the integrated Excalidraw whiteboard to sketch diagrams by hand, ask AI to add shapes, edit selections, and adjust layouts.
- **Work on projects**: Search files, write code, review changes, and keep refining your work.
- **Connect your tools**: Extend your workspace with MCP, Skills, channel notifications, and scheduled tasks.
- **Stay in control**: Store conversations and materials locally, with backups, recovery, and permission controls.

The interface supports English and Simplified Chinese. Switch under **Settings → Appearance & fonts → Language**.

## Get started

Get a release from [Releases](https://github.com/OrenZhang/tongzhou/releases), or run from source with Node.js **22.19+ (22 LTS)**, npm, and Git:

```bash
git clone https://github.com/OrenZhang/tongzhou.git
cd tongzhou
npm ci
npm run dev
```

Open **Models** to add a connection or sign in with a supported account, then start a conversation. Configure and enable additional tools under **Plugins**.

## Learn more

The detailed guides below are currently in Chinese.

- [User guide](docs/USAGE.md) · [Local knowledge](docs/KNOWLEDGE-CENTER.md) · [Canvas node plugins](docs/CANVAS_NODES.md)
- [Contributing](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Releasing](docs/RELEASING.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md) · [Validation records](docs/VALIDATION.md)

CoSail is a development preview. Model and plugin capabilities depend on the service and your account's access. When you use cloud services, the content needed for the task is sent to that service. Remote channels and scheduled tasks require the local client to be online.

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party notices.
