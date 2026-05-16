const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try { require('express'); require('multer'); require('ws'); }
catch (e) { execSync('npm install express multer ws', { stdio: 'inherit' }); }

const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use(express.json());

// ── Upload ─────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '___' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sem arquivo' });
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json({ id: req.file.filename, name: name.replace(/\.[^/.]+$/, ''), size: req.file.size, url: '/video/' + req.file.filename });
});

app.get('/videos', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv)$/i.test(f));
  const list = files.map(f => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, f));
    return { id: f, name: f.replace(/^\d+___/, '').replace(/\.[^/.]+$/, ''), size: stat.size, url: '/video/' + f, addedAt: stat.birthtimeMs };
  }).sort((a, b) => b.addedAt - a.addedAt);
  res.json(list);
});

app.delete('/video/:f', (req, res) => {
  const fp = path.join(UPLOAD_DIR, req.params.f);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

function serveVideo(fp, req, res) {
  const stat = fs.statSync(fp);
  const size = stat.size;
  const mime = { '.mp4':'video/mp4','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/mp4','.wmv':'video/x-ms-wmv' }[path.extname(fp).toLowerCase()] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
}

app.get('/video/:f', (req, res) => {
  const fp = path.join(UPLOAD_DIR, req.params.f);
  if (!fs.existsSync(fp)) return res.status(404).send('Não encontrado');
  serveVideo(fp, req, res);
});

app.get('/stream/:code', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).send('Sessão não encontrada');
  const fp = path.join(UPLOAD_DIR, s.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Arquivo não encontrado');
  serveVideo(fp, req, res);
});

// ── Sessões ────────────────────────────────────────────────────────────────
const sessions = {};
function randCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

app.post('/session/create', (req, res) => {
  const { filename } = req.body;
  if (!filename || !fs.existsSync(path.join(UPLOAD_DIR, filename)))
    return res.status(404).json({ error: 'Arquivo não encontrado' });
  const code = randCode();
  sessions[code] = {
    filename,
    playing: false,
    currentTime: 0,
    updatedAt: Date.now(),
    hostWs: null,
    viewers: new Set()
  };
  res.json({ code, watchUrl: `/watch/${code}`, controlUrl: `/control/${code}` });
});

// Calcula o tempo atual da sessão
function liveTime(s) {
  if (!s.playing) return s.currentTime;
  return s.currentTime + (Date.now() - s.updatedAt) / 1000;
}

// Envia estado atual para um WebSocket
function sendState(ws, s) {
  ws.send(JSON.stringify({ type: 'state', playing: s.playing, currentTime: liveTime(s) }));
}

// Broadcast para todos os espectadores
function broadcast(s) {
  const msg = JSON.stringify({ type: 'state', playing: s.playing, currentTime: liveTime(s) });
  s.viewers.forEach(v => { if (v.readyState === 1) v.send(msg); });
}

// ── Tela de Aguardando ─────────────────────────────────────────────────────
app.get('/waiting', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CINE BLACKWOOD</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@300;400&display=swap');
* { margin:0; padding:0; box-sizing:border-box; }
html,body { background:#080808; width:100%; height:100%; overflow:hidden; display:flex; align-items:center; justify-content:center; }

/* Grain */
body::before {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E");
  opacity:0.4;
}

.wrap { position:relative; z-index:1; text-align:center; display:flex; flex-direction:column; align-items:center; gap:2.5rem; }

/* Logo */
.logo-top {
  font-family:'Barlow Condensed',sans-serif;
  font-weight:300; font-size:clamp(0.7rem,1.5vw,1rem);
  letter-spacing:0.55em; color:#c0392b; text-transform:uppercase;
  margin-bottom:0.3rem;
}
.logo-main {
  font-family:'Bebas Neue',sans-serif;
  font-size:clamp(3rem,10vw,7rem);
  letter-spacing:0.1em; color:#e8e4dc; line-height:1;
}
.logo-main span { color:#b8965a; }

/* Linha vermelha */
.line {
  width: clamp(60px,10vw,120px);
  height:1px; background:#c0392b;
  animation: expand 2s ease forwards;
}
@keyframes expand { from { width:0; opacity:0; } to { width:clamp(60px,10vw,120px); opacity:1; } }

/* Texto aguardando */
.waiting-text {
  font-family:'Barlow Condensed',sans-serif;
  font-size:clamp(0.8rem,2vw,1.1rem);
  letter-spacing:0.4em; color:#555; text-transform:uppercase;
  animation: pulse 2.5s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity:0.3; } 50% { opacity:1; } }

/* Dots */
.dots { display:inline-block; }
.dots span { animation: blink 1.4s infinite; opacity:0; }
.dots span:nth-child(2) { animation-delay:0.2s; }
.dots span:nth-child(3) { animation-delay:0.4s; }
@keyframes blink { 0%,80%,100% { opacity:0; } 40% { opacity:1; } }

/* Scanlines */
body::after {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
}
</style>
</head>
<body>
<div class="wrap">
  <div>
    <div class="logo-top">Visuals &amp; Cinema</div>
    <div class="logo-main">CINE <span>BLACKWOOD</span></div>
  </div>
  <div class="line"></div>
  <div class="waiting-text">
    Aguardando início<span class="dots"><span>.</span><span>.</span><span>.</span></span>
  </div>
</div>
</body>
</html>`);
});

// ── Página do espectador ───────────────────────────────────────────────────
app.get('/watch/:code', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).send('Sessão não encontrada.');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CINE BLACKWOOD</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { background:#000; width:100%; height:100%; overflow:hidden; }
video { width:100vw; height:100vh; object-fit:contain; display:block; }
#unmuteBtn {
  display:none; position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
  background:#c0392b; border:none; color:#fff; padding:12px 32px;
  font-family:sans-serif; font-size:1rem; letter-spacing:0.1em; cursor:pointer; z-index:99;
}
</style>
</head>
<body>
<video id="v" playsinline></video>
<button id="unmuteBtn" onclick="this.style.display='none';document.getElementById('v').muted=false;">🔊 ATIVAR SOM</button>
<script>
const v = document.getElementById('v');
const code = '${req.params.code}';
let loaded = false;

function applyState(playing, currentTime) {
  if (!loaded) return;
  const drift = Math.abs(v.currentTime - currentTime);
  if (drift > 1.5) v.currentTime = currentTime;
  if (playing && v.paused) {
    const isFiveM = /FiveM|CitizenFX/i.test(navigator.userAgent);
    if (isFiveM) {
      // FiveM: autoplay com som funciona normalmente
      v.muted = false;
      v.play().catch(() => {});
    } else {
      // Navegador normal: precisa de muted para autoplay funcionar
      v.muted = true;
      v.play().catch(() => {});
      document.getElementById('unmuteBtn').style.display = 'block';
    }
  }
  if (!playing && !v.paused) v.pause();
}

// Carrega vídeo mas não dá play ainda
v.src = '/stream/' + code;
v.addEventListener('loadedmetadata', () => { loaded = true; });
v.load();

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(proto + '://' + location.host + '/ws/' + code + '?role=viewer');

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'state') {
    if (!loaded) {
      // Ainda não carregou — espera e aplica
      v.addEventListener('loadedmetadata', () => {
        applyState(msg.playing, msg.currentTime);
      }, { once: true });
    } else {
      applyState(msg.playing, msg.currentTime);
    }
  }
};

ws.onclose = () => setTimeout(() => location.reload(), 3000);

// Resync a cada 5s
setInterval(() => {
  if (!loaded || v.paused || !v.duration) return;
  // não resync via timer, só via WS
}, 5000);
</script>
</body>
</html>`);
});

