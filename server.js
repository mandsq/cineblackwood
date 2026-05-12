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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8')
      .replace(/[^a-zA-Z0-9.\-_áéíóúãõâêîôûàèìòùçÁÉÍÓÚÃÕÂÊÎÔÛÀÈÌÒÙÇ ]/g, '_');
    cb(null, Date.now() + '___' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

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
    const rawName = f.replace(/^\d+___/, '');
    const name = rawName.replace(/\.[^/.]+$/, '');
    return { id: f, name, size: stat.size, url: '/video/' + f, addedAt: stat.birthtimeMs };
  }).sort((a, b) => b.addedAt - a.addedAt);
  res.json(list);
});

app.get('/video/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Não encontrado');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(req.params.filename).toLowerCase();
  const mimeMap = { '.mp4':'video/mp4', '.mkv':'video/x-matroska', '.avi':'video/x-msvideo',
    '.mov':'video/quicktime', '.webm':'video/webm', '.m4v':'video/mp4', '.wmv':'video/x-ms-wmv' };
  const mime = mimeMap[ext] || 'video/mp4';
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
});

app.delete('/video/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('CineVault porta ' + PORT));
