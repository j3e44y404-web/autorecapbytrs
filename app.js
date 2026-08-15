/* Video Dubbing Platform — browser-only orchestration for source preview, subtitle generation, and VoxCPM audio. */
const CONFIG = {
  voxcpmBase: 'https://openbmb-voxcpm-demo.hf.space/gradio_api',
  whisperSpace: 'https://hf-audio-whisper-large-v3.hf.space',
  whisperApiCandidates: ['/transcribe', '/predict'],
  translationEndpoint: 'https://api.mymemory.translated.net/get',
  translationFrom: 'en',
  translationTo: 'my',
  voxCpmCfg: 2.0,
};

const state = {
  sourceFile: null,
  sourceUrl: '',
  selectedFormat: 'original',
  selectedOutput: 'audio',
  volume: 0,
  referenceAudio: null,
  generatedAudioUrl: '',
  finalVideoUrl: '',
  sourceDuration: 0,
  subtitles: [],
  transcript: '',
  translatedText: '',
  processing: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showToast(message, duration = 3600) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), duration);
}

function setStatus(message, type = 'ready') {
  $('#connectionText').textContent = message;
  const pill = $('.connection-pill');
  pill.dataset.status = type;
}

function setPipeline(step, percent) {
  const order = ['source', 'transcribe', 'translate', 'voice'];
  const index = order.indexOf(step);
  $$('.pipeline-step').forEach((node, nodeIndex) => node.classList.toggle('active', nodeIndex <= index));
  $('#pipelineProgress').style.width = `${percent}%`;
  $('#pipelinePercent').textContent = `${percent}%`;
}

function formatSeconds(seconds) {
  const whole = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = Math.floor(whole % 60);
  const millis = Math.floor((whole % 1) * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

function buildSrt(lines) {
  return lines.map((line, index) => `${index + 1}\n${formatSeconds(line.start)} --> ${formatSeconds(line.end)}\n${line.text}\n`).join('\n');
}

function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function updatePreviewOverlay() {
  const text = $('#watermarkText').value.trim();
  $('#previewOverlay').textContent = text;
  $('#previewOverlay').style.display = text ? 'block' : 'none';
}

function attachLocalVideo(file) {
  state.sourceFile = file;
  state.sourceUrl = '';
  const url = URL.createObjectURL(file);
  const video = $('#videoPreview');
  video.src = url;
  video.classList.add('is-visible');
  $('.empty-preview').classList.add('hidden');
  $('#previewTitle').textContent = file.name;
  $('#sourceStatus').textContent = `${file.name} selected`;
  $('#timelineStatus').textContent = 'Local preview ready';
  $('#emptyTitle').textContent = 'Video loaded';
  setPipeline('source', 16);
  setStatus('Source ready', 'ready');
  video.onloadedmetadata = () => {
    state.sourceDuration = video.duration || 0;
    $('.toolbar-meta').innerHTML = `${video.videoWidth || 1920} × ${video.videoHeight || 1080} <b>•</b> ${formatSeconds(video.duration || 0).slice(0, 5)}`;
  };
  showToast('Video preview ready.');
}

function attachRemotePreview(url) {
  state.sourceUrl = url.trim();
  state.sourceFile = null;
  const video = $('#videoPreview');
  video.src = state.sourceUrl;
  video.classList.add('is-visible');
  $('.empty-preview').classList.add('hidden');
  $('#previewTitle').textContent = 'Remote video source';
  $('#sourceStatus').textContent = 'URL source selected';
  $('#timelineStatus').textContent = 'Remote preview requested';
  setPipeline('source', 16);
  setStatus('URL source ready', 'ready');
  video.addEventListener('error', () => {
    video.classList.remove('is-visible');
    $('.empty-preview').classList.remove('hidden');
    $('#emptyTitle').textContent = 'Preview unavailable';
    $('#emptyCopy').innerHTML = 'The URL is accepted for processing<br />but may not support direct browser preview.';
    showToast('This URL does not expose a browser-playable video preview.', 5200);
  }, { once: true });
}

function setBusy(isBusy) {
  state.processing = isBusy;
  $('#generateButton').disabled = isBusy;
  $('#generateButton').innerHTML = isBusy ? '<span class="spinner">◌</span> Processing… <small>Please wait</small>' : '<span>✣</span> SRT ထုတ်ပါ <small>⌘ Enter</small>';
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error || data?.detail || `Request failed (${response.status})`);
  return data;
}

async function uploadToGradio(base, file) {
  const form = new FormData();
  form.append('files', file, file.name || 'reference.wav');
  const result = await fetchJson(`${base}/upload`, { method: 'POST', body: form });
  const path = Array.isArray(result) ? result[0] : result.path || result[0];
  if (!path) throw new Error('VoxCPM upload returned no file path.');
  return { path, url: result.url || `${base.replace('/gradio_api', '')}/file=${encodeURIComponent(path)}` };
}

function parseSseEvent(raw) {
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  let data = '';
  lines.forEach((line) => {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  });
  let parsed = data;
  try { parsed = data ? JSON.parse(data) : null; } catch { /* keep string */ }
  return { event, data: parsed };
}

function normalizeAudioResult(data) {
  const candidates = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      if (/\.(wav|mp3|flac|ogg)(\?|$)/i.test(value) || value.startsWith('/file=') || value.startsWith('http')) candidates.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value === 'object') {
      ['url', 'path', 'name', 'audio', 'value'].forEach((key) => visit(value[key]));
      Object.values(value).forEach((item) => { if (item && typeof item === 'object') visit(item); });
    }
  };
  visit(data);
  return candidates[0] || '';
}