// ── Página de controle ─────────────────────────────────────────────────────
app.get('/control/:code', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).send('Sessão não encontrada.');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CONTROLE — CINE BLACKWOOD</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { background:#0d0d0d; color:#e0e0e0; font-family:sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1.2rem; padding:2rem; }
h1 { font-size:0.9rem; letter-spacing:0.3em; color:#c0392b; text-transform:uppercase; }
video { width:100%; max-width:560px; background:#000; border:1px solid #222; max-height:320px; }
.row { display:flex; gap:0.8rem; flex-wrap:wrap; justify-content:center; }
button { background:#1a1a1a; border:1px solid #333; color:#e0e0e0; padding:10px 22px; font-size:0.85rem; cursor:pointer; letter-spacing:0.08em; transition:background 0.15s; min-width:90px; }
button:hover { background:#c0392b; border-color:#c0392b; }
#ppBtn { background:#c0392b; border-color:#c0392b; font-size:1rem; padding:12px 32px; }
.seek-row { width:100%; max-width:560px; display:flex; align-items:center; gap:0.8rem; }
input[type=range] { flex:1; accent-color:#c0392b; height:4px; }
.t { font-size:0.78rem; color:#666; min-width:38px; }
.info { font-size:0.72rem; color:#444; letter-spacing:0.1em; }
.urlbox { background:#111; border:1px solid #1e1e1e; padding:10px 14px; font-size:0.75rem; color:#555; word-break:break-all; max-width:560px; width:100%; }
.urlbox b { color:#b8965a; font-weight:normal; }
</style>
</head>
<body>
<h1>🎬 Controle do Cinema — ${req.params.code}</h1>
<video id="v" preload="auto" playsinline></video>
<div class="seek-row">
  <span class="t" id="curT">0:00</span>
  <input type="range" id="seek" value="0" min="0" step="1" oninput="onSeek(this.value)">
  <span class="t" id="durT">0:00</span>
</div>
<div class="row">
  <button id="ppBtn" onclick="togglePlay()">▶ PLAY</button>
  <button onclick="skip(-10)">⏪ -10s</button>
  <button onclick="skip(10)">+10s ⏩</button>
</div>
<div class="info" id="viewers">0 espectadores conectados</div>
<div class="urlbox">URL espectadores: <b id="wurl">—</b></div>
<script>
document.getElementById('wurl').textContent = location.origin + '/watch/${req.params.code}';
const v = document.getElementById('v');
const ppBtn = document.getElementById('ppBtn');
const seekEl = document.getElementById('seek');
let wsReady = false;

v.src = '/stream/${req.params.code}';
v.load();

v.addEventListener('loadedmetadata', () => {
  seekEl.max = Math.floor(v.duration);
  document.getElementById('durT').textContent = fmt(v.duration);
});
v.addEventListener('timeupdate', () => {
  seekEl.value = Math.floor(v.currentTime);
  document.getElementById('curT').textContent = fmt(v.currentTime);
});

function fmt(s) { return isNaN(s)?'0:00':Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'); }

function broadcast() {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: 'control', playing: !v.paused, currentTime: v.currentTime }));
}

function togglePlay() {
  if (v.paused) {
    v.play().then(() => { ppBtn.textContent = '⏸ PAUSE'; broadcast(); }).catch(()=>{});
  } else {
    v.pause();
    ppBtn.textContent = '▶ PLAY';
    broadcast();
  }
}

function skip(d) { v.currentTime = Math.max(0, v.currentTime + d); broadcast(); }
function onSeek(val) { v.currentTime = parseFloat(val); broadcast(); }

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(proto + '://' + location.host + '/ws/${req.params.code}?role=host');
ws.onopen = () => { wsReady = true; };
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'viewers') document.getElementById('viewers').textContent = msg.count + ' espectador' + (msg.count !== 1 ? 'es' : '') + ' conectado' + (msg.count !== 1 ? 's' : '');
};
// Broadcast periódico para manter sync
setInterval(() => { if (!v.paused) broadcast(); }, 4000);
</script>
</body>
</html>`);
});

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const code = urlParts[2]?.split('?')[0];
  const role = new URL('http://x' + req.url).searchParams.get('role');
  const s = sessions[code];
  if (!s) return ws.close();

  if (role === 'host') {
    s.hostWs = ws;
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'control') {
          s.playing = msg.playing;
          s.currentTime = msg.currentTime;
          s.updatedAt = Date.now();
          broadcast(s);
        }
      } catch(e) {}
    });
    ws.on('close', () => { s.hostWs = null; });
  }

  if (role === 'viewer') {
    s.viewers.add(ws);
    sendState(ws, s);
    if (s.hostWs?.readyState === 1) s.hostWs.send(JSON.stringify({ type: 'viewers', count: s.viewers.size }));
    ws.on('close', () => {
      s.viewers.delete(ws);
      if (s.hostWs?.readyState === 1) s.hostWs.send(JSON.stringify({ type: 'viewers', count: s.viewers.size }));
    });
  }
});

server.listen(PORT, () => console.log('CineBlackwood porta ' + PORT));
