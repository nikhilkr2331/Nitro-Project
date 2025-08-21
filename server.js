/**
 * Express.js File Parser CRUD API with Progress Tracking
 * Tech: Node.js, Express, MongoDB (Mongoose), Busboy (streamed uploads), csv-parse
 * Features:
 *  - POST /files                 : upload file (CSV/Excel supported via xlsx) with progress (upload + processing)
 *  - GET  /files/:id/progress    : poll progress { status, progress }
 *  - GET  /files/:id             : get parsed JSON content when ready
 *  - GET  /files                 : list files (metadata)
 *  - DELETE /files/:id           : delete file + parsed data + disk blob
 *  - (Optional) POST /files/request-id : get a pre-assigned uploadId to enable real-time upload progress
 *
 * Notes on progress tracking of multipart uploads over HTTP:
 *  - To see real-time *upload* progress while the request body is still streaming, the client must know an ID *before* sending bytes.
 *    This implementation provides an optional `POST /files/request-id` endpoint. The client sends the returned `uploadId`
 *    as a query param (`POST /files?uploadId=...`) or header `x-upload-id`. The server will update progress in-memory while receiving.
 *  - If the client skips pre-assigning an ID, you will still get progress during the async parsing phase.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const Busboy = require('busboy');
const { parse } = require('csv-parse');
const XLSX = require('xlsx');

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/file_parser_api';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// -------------------- DB Models --------------------
const FileSchema = new mongoose.Schema(
  {
    filename: String,
    mimetype: String,
    size: Number,
    path: String, // disk path
    status: { type: String, enum: ['uploading', 'processing', 'ready', 'failed'], default: 'uploading' },
    progress: { type: Number, default: 0 }, // 0..100 overall (upload + processing)
    parseMeta: {
      rows: Number,
      cols: Number,
      parser: String,
    },
    parsedContent: { type: Array, default: [] }, // array of objects (JSON rows)
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

const FileDoc = mongoose.model('File', FileSchema);

// -------------------- In-memory progress store --------------------
// Holds upload progress (bytes received) for active streams keyed by uploadId
const uploadProgress = new Map(); // uploadId -> { received, total, fileId }

// -------------------- Helpers --------------------
function genId() {
  return crypto.randomUUID();
}

function inferParser(mimetype, filename) {
  const lower = (mimetype || '').toLowerCase();
  const ext = path.extname(filename || '').toLowerCase();
  if (lower.includes('csv') || ext === '.csv') return 'csv';
  if (lower.includes('excel') || ext === '.xlsx' || ext === '.xls') return 'xlsx';
  return 'csv'; // default
}

function parseCSVStream(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (r) => rows.push(r))
      .on('error', reject)
      .on('end', () => resolve(rows));
  });
}

function parseXLSX(filePath) {
  const wb = XLSX.readFile(filePath);
  const first = wb.SheetNames[0];
  const ws = wb.Sheets[first];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

async function processFileAsync(file) {
  // Update status to processing and reset progress from 50 -> towards 100
  // (Heuristic: treat upload as 0-50, processing as 50-100)
  file.status = 'processing';
  file.progress = Math.max(file.progress, 60);
  await file.save();

  try {
    const parser = inferParser(file.mimetype, file.filename);
    let data = [];
    if (parser === 'csv') {
      data = await parseCSVStream(file.path);
    } else if (parser === 'xlsx') {
      data = parseXLSX(file.path);
    }

    // simulate chunked processing progress
    const total = data.length || 1;
    const chunk = Math.max(1, Math.floor(total / 5));
    let processed = 0;

    while (processed < total) {
      await new Promise((r) => setTimeout(r, 300));
      processed = Math.min(total, processed + chunk);
      const pct = 60 + Math.floor((processed / total) * 40); // 60..100
      await FileDoc.updateOne({ _id: file._id }, { $set: { progress: Math.min(99, pct) } });
    }

    // Save parsed content (cap for demo to avoid gigantic docs; adjust as needed)
    const MAX_ROWS = 5000;
    const clipped = data.slice(0, MAX_ROWS);

    file.parsedContent = clipped;
    file.parseMeta = {
      rows: clipped.length,
      cols: clipped.length ? Object.keys(clipped[0]).length : 0,
      parser,
    };
    file.status = 'ready';
    file.progress = 100;
    await file.save();
  } catch (err) {
    file.status = 'failed';
    file.progress = 0;
    await file.save();
    console.error('Processing failed:', err);
  }
}

// -------------------- App --------------------
const app = express();
app.use(express.json());

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Optional: get a pre-assigned upload id so clients can poll progress *during* upload
app.post('/files/request-id', async (_req, res) => {
  const uploadId = genId();
  uploadProgress.set(uploadId, { received: 0, total: 0, fileId: null });
  res.status(201).json({ uploadId });
});

// POST /files : upload with streamed progress
app.post('/files', async (req, res) => {
  const uploadId = req.query.uploadId || req.header('x-upload-id') || genId();
  if (!uploadProgress.has(uploadId)) uploadProgress.set(uploadId, { received: 0, total: 0, fileId: null });
  const prog = uploadProgress.get(uploadId);

  const busboy = Busboy({ headers: req.headers });
  let createdFileDoc = null;
  let tmpPath = null;
  let filename = null;
  let mimetype = null;
  let totalBytes = Number(req.headers['content-length'] || 0);
  prog.total = totalBytes;

  busboy.on('file', async (fieldname, file, fileInfo) => {
    filename = fileInfo.filename;
    mimetype = fileInfo.mimeType || fileInfo.mime || 'application/octet-stream';
    const safeName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${filename}`;
    tmpPath = path.join(UPLOAD_DIR, safeName);
    const out = fs.createWriteStream(tmpPath);

    // Create DB record ASAP so the client can poll with fileId
    createdFileDoc = await FileDoc.create({ filename, mimetype, path: tmpPath, status: 'uploading', progress: 1 });
    prog.fileId = createdFileDoc._id.toString();

    file.on('data', (chunk) => {
      prog.received += chunk.length;
      // Map raw upload progress to 1..55 (keep headroom before processing)
      const pct = totalBytes > 0 ? Math.min(55, Math.max(1, Math.floor((prog.received / totalBytes) * 55))) : 10;
      createdFileDoc.progress = pct;
      createdFileDoc.save().catch(() => {});
    });

    file.on('limit', () => {
      console.warn('Busboy file size limit reached');
    });

    file.pipe(out);

    out.on('close', async () => {
      try {
        // Update size and move to processing
        const stats = fs.statSync(tmpPath);
        createdFileDoc.size = stats.size;
        await createdFileDoc.save();
        // Kick off async parsing (non-blocking)
        processFileAsync(createdFileDoc);
      } catch (e) {
        console.error('Post-upload save error', e);
      }
    });
  });

  busboy.on('field', (name, val) => {
    // Accept any additional metadata if needed
  });

  busboy.on('error', (err) => {
    console.error('Busboy error', err);
    if (createdFileDoc) {
      createdFileDoc.status = 'failed';
      createdFileDoc.save().catch(() => {});
    }
  });

  busboy.on('finish', () => {
    // Upload stream finished; respond with the created file metadata
    if (!createdFileDoc) {
      return res.status(400).json({ error: 'No file field found in multipart form-data (expected field name "file")' });
    }
    res.status(201).json({
      file_id: createdFileDoc._id,
      status: createdFileDoc.status,
      progress: createdFileDoc.progress,
      uploadId,
    });
  });

  req.pipe(busboy);
});

// Progress endpoint
app.get('/files/:id/progress', async (req, res) => {
  const { id } = req.params;
  const doc = await FileDoc.findById(id).lean();
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ file_id: id, status: doc.status, progress: doc.progress });
});

// Get parsed content (or message if still processing)
app.get('/files/:id', async (req, res) => {
  const { id } = req.params;
  const doc = await FileDoc.findById(id).lean();
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'ready') {
    return res.json({ message: 'File upload or processing in progress. Please try again later.' });
  }
  res.json({ file_id: id, filename: doc.filename, parseMeta: doc.parseMeta, data: doc.parsedContent });
});

// List files
app.get('/files', async (_req, res) => {
  const docs = await FileDoc.find({}, { parsedContent: 0 }).sort({ created_at: -1 }).lean();
  res.json(docs.map((d) => ({
    id: d._id,
    filename: d.filename,
    status: d.status,
    progress: d.progress,
    size: d.size,
    created_at: d.created_at,
    updated_at: d.updated_at,
  })));
});

// Delete file + parsed content + disk blob
app.delete('/files/:id', async (req, res) => {
  const { id } = req.params;
  const doc = await FileDoc.findById(id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  try {
    if (doc.path && fs.existsSync(doc.path)) fs.unlinkSync(doc.path);
  } catch (e) {
    console.warn('Blob cleanup failed:', e.message);
  }
  await FileDoc.deleteOne({ _id: id });
  res.json({ success: true });
});

// -------------------- Startup --------------------
(async () => {
  try {
    await mongoose.connect(MONGO_URI, { dbName: new URL(MONGO_URI).pathname.slice(1) || 'file_parser_api' });
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
})();

/**
 * -------------------- How to run --------------------
 * 1) Save this file as `server.js`
 * 2) Create `.env`:
 *      PORT=3000
 *      MONGO_URI=mongodb://127.0.0.1:27017/file_parser_api
 *      # optional
 *      # UPLOAD_DIR=/absolute/path/where/you/want/uploads
 * 3) Install deps:
 *      npm init -y
 *      npm i express mongoose busboy csv-parse xlsx dotenv
 * 4) Start MongoDB locally (e.g., `mongod`)
 * 5) Run: `node server.js`
 *
 * -------------------- Example cURL --------------------
 * # (optional) get an uploadId for live upload progress
 * curl -s -X POST http://localhost:3000/files/request-id | jq
 * # suppose it returned {"uploadId":"<UUID>"}
 *
 * # upload a CSV using that uploadId
 * curl -i -X POST "http://localhost:3000/files?uploadId=<UUID>" \
 *   -H "Content-Type: multipart/form-data" \
 *   -F file=@./sample.csv
 *
 * # poll progress
 * curl -s http://localhost:3000/files/<file_id>/progress | jq
 *
 * # get parsed data when ready
 * curl -s http://localhost:3000/files/<file_id> | jq
 *
 * # list files
 * curl -s http://localhost:3000/files | jq
 *
 * # delete
 * curl -X DELETE http://localhost:3000/files/<file_id>
 */