let ffmpegInstance = null;
let ffmpegLoading = null;

async function loadFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    const FFmpegCtor = window.FFmpegWASM?.FFmpeg || window.FFmpegWASM?.default || window.FFmpeg?.FFmpeg || window.FFmpeg;
    const util = window.FFmpegUtil || window.FFmpeg?.util || {};
    if (!FFmpegCtor || !util.fetchFile || !util.toBlobURL) throw new Error('FFmpeg.wasm CDN did not load.');
    const ffmpeg = new FFmpegCtor();
    ffmpeg.on('progress', ({ progress }) => {
      const percent = Math.max(80, Math.min(98, 80 + Math.round((Number(progress) || 0) * 18)));
      $('#pipelineProgress').style.width = `${percent}%`;
      $('#pipelinePercent').textContent = `${percent}%`;
      setStatus(`Mixing video… ${percent}%`, 'busy');
    });
    const coreBase = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    await ffmpeg.load({
      coreURL: await util.toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await util.toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();
  try { return await ffmpegLoading; } finally { ffmpegLoading = null; }
}

function escapeFilterText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");
}

function makeVideoFilter() {
  const filters = [];
  if (state.selectedFormat === '9:16') filters.push('crop=ih*9/16:ih,scale=720:1280');
  if (state.selectedFormat === '1:1') filters.push('crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080');
  if (state.selectedFormat === '16:9') filters.push('crop=ih*16/9:ih,scale=1280:720');
  if ($('[data-toggle="flipVideo"]')?.getAttribute('aria-pressed') === 'true') filters.push('hflip');
  const watermark = $('#watermarkText').value.trim();
  if (watermark) filters.push(`drawtext=text='${escapeFilterText(watermark)}':fontcolor=white@0.9:fontsize=28:x=w-tw-24:y=h-th-24:box=1:boxcolor=black@0.38:boxborderw=8`);
  if ($('[data-toggle="fadeVideo"]')?.getAttribute('aria-pressed') === 'true' && state.sourceDuration > 1) {
    const fadeStart = Math.max(0.6, state.sourceDuration - 0.45).toFixed(2);
    filters.push(`fade=t=in:st=0:d=0.45,fade=t=out:st=${fadeStart}:d=0.45`);
  }
  return filters.join(',') || 'null';
}

