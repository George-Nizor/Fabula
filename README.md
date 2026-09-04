# Fabula

Raw footage in. A told story out.

Fabula is a transcript-driven talking-head video editor: it transcribes a recording locally
(WhisperX on CUDA), proposes cuts for dead air, fillers, and false starts, lets you review every
cut as strikethrough text before anything renders, then plans and composites visuals around the
speaker — with Claude as the editor in the loop, on the Max subscription.

Read [`docs/product-brief.md`](docs/product-brief.md) first: it holds the pipeline, the
architecture, the decisions already made, and what has been proven or disproven.

## Development

```bash
npm install
npm test              # core cut-engine suite (pure node, no tools needed)
npm run setup:tools   # static ffmpeg + WhisperX venv, no sudo
npm start             # Electron shell
```

Part of the [Instrumenta workspace](../README.md); not yet registered in the launcher catalog.
