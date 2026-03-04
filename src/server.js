const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const { DateTime } = require("luxon");
const { startRecording, stopRecording, listSessions, assembleSegmentsForBase } = require("./recorder");
const https = require('https');

const app = express();
app.use(express.json());
// disable client-side caching so browsers always fetch latest HTML/JS
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

const recordingsDir = path.join(__dirname, "..", "recordings");
// statische Auslieferung der Aufnahme-Dateien
app.use("/files", express.static(recordingsDir));

const scheduled = new Map(); // jobId -> { timerStart, timerStop, details }

// Helper: Berechne die Größe eines Verzeichnisses
function getDirSize(dirPath) {
  let size = 0;
  const files = fs.readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      size += stat.size;
    } else if (stat.isDirectory()) {
      size += getDirSize(fullPath);
    }
  });
  return size;
}

// Helper: Berechne verfügbaren Speicher für Recording-Verzeichnis
function getRecordingDiskSpace() {
  return new Promise((resolve) => {
    const recordingPath = path.resolve(recordingsDir);
    // Nutze df um den freien Speicher des Datenträgers zu ermitteln, auf dem recordingsDir liegt
    exec(`df -B1 "${recordingPath}" | tail -1`, (error, stdout) => {
      let availableMB = 0;
      let totalMB = 0;
      
      if (!error && stdout) {
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 4) {
          totalMB = Math.round(parseInt(parts[1]) / 1024 / 1024);
          availableMB = Math.round(parseInt(parts[3]) / 1024 / 1024);
        }
      }
      
      resolve({ available: availableMB, total: totalMB });
    });
  });
}

// Helper: Hole Hardware-Statistiken
function getHardwareStats() {
  return new Promise((resolve) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    const cpus = os.cpus();
    const totalLoads = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total * 100);
    }, 0);
    const cpuPercent = Math.round(totalLoads / cpus.length);

    // Versuche Disk-Space zu ermitteln (Root)
    exec('df -B1 / | tail -1', (error, stdout) => {
      let diskPercent = 0;
      let diskUsedMB = 0;
      let diskTotalMB = 0;
      
      if (!error && stdout) {
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 5) {
          diskTotalMB = Math.round(parseInt(parts[1]) / 1024 / 1024);
          diskUsedMB = Math.round(parseInt(parts[2]) / 1024 / 1024);
          diskPercent = Math.round((parseInt(parts[2]) / parseInt(parts[1])) * 100);
        }
      }

      // Berechne Aufnahme-Größe
      let recordingSizeMB = 0;
      try {
        const recordingSize = getDirSize(recordingsDir);
        recordingSizeMB = Math.round(recordingSize / 1024 / 1024);
      } catch (e) {
        // ignore
      }

      // Berechne verfügbaren Speicher für Recording-Verzeichnis
      getRecordingDiskSpace().then(diskSpace => {
        const availableMB = diskSpace.available;
        const recordingDiskPercent = availableMB > 0 ? Math.round((recordingSizeMB / (recordingSizeMB + availableMB)) * 100) : 0;
        const recordingStatus = recordingSizeMB > (recordingSizeMB + availableMB) * 0.9 ? 'critical' : (recordingSizeMB > (recordingSizeMB + availableMB) * 0.7 ? 'warning' : 'ok');

        resolve({
          cpu: {
            percent: cpuPercent,
            status: cpuPercent > 80 ? 'critical' : (cpuPercent > 60 ? 'warning' : 'ok')
          },
          memory: {
            used: Math.round(usedMem / 1024 / 1024),
            total: Math.round(totalMem / 1024 / 1024),
            percent: memPercent,
            status: memPercent > 80 ? 'critical' : (memPercent > 60 ? 'warning' : 'ok')
          },
          disk: {
            used: diskUsedMB,
            total: diskTotalMB,
            percent: diskPercent,
            status: diskPercent > 80 ? 'critical' : (diskPercent > 60 ? 'warning' : 'ok')
          },
          recordings: {
            sizeMB: recordingSizeMB,
            availableMB: availableMB,
            totalMB: recordingSizeMB + availableMB,
            percent: recordingDiskPercent,
            status: recordingStatus
          }
        });
      });
    });
  });
}