async function muxVideoWithAudio() {
  if (!state.sourceFile) throw new Error('A local source video file is required for browser muxing.');
  if (!state.generatedAudioUrl) throw new Error('VoxCPM did not return an audio file.');
  const ffmpeg = await loadFfmpeg();
  const util = window.FFmpegUtil;
  setStatus('Loading source into FFmpeg…', 'busy');
  const sourceBytes = await util.fetchFile(state.sourceFile);
  const audioBytes = await util.fetchFile(state.generatedAudioUrl);
  await ffmpeg.writeFile('source.mp4', sourceBytes);
  await ffmpeg.writeFile('dubbed.wav', audioBytes);
  const filter = makeVideoFilter();
  const args = ['-i', 'source.mp4', '-i', 'dubbed.wav', '-map', '0:v:0', '-map', '1:a:0', '-vf', filter, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'final-dubbed.mp4'];
  try {
    await ffmpeg.exec(args);
  } catch (error) {
    console.warn('Primary mux failed, retrying with voice-only video mapping.', error);
    await ffmpeg.exec(['-i', 'source.mp4', '-i', 'dubbed.wav', '-map', '0:v:0', '-map', '1:a:0', '-vf', filter, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', 'final-dubbed.mp4']);
  }
  const output = await ffmpeg.readFile('final-dubbed.mp4');
  const blob = new Blob([output.buffer], { type: 'video/mp4' });
  state.finalVideoUrl = URL.createObjectURL(blob);
  return state.finalVideoUrl;
}

async function generateVoxCpm(text) {
  if (!state.referenceAudio) throw new Error('A reference audio file is required for Voice Clone Only mode.');
  const reference = await uploadToGradio(CONFIG.voxcpmBase, state.referenceAudio);
  const sessionHash = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const voiceStyle = 'Clone the uploaded reference speaker faithfully. Preserve the speaker identity, pacing, warmth, and natural expressiveness while speaking clear Myanmar text.';
  const data = [text, voiceStyle, { path: reference.path, url: reference.url, orig_name: state.referenceAudio.name, meta: { _type: 'gradio.FileData' } }, false, '', CONFIG.voxCpmCfg, true, true];
  await fetchJson(`${CONFIG.voxcpmBase}/queue/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn_index: 2, trigger_id: 2, session_hash: sessionHash, data }) });
  return new Promise((resolve, reject) => {
    const stream = new EventSource(`${CONFIG.voxcpmBase}/queue/data?fn_index=2&session_hash=${encodeURIComponent(sessionHash)}`);
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; stream.close(); callback(value); };
    stream.onmessage = (message) => {
      const parsed = parseSseEvent(`event: message\ndata: ${message.data}`);
      const payload = parsed.data;
      if (!payload) return;
      const status = payload.msg || payload.status || '';
      if (/process_starts|generating|progress/i.test(status)) setStatus('VoxCPM generating voice…', 'busy');
      if (payload.progress_data?.[0]?.progress != null) setPipeline('voice', 78 + Math.round(Number(payload.progress_data[0].progress) * 18));
      if (/complete|success/i.test(status) || payload.output) {
        const url = normalizeAudioResult(payload.output || payload.data || payload);
        if (url) finish(resolve, url);
      }
    };
    stream.addEventListener('complete', (event) => finish(resolve, normalizeAudioResult(parseSseEvent(`event: complete\ndata: ${event.data}`).data)));
    stream.addEventListener('error', (event) => finish(reject, new Error(event?.data || 'VoxCPM stream failed.')));
    stream.onerror = () => finish(reject, new Error('VoxCPM stream disconnected.'));
    window.setTimeout(() => finish(reject, new Error('VoxCPM timed out.')), 150000);
  });
}

async function transcribeWithWhisper(file) {
  if (!file) throw new Error('Whisper needs a local audio/video file.');
  const endpointBase = CONFIG.whisperSpace.replace(/\/$/, '');
  const form = new FormData();
  form.append('files', file, file.name || 'source.mp4');
  const uploaded = await fetchJson(`${endpointBase}/gradio_api/upload`, { method: 'POST', body: form });
  const uploadedPath = Array.isArray(uploaded) ? uploaded[0] : uploaded.path || uploaded[0];
  const fileData = { path: uploadedPath, orig_name: file.name, meta: { _type: 'gradio.FileData' } };
  let lastError;
  for (const apiName of CONFIG.whisperApiCandidates) {
    try {
      const response = await fetchJson(`${endpointBase}/gradio_api/call${apiName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [fileData] }) });
      if (response.event_id) {
        const result = await readGradioCallStream(`${endpointBase}/gradio_api/call${apiName}/${response.event_id}`);
        return extractTranscript(result);
      }
      return extractTranscript(response.data || response);
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Whisper endpoint unavailable.');
}

async function readGradioCallStream(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Whisper stream failed (${response.status})`);
  const text = await response.text();
  const events = text.split(/\n\nevent:/).map((chunk, index) => index === 0 ? chunk : `event:${chunk}`);
  let latest = null;
  events.forEach((chunk) => { const parsed = parseSseEvent(chunk); if (parsed.data != null) latest = parsed.data; });
  return latest;
}

function extractTranscript(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return extractTranscript(data[0]);
  if (data && typeof data === 'object') return data.text || data.transcription || data.value || data.data || '';
  return '';
}

async function translateToMyanmar(text) {
  if (!text.trim()) throw new Error('Whisper returned an empty transcript.');
  const url = new URL(CONFIG.translationEndpoint);
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${CONFIG.translationFrom}|${CONFIG.translationTo}`);
  const result = await fetchJson(url.toString());
  const translated = result?.responseData?.translatedText || result?.matches?.[0]?.translation;
  if (!translated) throw new Error('Translation API returned no Myanmar text.');
  return translated;
}

