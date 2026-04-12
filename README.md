Pen-Plot Portrait — Camera to SVG

This is a small client-side web app that:
- uses your camera to take a selfie
- runs person segmentation (BodyPix) to remove the background
- vectorizes the person into an SVG using ImageTracer
- offers three styles: Outline, Pixelated, Squiggly
- exports an SVG with stroke-only black paths suitable for pen plotting

Quick start (from the folder that contains these files):

1) Run a simple local HTTP server (required for camera access in modern browsers):

```bash
# Python 3
python -m http.server 8000
```

2) Open http://localhost:8000/pen-plot-app/ in Chrome or Firefox, allow camera access, then use the controls.

Notes:
- Model files (BodyPix) are downloaded from CDN at runtime — first run may be slow.
- This is a client-only demo; no images are uploaded to any server.
- For better pen-plot output you may tweak `Detail` and try different styles.

Files:
- index.html — main UI
- style.css — simple styling
- app.js — logic: camera, segmentation, vectorization, download