// helper: Cleanup scheduled entries when a recording process stopped
function onRecordingStopped(recordingId) {
  for (const [jobId, info] of scheduled.entries()) {
    if (info.recordingId === recordingId) {
      // clear any stop-timer reference
      if (info.timerStop) {
        clearTimeout(info.timerStop);
        info.timerStop = null;
      }
      info.recordingId = null;
      info.hasRecording = false;
      // if there are no timers and no recording associated anymore, remove the scheduled entry
      if (!info.timerStart && !info.timerStop && !info.recordingId) {
        scheduled.delete(jobId);
      } else {
        scheduled.set(jobId, info);
      }
    }
  }
}

// replace direct stopRecording(...) timers/calls to use cleanup wrapper
function stopRecordingAndCleanup(id) {
  try {
    stopRecording(id);
  } finally {
    onRecordingStopped(id);
  }
}

function channelExists(username, timeout = 5000) {
  return new Promise((resolve) => {
    const opts = {
      method: 'GET',
      hostname: 'www.twitch.tv',
      path: `/${encodeURIComponent(username)}`,
      headers: { 'User-Agent': 'twitch-recorder/1.0' }
    };
    const req = https.request(opts, (r) => {
      const { statusCode } = r;
      // treat 200 as likely existing, others as not
      let body = '';
      r.on('data', (c) => { body += c.toString(); });
      r.on('end', () => {
        if (statusCode === 200) return resolve(true);
        return resolve(false);
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

app.post("/start", async (req, res) => {
  try {
    const { username, startTime, startOption, duration: durationBody, endTime } = req.body;
    if (!username) throw new Error("Username required");

    // quick existence check against twitch.tv
    const exists = await channelExists(username);
    if (!exists) throw new Error("Twitch channel not found");

    let whenDt = null;
    if (startOption && startOption !== "custom") {
      const nowBerlin = DateTime.now().setZone("Europe/Berlin");
      if (startOption === "now") whenDt = nowBerlin;
      else if (startOption === "5m") whenDt = nowBerlin.plus({ minutes: 5 });
      else if (startOption === "15m") whenDt = nowBerlin.plus({ minutes: 15 });
      else if (startOption === "1h") whenDt = nowBerlin.plus({ hours: 1 });
      else throw new Error("Invalid startOption");
    } else if (startTime) {
      if (typeof startTime === "string" && (startTime.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(startTime))) {
        whenDt = DateTime.fromISO(startTime);
      } else {
        whenDt = DateTime.fromISO(startTime, { zone: "Europe/Berlin" });
      }
    }

    let duration = (typeof durationBody === "number") ? durationBody : undefined;

    // wenn endTime übergeben, als Berlin interpretieren (falls ohne TZ) und duration berechnen
    if (endTime) {
      let endDt;
      if (typeof endTime === "string" && (endTime.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(endTime))) {
        endDt = DateTime.fromISO(endTime);
      } else {
        endDt = DateTime.fromISO(endTime, { zone: "Europe/Berlin" });
      }
      if (!endDt.isValid) throw new Error("Invalid endTime");

      // falls kein expliziter Startzeitpunkt, nimm jetzt (Berlin)
      if (!whenDt) whenDt = DateTime.now().setZone("Europe/Berlin");

      const durSec = Math.round((endDt.toUTC().toMillis() - whenDt.toUTC().toMillis()) / 1000);
      if (durSec <= 0) throw new Error("endTime must be after startTime");
      duration = durSec;
    }

    if (whenDt) {
      if (!whenDt.isValid) throw new Error("Invalid startTime");
      // Berechne Delay; toleriere kleine Negativabweichungen (Netzwerk/CPU Latenz)
      let delay = whenDt.toUTC().toJSDate().getTime() - Date.now();
      // wenn die Zeit nur minimal in der Vergangenheit liegt, starte sofort
      if (delay < 0 && delay > -1000) delay = 0;
      // falls deutlich in der Vergangenheit, ist es ein Fehler
      if (delay < 0) throw new Error("startTime is in the past");

      const jobId = `${username}-${Date.now()}`;
      const timerStart = setTimeout(() => {
        const sInfo = scheduled.get(jobId) || {};
        const { id, file } = startRecording(username, { duration: sInfo.duration });
        // if duration provided schedule stop
        if (duration && typeof duration === "number") {
          const timerStop = setTimeout(() => {
            stopRecordingAndCleanup(id);
          }, duration * 1000);
          const s = scheduled.get(jobId) || {};
          s.timerStop = timerStop;
          s.recordingId = id;
          s.startedAt = DateTime.now().setZone("Europe/Berlin").toISO();
          s.timerStart = null; // start timer has fired
          scheduled.set(jobId, s);
        } else {
          const s = scheduled.get(jobId) || {};
          s.recordingId = id;
          s.startedAt = DateTime.now().setZone("Europe/Berlin").toISO();
          s.timerStart = null;
          scheduled.set(jobId, s);
        }
        console.log(`Scheduled job ${jobId} started recording ${id}`);
      }, delay);

      const displayTime = whenDt.setZone("Europe/Berlin").toISO();
      scheduled.set(jobId, { username, startTime: displayTime, duration, timerStart });
      return res.json({ success: true, scheduled: true, jobId, jobTime: displayTime });
    } else {
      const { id, file } = startRecording(username, { duration });
      if (duration && typeof duration === "number") {
        setTimeout(() => stopRecordingAndCleanup(id), duration * 1000);
      }
      return res.json({ success: true, scheduled: false, id, file });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /stop
app.post("/stop", (req, res) => {
  const { id, jobId } = req.body || {};
  if (jobId) {
    const job = scheduled.get(jobId);
    if (!job) return res.status(404).json({ error: "jobId not found" });
    if (job.timerStart) clearTimeout(job.timerStart);
    if (job.timerStop) clearTimeout(job.timerStop);
    if (job.recordingId) {
      stopRecordingAndCleanup(job.recordingId);
    }
    scheduled.delete(jobId);
    return res.json({ success: true, stopped: "job" });
  }

  if (id) {
    const ok = stopRecording(id);
    // cleanup scheduled entries referencing this recording
    onRecordingStopped(id);
    return res.json({ success: !!ok, id });
  }

  // stop all
  stopRecording();
  // cleanup all scheduled entries
  for (const [jobId, info] of scheduled.entries()) {
    if (info.timerStart) clearTimeout(info.timerStart);
    if (info.timerStop) clearTimeout(info.timerStop);
  }
  scheduled.clear();
  res.json({ success: true });
});

app.get("/recordings", (req, res) => {
  // Remove any scheduled entries that are finished (no timers, no recording)
  for (const [jobId, info] of Array.from(scheduled.entries())) {
    if (!info.timerStart && !info.timerStop && !info.recordingId) {
      scheduled.delete(jobId);
    }
  }

  const scheduledList = Array.from(scheduled.entries()).map(([k, v]) => {
    const startISO = v.startTime || null;
    const startDisplay = startISO ? DateTime.fromISO(startISO, { zone: 'Europe/Berlin' }).toFormat('yyyy-LL-dd HH:mm:ss') : null;
    const status = v.recordingId ? 'running' : (v.timerStart ? 'scheduled' : 'waiting');
    return {
      jobId: k,
      username: v.username,
      startTime: startISO,
      startTimeDisplay: startDisplay,
      duration: v.duration,
      // keine Timer-Objekte serialisieren, stattdessen Präsenz/IDs angeben
      hasTimerStart: !!v.timerStart,
      hasTimerStop: !!v.timerStop,
      recordingId: v.recordingId || null,
      hasRecording: !!v.recordingId,
      status
    };
  });
  res.json({ active: listSessions(), scheduled: scheduledList });
});

// neue Route: Liste aller gespeicherten Recording-Dateien
app.get("/recordings/all", (req, res) => {
  fs.readdir(recordingsDir, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });

    // Group files by base name (e.g., user-1234567890 -> user-1234567890.mp4, user-1234567890.m3u8, user-1234567890_000.ts ...)
    const groups = new Map();

    files.forEach(f => {
      const match = f.match(/^(.*?)(?:_(\d+))?\.(mp4|m3u8|ts|mkv|webm|flv)$/i);
      if (!match) return;
      const base = match[1];
      const ext = match[3].toLowerCase();
      const stat = fs.statSync(path.join(recordingsDir, f));
      if (!groups.has(base)) groups.set(base, { base, files: [], size: 0, mtime: 0, mp4: null, playlist: null, segments: [] });
      const g = groups.get(base);
      g.files.push({ name: f, ext, size: stat.size, mtime: stat.mtime.getTime(), url: `/files/${encodeURIComponent(f)}` });
      g.size += stat.size;
      if (stat.mtime.getTime() > g.mtime) g.mtime = stat.mtime.getTime();
      if (ext === 'mp4' || ext === 'mkv' || ext === 'webm' || ext === 'flv') g.mp4 = `/files/${encodeURIComponent(f)}`;
      if (ext === 'm3u8') g.playlist = `/files/${encodeURIComponent(f)}`;
      if (ext === 'ts') g.segments.push(f);
    });

    // Determine active recording bases from current sessions
    const activeBases = new Set();
    try {
      const sessions = listSessions();
      sessions.forEach(s => {
        const name = s.playlist ? path.basename(s.playlist) : (s.file ? path.basename(s.file) : '');
        const m = name.match(/^(.*?)(?:_\d{3})?(?:\.(mp4|m3u8|ts|mkv|webm|flv))?$/i);
        const b = m ? m[1] : name;
        if (b) activeBases.add(b);
      });
    } catch (e) {
      // ignore
    }

    // Convert map to array, include active flag, sort by mtime desc
    // Filter out pure-segment groups (unless active or have playlist/mp4)
    const filtered = Array.from(groups.values()).filter(g => {
      if (g.mp4) return true;
      if (g.playlist) return true;
      if (activeBases.has(g.base)) return true;
      return false;
    });

    // Keep each base as a separate recording entry (do not collapse by username)
    const list = filtered.map(g => ({
      base: g.base,
      mp4Url: g.mp4,
      playlistUrl: g.playlist,
      segments: g.segments,
      size: g.size,
      mtime: g.mtime,
      active: activeBases.has(g.base)
    })).sort((a, b) => b.mtime - a.mtime);

    res.json({ files: list });
  });
});

// neue Route: einzelne Recording-Datei löschen
app.delete("/recordings/:file", (req, res) => {
  try {
    const raw = req.params.file || "";
    // nur Dateiname erlauben (prevent directory traversal)
    const filename = path.basename(raw);
    // Derive base name (strip known extensions and _### segments)
    const baseMatch = filename.match(/^(.*?)(?:_\d{3})?(?:\.(mp4|m3u8|ts|mkv|webm|flv))?$/i);
    const base = baseMatch ? baseMatch[1] : filename;

    // Find all files starting with base
    fs.readdir(recordingsDir, (err, files) => {
      if (err) return res.status(500).json({ error: err.message });
      const toDelete = files.filter(f => f.startsWith(base));
      if (toDelete.length === 0) return res.status(404).json({ error: 'not found' });
      let errOccur = null;
      toDelete.forEach((f) => {
        try {
          fs.unlinkSync(path.join(recordingsDir, f));
        } catch (e) {
          errOccur = e;
        }
      });
      if (errOccur) return res.status(500).json({ error: errOccur.message });
      return res.json({ success: true, deleted: toDelete });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// neue Route: Hardware & Storage Stats
app.get("/stats", async (req, res) => {
  try {
    const stats = await getHardwareStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// neue Route: aktuelle Aufzeichnung (für Live-Vorschau)
app.get("/recording/current", (req, res) => {
  const sessions = listSessions();
  if (sessions.length > 0) {
    const current = sessions[0]; // erste aktive Session
    const mp4 = current.file ? `/files/${encodeURIComponent(path.basename(current.file))}` : null;
    const playlist = current.playlist ? `/files/${encodeURIComponent(path.basename(current.playlist))}` : null;
    res.json({ 
      success: true, 
      id: current.id,
      file: current.file || null,
      url: mp4,
      playlistUrl: playlist
    });
  } else {
    res.json({ success: false, message: "No active recording" });
  }
});

app.listen(3000, () =>
  console.log("Running on http://localhost:3000")
);

// Orphan assembler: periodically look for .ts segment sets that are not associated with active sessions
const ORPHAN_ASSEMBLE_INTERVAL_MS = 60 * 1000; // check every 60s
const ORPHAN_IDLE_MS = 60 * 1000; // consider segments idle if no modifications in last 60s
const assembling = new Set();
setInterval(() => {
  try {
    const sessionsActive = new Set();
    try {
      const s = listSessions();
      s.forEach(x => {
        if (x.baseName) sessionsActive.add(x.baseName);
        else if (x.playlist) sessionsActive.add(path.basename(x.playlist, path.extname(x.playlist)));
      });
    } catch (e) { /* ignore */ }

    const files = fs.readdirSync(recordingsDir);
    const segGroups = new Map();
    files.forEach(f => {
      const m = f.match(/^(.*?)(_\d+)?\.ts$/i);
      if (!m) return;
      const base = m[1];
      if (!segGroups.has(base)) segGroups.set(base, []);
      segGroups.get(base).push(f);
    });

    for (const [base, segs] of segGroups.entries()) {
      if (sessionsActive.has(base)) continue; // active -> skip
      if (assembling.has(base)) continue; // already assembling
      
      // Check if .mp4 already exists - if so, skip (assembly already done)
      const mp4Path = path.join(recordingsDir, `${base}.mp4`);
      if (fs.existsSync(mp4Path)) {
        console.log(`Orphan assembler: skipping ${base} - mp4 already exists`);
        // Clean up orphan segments since assembly is complete
        segs.forEach(seg => {
          try { fs.unlinkSync(path.join(recordingsDir, seg)); } catch(_) {}
        });
        // Also delete the m3u8 playlist file if exists
        try { fs.unlinkSync(path.join(recordingsDir, `${base}.m3u8`)); } catch(_) {}
        continue;
      }
      
      // check newest mtime
      let newest = 0;
      for (const s of segs) {
        try { const st = fs.statSync(path.join(recordingsDir, s)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch(_) {}
      }
      if (Date.now() - newest < ORPHAN_IDLE_MS) continue; // still being written recently
      // schedule assembly
      assembling.add(base);
      console.log(`Orphan assembler: assembling base=${base} segments=${segs.length}`);
      assembleSegmentsForBase(base).then(ok => {
        console.log(`Orphan assembler finished base=${base} ok=${ok}`);
        assembling.delete(base);
      }).catch(err => {
        console.error(`Orphan assembler error for base=${base}:`, err && err.message);
        assembling.delete(base);
      });
    }
  } catch (err) {
    console.error('Orphan assembler loop error', err && err.message);
  }
}, ORPHAN_ASSEMBLE_INTERVAL_MS);
