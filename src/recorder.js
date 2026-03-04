const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const recordingsDir = path.join(__dirname, "..", "recordings");
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

const sessions = new Map(); // id -> { username, file, streamlinkProcess, ffmpegProcess, startedAt, compressed }

function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

function compressFile(inputPath, opts = {}) {
  const crf = opts.crf || "23";
  const preset = opts.preset || "veryfast";
  const audioBitrate = opts.audioBitrate || "128k";

  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const tmpPath = path.join(dir, `${base}.cmp.tmp.mp4`);

  return new Promise((resolve, reject) => {
    // Skip if input doesn't exist
    if (!fs.existsSync(inputPath)) return reject(new Error("input file not found"));

    // ffmpeg transcode to tmp file
    const args = [
      "-y",
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", crf,
      "-c:a", "aac",
      "-b:a", audioBitrate,
      "-movflags", "+faststart",
      tmpPath
    ];

    const proc = spawn("ffmpeg", args);
    let resolved = false;

    proc.stderr.on("data", d => console.log(`[compress] ${d.toString()}`));
    proc.on("error", err => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    proc.on("exit", (code) => {
      if (resolved) return; // Already handled
      resolved = true;
      
      if (code !== 0) {
        // cleanup tmp
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(_) {}
        return reject(new Error(`ffmpeg exited ${code}`));
      }
      try {
        // Replace original with compressed file (atomic-ish)
        const backup = path.join(dir, `${base}.orig.tmp`);
        // move original to backup (in case rename fails)
        fs.renameSync(inputPath, backup);
        fs.renameSync(tmpPath, inputPath);
        // remove backup
        fs.unlinkSync(backup);
        resolve(inputPath);
      } catch (err) {
        // try to cleanup tmp and restore original if possible
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(_) {}
        try {
          if (fs.existsSync(path.join(dir, `${base}.orig.tmp`))) {
            fs.renameSync(path.join(dir, `${base}.orig.tmp`), inputPath);
          }
        } catch(_) {}
        reject(err);
      }
    });
  });
}

function startRecording(username, opts = {}) {
  const id = genId();
  const baseName = `${username}-${Date.now()}`;
  const outputFile = path.join(recordingsDir, `${baseName}.mp4`);
  const playlistFile = path.join(recordingsDir, `${baseName}.m3u8`);

  const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : 3;
  const reconnectIntervalMs = typeof opts.reconnectIntervalMs === 'number' ? opts.reconnectIntervalMs : 5 * 60 * 1000;
  const duration = typeof opts.duration === 'number' ? opts.duration : undefined; // seconds
  const stopAt = typeof opts.stopAt === 'number' ? opts.stopAt : (duration ? Date.now() + duration * 1000 : undefined);

  function countExistingSegments() {
    try {
      return fs.readdirSync(recordingsDir).filter(f => f.startsWith(`${baseName}_`) && f.endsWith('.ts')).length;
    } catch (e) { return 0; }
  }

  function spawnStreamlink() {
    // Use streamlink with ad-blocking flags
    const args = [
      `twitch.tv/${username}`,
      'best',
      '--stdout',
      '--twitch-disable-ads',           // Disable ads if possible
      '--http-no-ssl-verify'            // Some versions need this for ad blocking
    ];
    const p = spawn('streamlink', args);
    p.stderr.on('data', d => console.log(`[streamlink ${id}] ${d.toString()}`));
    p.on('exit', (code, sig) => console.log(`streamlink ${id} exited ${code} ${sig}`));
    return p;
  }

  function launchFFmpeg(streamStdout) {
    const existing = countExistingSegments();
    const segPattern = path.join(recordingsDir, `${baseName}_%06d.ts`);
    const startNumberArg = existing > 0 ? ['-start_number', String(existing)] : [];

    const ffmpegArgs = [
      '-y', '-i', 'pipe:0',
      '-c:v', 'copy', '-c:a', 'copy',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_flags', 'append_list+omit_endlist',
      ...startNumberArg,
      '-hls_segment_filename', segPattern,
      playlistFile
    ];

    const proc = spawn('ffmpeg', ffmpegArgs);
    proc.stderr.on('data', d => console.log(`[ffmpeg ${id}] ${d.toString()}`));
    proc.on('exit', (code, sig) => {
      console.log(`ffmpeg ${id} exited ${code} ${sig}`);
      handlePipelineExit(code, sig);
    });
    if (streamStdout && streamStdout.pipe) streamStdout.pipe(proc.stdin);
    return proc;
  }

  function assembleSegmentsAndCompressForBase(base) {
    const logFile = path.join(recordingsDir, `${base}_assemble.log`);
    try {
      const segs = fs.readdirSync(recordingsDir).filter(f => f.startsWith(`${base}_`) && f.endsWith('.ts')).sort();
      if (!segs.length) return Promise.resolve();
      
      const listFile = path.join(recordingsDir, `${base}_list.txt`);
      const listContent = segs.map(s => `file '${path.join(recordingsDir, s).replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listFile, listContent);
      
      return new Promise((resolve, reject) => {
        const out = path.join(recordingsDir, `${base}.mp4`);
        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out];
        const p = spawn('ffmpeg', args);
        const ws = fs.createWriteStream(logFile, { flags: 'a' });
        p.stderr.on('data', d => { ws.write(d); });
        p.on('exit', (code) => {
          try { fs.unlinkSync(listFile); } catch(_) {}
          ws.end();
          if (code !== 0) return reject(new Error(`ffmpeg concat exited ${code}`));
          // run compression best-effort
          compressFile(out).then(() => {
            // Delete all segment files after successful compression
            segs.forEach(seg => {
              try { fs.unlinkSync(path.join(recordingsDir, seg)); } catch(_) {}
            });
            // Also delete the m3u8 playlist file
            try { fs.unlinkSync(path.join(recordingsDir, `${base}.m3u8`)); } catch(_) {}
            resolve();
          }).catch(err => {
            // log but resolve
            fs.appendFileSync(logFile, `\ncompress failed: ${err && err.message}\n`);
            resolve();
          });
        });
        p.on('error', (err) => { ws.end(); reject(err); });
      });
    } catch (err) {
      try { fs.appendFileSync(logFile, `\nassemble error: ${err && err.message}\n`); } catch(_) {}
      return Promise.resolve();
    }
  }

  const meta = {
    id, username, baseName, file: outputFile, playlist: playlistFile,
    streamlinkProcess: null, ffmpegProcess: null, startedAt: Date.now(), compressed: false,
    retriesLeft: maxRetries, reconnectIntervalMs, duration, stopAt, stoppedByUser: false, restartTimer: null,
    exitHandled: false
  };
  sessions.set(id, meta);

  function handlePipelineExit(code, sig) {
    // Safety: prevent multiple executions of handlePipelineExit for same recording
    if (meta.exitHandled) return;
    meta.exitHandled = true;

    if (meta.streamlinkProcess) {
      try { meta.streamlinkProcess.kill('SIGKILL'); } catch {}
      meta.streamlinkProcess = null;
    }
    if (meta.ffmpegProcess) {
      try { meta.ffmpegProcess.kill('SIGKILL'); } catch {}
      meta.ffmpegProcess = null;
    }
    
    // Always cancel any pending restart timer
    if (meta.restartTimer) {
      clearTimeout(meta.restartTimer);
      meta.restartTimer = null;
    }

    if (meta.stoppedByUser) {
      // finalize - assemble segments and compress, then cleanup
      console.log(`[${id}] Assembling segments for ${meta.baseName}...`);
      assembleSegmentsAndCompressForBase(meta.baseName)
        .catch((err) => {
          console.error(`[${id}] Assembly failed: ${err && err.message}`);
        })
        .finally(() => {
          console.log(`[${id}] Recording finalized`);
          sessions.delete(id);
        });
      return;
    }

    const now = Date.now();
    const remaining = meta.stopAt ? (meta.stopAt - now) : Infinity;
    
    // Only retry if we have retries left AND time remaining
    if ((meta.retriesLeft > 0) && (remaining > 0)) {
      const d = meta.reconnectIntervalMs;
      meta.retriesLeft -= 1;
      console.log(`[${id}] Scheduling reconnect in ${d/1000}s (retries left: ${meta.retriesLeft})`);
      
      meta.restartTimer = setTimeout(() => {
        meta.restartTimer = null;
        
        // Double-check: still should retry?
        if (meta.stoppedByUser) {
          console.log(`[${id}] Reconnect timer fired but user already stopped`);
          return;
        }
        
        const nowCheck = Date.now();
        const remainingCheck = meta.stopAt ? (meta.stopAt - nowCheck) : Infinity;
        if (remainingCheck <= 0) {
          console.log(`[${id}] Reconnect timer fired but duration reached, assembling segments...`);
          assembleSegmentsAndCompressForBase(meta.baseName)
            .catch((err) => {
              console.error(`[${id}] Assembly failed: ${err && err.message}`);
            })
            .finally(() => {
              console.log(`[${id}] Recording finalized`);
              sessions.delete(id);
            });
          return;
        }
        
        console.log(`[${id}] Reconnecting...`);
        const sl = spawnStreamlink(); 
        meta.streamlinkProcess = sl; 
        const ff = launchFFmpeg(sl.stdout); 
        meta.ffmpegProcess = ff;
      }, d);
      return;
    }
    
    // Max retries reached or no time remaining
    console.log(`[${id}] Max retries reached or duration exceeded, assembling segments...`);
    assembleSegmentsAndCompressForBase(meta.baseName)
      .catch((err) => {
        console.error(`[${id}] Assembly failed: ${err && err.message}`);
      })
      .finally(() => {
        console.log(`[${id}] Recording finalized`);
        sessions.delete(id);
      });
  }

  try { const sl = spawnStreamlink(); meta.streamlinkProcess = sl; const ff = launchFFmpeg(sl.stdout); meta.ffmpegProcess = ff; }
  catch (err) { console.error('start pipeline failed', err && err.message); handlePipelineExit(1); }

  return { id, file: outputFile, playlist: playlistFile, baseName };
}

function stopRecording(id) {
  if (!id) {
    for (const k of Array.from(sessions.keys())) stopRecording(k);
    return;
  }
  const meta = sessions.get(id);
  if (!meta) return false;

  meta.stoppedByUser = true;
  meta.stopAt = Date.now();
  meta.retriesLeft = 0;

  if (meta.restartTimer) {
    clearTimeout(meta.restartTimer);
    meta.restartTimer = null;
  }

  // Kill streamlink process immediately with SIGKILL
  if (meta.streamlinkProcess) {
    try { meta.streamlinkProcess.kill('SIGKILL'); } catch {}
  }

  // Kill ffmpeg process immediately with SIGKILL to prevent hanging
  if (meta.ffmpegProcess) {
    try { meta.ffmpegProcess.kill('SIGKILL'); } catch {}
  }

  return true;
}


function listSessions() {
  const arr = [];
  for (const [id, m] of sessions.entries()) {
    arr.push({ id, username: m.username, file: m.file, playlist: m.playlist || null, startedAt: m.startedAt, compressed: !!m.compressed, baseName: m.baseName });
  }
  return arr;
}

// assemble all segments for a given base (public helper for server-side orphan assembler)
function assembleSegmentsForBase(base) {
  return new Promise((resolve) => {
    // delegate to internal method
    const fn = () => {
      const segs = fs.readdirSync(recordingsDir).filter(f => f.startsWith(`${base}_`) && f.endsWith('.ts')).sort();
      if (!segs.length) return resolve(false);
      const listFile = path.join(recordingsDir, `${base}_list_for_server.txt`);
      const listContent = segs.map(s => `file '${path.join(recordingsDir, s).replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listFile, listContent);
      const out = path.join(recordingsDir, `${base}.mp4`);
      const logFile = path.join(recordingsDir, `${base}_assemble.log`);
      const p = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
      const ws = fs.createWriteStream(logFile, { flags: 'a' });
      p.stderr.on('data', d => ws.write(d));
      p.on('exit', (code) => {
        try { fs.unlinkSync(listFile); } catch(_) {}
        ws.end();
        if (code !== 0) { fs.appendFileSync(logFile, `\nconcat exit ${code}\n`); return resolve(false); }
        compressFile(out).then(() => resolve(true)).catch(() => resolve(true));
      });
      p.on('error', (err) => { try { fs.appendFileSync(logFile, `\nerror: ${err && err.message}\n`); } catch(_) {} resolve(false); });
    };
    try { fn(); } catch (e) { resolve(false); }
  });
}

module.exports = { genId, compressFile, startRecording, stopRecording, listSessions, assembleSegmentsForBase };
