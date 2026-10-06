# Vendored motion libraries

Libraries a motion scene can name in its graphic's `libs`, served to the sandboxed frame over
`fabula-motion://lib/<name>.js` (`electron/motion-protocol.cjs`). They ship with Fabula, so a
scene that uses one renders the same on every machine.

| Name | File | Version | Licence |
| --- | --- | --- | --- |
| `three` | `three.min.js` | three.js 0.186.1 | MIT (`three.LICENSE`) |

`three.min.js` is `build/three.module.js` from the npm package, bundled into one script that sets
`window.THREE`:

```bash
echo 'export * from "three";' > entry.js
npx esbuild entry.js --bundle --minify --format=iife --global-name=THREE --legal-comments=inline --outfile=three.min.js
```
