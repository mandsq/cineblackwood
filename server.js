const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try { require('express'); require('multer'); }
catch (e) { execSync('npm install express multer', { stdio: 'inherit' }); }

const express = require('express');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// ── Sessões de cinema ao vivo ──────────────────────────────────────────────
// { code: { filename, startedAt } }
const sessions = {};

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

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

// ── Rotas principais ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sem arquivo' });
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json({
    id: req.file.filename,
    name: originalName.replace(/\.[^/.]+$/, ''),
    size: req.file.size,
    url: '/video/' + req.file.filename
  });
});

app.get('/videos', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv)$/i.test(f));
  const list = files.map(f => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, f));
    const name = f.replace(/^\d+___/, '').replace(/\.[^/.]+$/, '');
    return { id: f, name, size: stat.size, url: '/video/' + f, addedAt: stat.birthtimeMs };
  }).sort((a, b) => b.addedAt - a.addedAt);
  res.json(list);
});

// ── Stream de vídeo com Range ──────────────────────────────────────────────
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Não encontrado');
  serveVideo(filePath, req, res);
});

// ── CRIAR sessão de cinema (transmissão sincronizada) ─────────────────────
// POST /session/create  { filename }
app.use(express.json());
app.post('/session/create', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename obrigatório' });
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });

  const code = randomCode();
  sessions[code] = { filename, startedAt: Date.now() };
  res.json({ code, watchUrl: `/watch/${code}` });
});

// ── Página de cinema (para o script do GTA RP apontar) ────────────────────
app.get('/watch/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).send('Sessão não encontrada ou expirada.');

  // Calcula quantos segundos já se passaram desde que a sessão começou
  const elapsed = (Date.now() - session.startedAt) / 1000;
  const filePath = path.join(UPLOAD_DIR, session.filename);
  const stat = fs.statSync(filePath);

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
    #overlay { position:fixed; inset:0; background:#000; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1.5rem; cursor:pointer; }
    #overlay p { color:#555; font-family:sans-serif; font-size:0.8rem; letter-spacing:0.15em; }
    #playbtn { background:#c0392b; border:none; color:#fff; padding:16px 48px; font-size:1.1rem; cursor:pointer; letter-spacing:0.15em; font-family:sans-serif; }
  </style>
</head>
<body>
  <video id="v" preload="auto" playsinline></video>
  <div id="overlay">
    <button id="playbtn">▶ ASSISTIR</button>
    <p>CINE BLACKWOOD</p>
  </div>
  <script>
    const v = document.getElementById('v');
    const overlay = document.getElementById('overlay');
    const startedAt = ${session.startedAt};

    function getExpected() {
      return (Date.now() - startedAt) / 1000;
    }

    function startVideo() {
      overlay.style.display = 'none';
      const expected = getExpected();
      // Tenta setar o tempo — se o vídeo ainda não carregou, seta quando puder
      if (v.readyState >= 1 && v.duration) {
        v.currentTime = Math.min(expected, v.duration - 0.5);
      } else {
        v.addEventListener('loadedmetadata', () => {
          v.currentTime = Math.min(getExpected(), v.duration - 0.5);
        }, { once: true });
      }
      v.play().catch(() => {});
    }

    document.getElementById('playbtn').addEventListener('click', startVideo);
    overlay.addEventListener('click', startVideo);

    // Resync a cada 8s
    setInterval(() => {
      if (v.paused || v.ended || !v.duration) return;
      const diff = v.currentTime - getExpected();
      if (Math.abs(diff) > 3) {
        v.currentTime = Math.min(getExpected(), v.duration - 0.5);
      }
    }, 8000);

    v.src = '/stream/${req.params.code}';
    v.load();
  </script>
</body>
</html>`);
});

// ── Stream do vídeo da sessão ──────────────────────────────────────────────
app.get('/stream/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).send('Sessão não encontrada');
  const filePath = path.join(UPLOAD_DIR, session.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Arquivo não encontrado');
  serveVideo(filePath, req, res);
});

// ── Info da sessão (para o frontend saber o tempo atual) ──────────────────
app.get('/session/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Não encontrada' });
  const elapsed = (Date.now() - session.startedAt) / 1000;
  res.json({ ...session, elapsed });
});

// ── Deletar vídeo ──────────────────────────────────────────────────────────
app.delete('/video/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── Helper: serve arquivo com suporte a Range ─────────────────────────────
function serveVideo(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4', '.wmv': 'video/x-ms-wmv'
  };
  const mime = mimeMap[ext] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
}

app.listen(PORT, () => console.log('CineBlackwood porta ' + PORT));
