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
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '___' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sem arquivo' });
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json({ id: req.file.filename, name: originalName.replace(/\.[^/.]+$/, ''), size: req.file.size, url: '/video/' + req.file.filename });
});

app.get('/videos', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv)$/i.test(f));
  const list = files.map(f => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, f));
    const name = f.replace(/^\d+___/, '').replace(/\.[^/.]+$/, '');
    return { id: f, name, size: stat.size, url: '/video/' + f, addedAt: stat.birthtimeMs };
  }).sort((a, b) => b.addedAt - a.addedAt);
  res.json(list);
});

app.delete('/video/:filename', (req, res) => {
  const fp = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── Servir vídeo com Range ─────────────────────────────────────────────────
function serveVideo(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.mp4':'video/mp4','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/mp4','.wmv':'video/x-ms-wmv' };
  const mime = mimeMap[ext] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
}

app.get('/video/:filename', (req, res) => {
  const fp = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Não encontrado');
  serveVideo(fp, req, res);
});

app.get('/stream/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).send('Sessão não encontrada');
  const fp = path.join(UPLOAD_DIR, session.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Arquivo não encontrado');
  serveVideo(fp, req, res);
});

// ── Sessões ────────────────────────────────────────────────────────────────
// { code: { filename, playing, currentTime, lastUpdate, hostWs } }
const sessions = {};

function randomCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

app.post('/session/create', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename obrigatório' });
  const fp = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  const code = randomCode();
  sessions[code] = { filename, playing: false, currentTime: 0, lastUpdate: Date.now(), hostWs: null, viewers: new Set() };
  res.json({ code, watchUrl: `/watch/${code}`, controlUrl: `/control/${code}` });
});

// ── Página do espectador (/watch/:code) ────────────────────────────────────
app.get('/watch/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).send('Sessão não encontrada.');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CINE BLACKWOOD</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { background:#000; width:100%; height:100%; overflow:hidden; }
    video { width:100vw; height:100vh; object-fit:contain; display:block; }
    #overlay { position:fixed; inset:0; background:#000; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1rem; }
    #status { color:#555; font-family:sans-serif; font-size:0.85rem; letter-spacing:0.15em; text-align:center; }
    #playbtn { background:#c0392b; border:none; color:#fff; padding:14px 40px; font-size:1rem; cursor:pointer; letter-spacing:0.15em; font-family:sans-serif; display:none; }
  </style>
</head>
<body>
  <video id="v" preload="auto" playsinline></video>
  <div id="overlay">
    <div id="status">AGUARDANDO O CINEMA INICIAR...</div>
    <button id="playbtn" onclick="userReady()">▶ ENTRAR NA SESSÃO</button>
  </div>
  <script>
    const v = document.getElementById('v');
    const overlay = document.getElementById('overlay');
    const status = document.getElementById('status');
    const playbtn = document.getElementById('playbtn');
    const code = '${req.params.code}';
    let ready = false;
    let pendingState = null;

    v.src = '/stream/' + code;
    v.load();

    // Mostra botão após 2s para garantir interação do usuário (desbloqueio de autoplay)
    setTimeout(() => { playbtn.style.display = 'block'; }, 2000);

    function userReady() {
      ready = true;
      overlay.style.display = 'none';
      if (pendingState) applyState(pendingState);
    }

    function applyState(state) {
      if (!ready) { pendingState = state; return; }
      const drift = Math.abs(v.currentTime - state.currentTime);
      if (drift > 1.5) v.currentTime = state.currentTime;
      if (state.playing && v.paused) v.play().catch(()=>{});
      if (!state.playing && !v.paused) v.pause();
    }

    // WebSocket
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws/' + code + '?role=viewer');

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') applyState(msg);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    };

    ws.onclose = () => { status.textContent = 'CONEXÃO PERDIDA. RECARREGUE A PÁGINA.'; overlay.style.display = 'flex'; };
  </script>
</body>
</html>`);
});

// ── Página de controle do host (/control/:code) ────────────────────────────
app.get('/control/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).send('Sessão não encontrada.');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CONTROLE — CINE BLACKWOOD</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { background:#0a0a0a; color:#e0e0e0; font-family:sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1.5rem; padding:2rem; }
    h1 { font-size:1rem; letter-spacing:0.3em; color:#c0392b; text-transform:uppercase; }
    video { width:100%; max-width:600px; background:#000; border:1px solid #222; }
    .btns { display:flex; gap:1rem; flex-wrap:wrap; justify-content:center; }
    button { background:#1a1a1a; border:1px solid #333; color:#e0e0e0; padding:10px 24px; font-size:0.9rem; cursor:pointer; letter-spacing:0.1em; transition:background 0.2s; }
    button:hover { background:#c0392b; border-color:#c0392b; }
    .viewers { font-size:0.75rem; color:#555; letter-spacing:0.1em; }
    .seek-wrap { width:100%; max-width:600px; display:flex; align-items:center; gap:0.8rem; }
    input[type=range] { flex:1; accent-color:#c0392b; }
    .t { font-size:0.8rem; color:#555; min-width:40px; }
    .url-box { background:#111; border:1px solid #222; padding:10px 16px; font-size:0.8rem; color:#888; word-break:break-all; max-width:600px; width:100%; }
    .url-box span { color:#b8965a; }
  </style>
</head>
<body>
  <h1>🎬 Controle do Cinema — ${req.params.code}</h1>
  <video id="v" preload="auto" playsinline></video>
  <div class="seek-wrap">
    <span class="t" id="curT">0:00</span>
    <input type="range" id="seekBar" value="0" min="0" step="0.5" />
    <span class="t" id="durT">0:00</span>
  </div>
  <div class="btns">
    <button id="ppBtn">▶ PLAY</button>
    <button onclick="seek(-10)">⏪ -10s</button>
    <button onclick="seek(10)">+10s ⏩</button>
  </div>
  <div class="viewers" id="viewers">0 espectadores conectados</div>
  <div class="url-box">URL para os espectadores: <span>${req.protocol}://${req.get('host')}/watch/${req.params.code}</span></div>
  <script>
    const v = document.getElementById('v');
    const ppBtn = document.getElementById('ppBtn');
    const seekBar = document.getElementById('seekBar');
    const code = '${req.params.code}';
    let isBroadcasting = false;

    v.src = '/stream/' + code;
    v.load();
    v.addEventListener('loadedmetadata', () => {
      seekBar.max = v.duration;
      document.getElementById('durT').textContent = fmt(v.duration);
    });
    v.addEventListener('timeupdate', () => {
      seekBar.value = v.currentTime;
      document.getElementById('curT').textContent = fmt(v.currentTime);
    });

    function fmt(s) { return isNaN(s)?'0:00':Math.floor(s/60)+':'+Math.floor(s%60).toString().padStart(2,'0'); }
    function seek(d) { v.currentTime = Math.max(0, v.currentTime + d); broadcast(); }

    seekBar.addEventListener('input', () => { v.currentTime = parseFloat(seekBar.value); broadcast(); });

    ppBtn.addEventListener('click', () => {
      if (v.paused) { v.play(); ppBtn.textContent = '⏸ PAUSE'; } 
      else { v.pause(); ppBtn.textContent = '▶ PLAY'; }
      broadcast();
    });

    // WebSocket
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws/' + code + '?role=host');

    function broadcast() {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'control', playing: !v.paused, currentTime: v.currentTime }));
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'viewers') document.getElementById('viewers').textContent = msg.count + ' espectador' + (msg.count !== 1 ? 'es' : '') + ' conectado' + (msg.count !== 1 ? 's' : '');
    };

    // Broadcast automático a cada 3s para manter sync
    setInterval(broadcast, 3000);
  </script>
</body>
</html>`);
});

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const parts = req.url.split('/');
  const code = parts[2]?.split('?')[0];
  const role = new URL('http://x' + req.url).searchParams.get('role');
  const session = sessions[code];
  if (!session) return ws.close();

  if (role === 'host') {
    session.hostWs = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'control') {
        session.playing = msg.playing;
        session.currentTime = msg.currentTime;
        session.lastUpdate = Date.now();
        // Envia estado para todos os espectadores
        const state = JSON.stringify({ type: 'state', playing: msg.playing, currentTime: msg.currentTime });
        session.viewers.forEach(v => { if (v.readyState === 1) v.send(state); });
      }
    });
    ws.on('close', () => { session.hostWs = null; });
  }

  if (role === 'viewer') {
    session.viewers.add(ws);
    // Envia estado atual imediatamente
    const elapsed = (Date.now() - session.lastUpdate) / 1000;
    const currentTime = session.playing ? session.currentTime + elapsed : session.currentTime;
    ws.send(JSON.stringify({ type: 'state', playing: session.playing, currentTime }));
    // Notifica o host do novo espectador
    if (session.hostWs?.readyState === 1) session.hostWs.send(JSON.stringify({ type: 'viewers', count: session.viewers.size }));
    ws.on('close', () => {
      session.viewers.delete(ws);
      if (session.hostWs?.readyState === 1) session.hostWs.send(JSON.stringify({ type: 'viewers', count: session.viewers.size }));
    });
  }
});

server.listen(PORT, () => console.log('CineBlackwood porta ' + PORT));
