# Video Dubbing Platform — GitHub Pages

This folder contains the standalone static build. Upload `index.html`, `style.css`, and `app.js` to the root of a GitHub repository, then enable **Settings → Pages → Deploy from a branch** and select the branch and root folder containing these files.

The interface works without a backend for local video preview, control selection, Myanmar SRT generation, and SRT download. The browser-side integrations call public third-party services: a Hugging Face Whisper Space, MyMemory translation, and the VoxCPM Hugging Face Space. These services can change endpoint names, rate limits, or browser CORS behavior. The API URLs and Whisper endpoint candidates are kept near the top of `app.js` for easy adjustment.

For voice cloning, choose a local audio reference under **Voice clone reference**. For preset TTS, leave the reference empty and select the Myanmar voice. Video URLs are accepted for the workflow, but direct browser preview and transcription of YouTube/TikTok URLs depend on the source allowing cross-origin media access; local file upload is the most reliable GitHub Pages path.

## Files

| File | Purpose |
|---|---|
| `index.html` | Complete interface markup and font loading. |
| `style.css` | Dark navy/cyan responsive visual system. |
| `app.js` | UI state, local preview, SRT generation, Whisper/translation adapters, and VoxCPM queue/SSE integration. |