function createSubtitleLines(text) {
  const sentences = text.split(/(?<=[။!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const parts = sentences.length ? sentences : [text.trim()];
  const duration = Math.max(2.8, Math.min(7, 42 / parts.length));
  return parts.map((part, index) => ({ start: index * duration, end: (index + 1) * duration, text: part }));
}

function showOutput(translated) {
  state.subtitles = createSubtitleLines(translated);
  $('#subtitlePreview').textContent = buildSrt(state.subtitles);
  $('#transcriptCard').classList.remove('hidden');
  $('#resultActions').classList.add('hidden');
  $('#resultNote').textContent = 'Waiting for VoxCPM cloned audio. The local source video will remain available for download.';
  if (state.generatedAudioUrl) {
    const audio = $('#dubbedAudio');
    audio.src = state.generatedAudioUrl;
    audio.classList.toggle('hidden', state.selectedOutput === 'subtitle');
  } else $('#dubbedAudio').classList.add('hidden');
}

function createFallbackTranscript() {
  return 'ဒီဗီဒီယိုအတွက် စာတန်းကို အခု ပြင်ဆင်နေပါတယ်။\nသင့် Hugging Face Space သို့မဟုတ် local file ကို စစ်ဆေးပြီး ပြန်လည်ကြိုးစားနိုင်ပါတယ်။';
}

async function runPipeline() {
  if (!state.sourceFile && !state.sourceUrl) {
    showToast('အရင်ဆုံး Video URL သို့မဟုတ် Video File ထည့်ပါ။', 4800);
    $('#videoUrl').focus();
    return;
  }
  if (!state.referenceAudio) {
    showToast('Voice Clone Only အတွက် reference audio ဖိုင် ထည့်ပါ။', 5200);
    $('#referenceAudio').focus();
    return;
  }
  setBusy(true);
  setStatus('Starting pipeline…', 'busy');
  $('#transcriptCard').classList.add('hidden');
  try {
    let transcript = '';
    if (state.sourceFile) {
      setPipeline('transcribe', 28); setStatus('Whisper transcribing…', 'busy');
      try { transcript = await transcribeWithWhisper(state.sourceFile); } catch (error) { console.warn(error); showToast('Whisper Space မရသေးပါ။ Demo transcript နဲ့ ဆက်လုပ်ပါမယ်။', 5200); transcript = createFallbackTranscript(); }
    } else {
      setPipeline('transcribe', 28); transcript = createFallbackTranscript();
      showToast('URL source တွေအတွက် browser-only fallback transcript ကို သုံးထားပါတယ်။', 5200);
    }
    state.transcript = transcript;
    setPipeline('translate', 52); setStatus('Translating to Myanmar…', 'busy');
    let translated = transcript;
    try { translated = await translateToMyanmar(transcript); } catch (error) { console.warn(error); showToast('Translation API မရသေးပါ။ Myanmar draft ကို ပြထားပါတယ်။', 5200); }
    state.translatedText = translated;
    showOutput(translated);
    if (state.selectedOutput !== 'subtitle') {
      setPipeline('voice', 78); setStatus('VoxCPM generating voice…', 'busy');
      try {
        const audioPath = await generateVoxCpm(translated);
        const base = CONFIG.voxcpmBase.replace('/gradio_api', '');
        state.generatedAudioUrl = audioPath.startsWith('http') ? audioPath : audioPath.startsWith('/file=') ? `${base}${audioPath}` : `${base}/file=${encodeURIComponent(audioPath)}`;
        const audio = $('#dubbedAudio'); audio.src = state.generatedAudioUrl; audio.classList.remove('hidden');
        $('#resultActions').classList.remove('hidden');
        $('#resultNote').textContent = 'VoxCPM audio ready. FFmpeg.wasm will now combine it with the source video and apply your selected options.';
        if (state.sourceFile) {
          setPipeline('voice', 84); setStatus('Preparing browser video mix…', 'busy');
          try {
            const finalUrl = await muxVideoWithAudio();
            const video = $('#videoPreview');
            video.src = finalUrl;
            video.classList.add('is-visible');
            $('.empty-preview').classList.add('hidden');
            $('#previewTitle').textContent = 'Myanmar dubbed video';
            $('#timelineStatus').textContent = 'Final video ready';
            $('#resultNote').textContent = 'Video + Myanmar cloned voice mixed in your browser with FFmpeg.wasm.';
          } catch (muxError) {
            console.warn(muxError);
            $('#resultNote').textContent = 'FFmpeg.wasm could not complete the video mix in this browser. The cloned audio and SRT remain available.';
            showToast('Browser video mix failed. Try a smaller local MP4 and keep this tab open.', 6200);
          }
        }
      } catch (error) {
        console.warn(error);
        showToast('VoxCPM မရသေးပါ။ SRT ကိုတော့ download လုပ်နိုင်ပါတယ်။', 5800);
      }
    }
    setPipeline('voice', 100); setStatus('Ready to export', 'ready');
    $('#emptyTitle').textContent = 'Myanmar dub ready';
    $('#emptyCopy').innerHTML = 'Myanmar cloned voice ready<br />Video + audio downloads are below.';
    showToast('Myanmar subtitle draft ready.');
  } finally { setBusy(false); }
}

function bindControls() {
  $('#urlFileButton').addEventListener('click', () => $('#videoFile').click());
  $('#videoFile').addEventListener('change', (event) => { const file = event.target.files?.[0]; if (file) attachLocalVideo(file); });
  $('#videoUrl').addEventListener('change', (event) => { const value = event.target.value.trim(); if (value) attachRemotePreview(value); });
  $('#videoUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); attachRemotePreview(event.currentTarget.value); } });
  $('#recordButton').addEventListener('click', () => showToast('Browser recording UI placeholder — use the file upload or connect a capture source.'));
  $('#referenceAudio').addEventListener('change', (event) => { state.referenceAudio = event.target.files?.[0] || null; $('#cloneFileName').textContent = state.referenceAudio ? state.referenceAudio.name : 'အသံဖိုင် ထည့်ပါ'; $('#cloneStatus').textContent = state.referenceAudio ? 'Reference audio ready for VoxCPM cloning.' : 'Reference audio is required before generation.'; });
  $('#logoFile').addEventListener('change', (event) => { const file = event.target.files?.[0]; if (file) $('#logoName').textContent = file.name; });
  $$('.format-card').forEach((button) => button.addEventListener('click', () => { $$('.format-card').forEach((node) => node.classList.remove('selected')); button.classList.add('selected'); state.selectedFormat = button.dataset.format; $('#previewMode').textContent = button.dataset.format; }));
  $$('.output-card').forEach((button) => button.addEventListener('click', () => { $$('.output-card').forEach((node) => node.classList.remove('selected')); button.classList.add('selected'); state.selectedOutput = button.dataset.output; $('#dubbedAudio').classList.toggle('hidden', state.selectedOutput === 'subtitle'); }));
  $('#volumeSlider').addEventListener('input', (event) => { state.volume = Number(event.target.value); $('#volumeValue').textContent = `${state.volume}%`; event.target.style.background = `linear-gradient(90deg,var(--cyan) 0%,var(--cyan) ${state.volume}%,#34455a ${state.volume}%,#34455a 100%)`; });
  $('#watermarkText').addEventListener('input', updatePreviewOverlay);
  $$('.switch').forEach((button) => button.addEventListener('click', () => { const isOn = button.getAttribute('aria-pressed') === 'true'; button.setAttribute('aria-pressed', String(!isOn)); }));
  $('#generateButton').addEventListener('click', runPipeline);
  $('#downloadSrt').addEventListener('click', () => { if (!state.subtitles.length) return showToast('Generate subtitles first.'); downloadText('myanmar-dub.srt', buildSrt(state.subtitles), 'application/x-subrip;charset=utf-8'); });
  $('#downloadVideo').addEventListener('click', () => { if (!state.finalVideoUrl) return showToast('Generate the final mixed video first.'); const anchor = document.createElement('a'); anchor.href = state.finalVideoUrl; anchor.download = 'myanmar-dubbed-video.mp4'; anchor.click(); });
  $('#supportButton').addEventListener('click', () => showToast('Support: add your preferred help email or community link here.'));
  $('#themeToggle').addEventListener('click', () => { document.body.classList.toggle('light-mode'); showToast('Dark interface is the recommended studio mode.'); });
  document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') runPipeline(); });
}

bindControls();
