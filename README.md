# Twitch Recorder 🎬

[![GitHub Stars](https://img.shields.io/github/stars/atillatheboss/twitch-recorder?style=flat-square&logo=github&color=1f6feb)](https://github.com/atillatheboss/twitch-recorder)
[![GitHub Watchers](https://img.shields.io/github/watchers/atillatheboss/twitch-recorder?style=flat-square&logo=github)](https://github.com/atillatheboss/twitch-recorder)
[![GitHub Forks](https://img.shields.io/github/forks/atillatheboss/twitch-recorder?style=flat-square&logo=github)](https://github.com/atillatheboss/twitch-recorder)
[![License](https://img.shields.io/github/license/atillatheboss/twitch-recorder?style=flat-square)](LICENSE)
[![Profile Views](https://komarev.com/ghpvc/?username=atillatheboss&color=1f6feb)](https://komarev.com/ghpvc/?username=atillatheboss&color=1f6feb)

Record Twitch streams automatically with a modern web interface. Built with Node.js, FFmpeg, and Docker.

**[Features](#-features) • [Requirements](#-requirements) • [Quick Start](#-quick-start-with-docker-(easiest)) • [Troubleshooting](#-troubleshooting)**

---

## 🎥 Features

- **Direct Stream Recording** - Record any public Twitch stream in real-time
- **Modern Web Interface** - Clean, responsive UI with real-time updates
- **Scheduling System** - Record now, or schedule for later with custom timing
- **Multiple Languages** - Full support for German & English with language switcher
- **HLS Video Player** - Built-in live preview of recordings
- **System Monitoring** - Real-time CPU, RAM, disk, and storage metrics
- **Recording Management** - Download, delete, and organize recordings via web UI
- **Docker Ready** - Easy Docker Compose setup included
- **Cross-platform** - Works on macOS, Linux, and Windows (via Docker)

---

## 📋 Requirements

- **Docker** 20.10+
- **Docker Compose** 2.0+
- **Disk Space** 50GB+ for recordings
- **RAM** 2GB minimum (4GB recommended)
- **CPU** 2+ cores

---

## 🚀 Quick Start with Docker (Easiest)

### 1. Clone the repository
```bash
git clone https://github.com/atillatheboss/twitch-recorder.git
cd twitch-recorder
```

### 2. Start with Docker Compose
```bash
docker-compose up -d
```

### 3. Access the application
- **Web UI**: http://localhost:3002

---

**Configuration:**
- **Port**: 3002
- **Auto-restart**: Yes
- **Volumes**: `./recordings` mounted for persistent storage

**What's included:**
- Node.js application server
- Automatic rebuild on start
- HTTP server on port 3002

---

## 🎮 Using the Web Interface

### Accessing the UI
- Open http://localhost:3002 in your browser

### Starting a Recording

1. **Enter Twitch Channel**
   - Type the streamer's channel name (e.g., "twitch")
   - Don't include the full URL, just the channel name

2. **Set Recording Duration**
   - Enter seconds or leave blank to record until stream ends
   - Example: "3600" = 1 hour

3. **Click "Start Recording"**
   - Status badge shows "Recording..." in real-time
   - Watch live preview in the HLS player

4. **Stop Anytime**
   - Click "Stop All" to stop all active recordings
   - Or wait for the stream to end

### Recording Management

- **Watch Recordings** - Click on any recording to play via HLS player
- **Download** - Click download icon to save MP4 to your device
- **Delete** - Remove recordings (⚠️ cannot be undone)
- **View Stats** - Monitor CPU, RAM, disk, and storage usage

### Language Switching

- Click the dropdown in the top-right corner
- Choose **Deutsch** or **English**
- Language preference is saved in your browser

---

## 📊 System Monitoring

The web UI displays real-time system metrics:

- **CPU Usage** - Current CPU load percentage
- **RAM Usage** - Memory usage in GB
- **Disk Usage** - Disk space used/available
- **Storage** - Recording storage used/available

These update automatically every 2 seconds.

---

## 🚨 Troubleshooting

### Application won't start
```bash
# Check logs
docker-compose logs recorder

# Rebuild container
docker-compose build --no-cache

# Restart
docker-compose restart
```

### Can't access web UI
- Check if port 3002 is available: `lsof -i :3002`
- Firewall blocking the port: Open port 3002
- Try `http://localhost:3002` not `https://`

### Recording won't start
```bash
# Check if stream is live
# (Channel must be currently streaming)

# Verify Streamlink works
streamlink https://twitch.tv/yourchannelname best

# Check logs for errors
docker-compose logs -f recorder
```

### Disk space full
```bash
# View largest files
du -sh /path/to/recordings/* | sort -h | tail -10

# Delete old recording
rm /path/to/recordings/filename.mp4

# Or use Web UI: select recording and click Delete
```

### Docker container keeps restarting
```bash
# Check detailed logs
docker-compose logs --tail=50 recorder

# Common issues:
# - Port already in use
# - Missing .env variables
# - Insufficient disk space
# - FFmpeg/Streamlink not installed in image
```

### High CPU usage
- Lower `MAX_CONCURRENT_RECORDINGS` in `.env`
- Record at lower quality: `STREAM_QUALITY=480p`
- Check if multiple recordings are running: `docker-compose logs recorder | grep "Recording"`

---

## 🔒 Security

### Best Practices

1. **Keep Docker images updated**
   ```bash
   docker-compose pull
   docker-compose up -d
   ```

2. **Use strong authentication**
   - Configure a strong AUTH_TOKEN in `.env`
   - Keep your server credentials secure

3. **Restrict network access**
   ```bash
   # Only allow from trusted IPs
   ufw allow from 192.168.1.0/24 to any port 3002
   ```

4. **Regular backups**
   - Backup the `recordings` directory regularly
   - Store backups in a safe location

### Privacy & Legal

- ⚠️ **Respect Twitch ToS** - Only record streams you have permission to record
- ⚠️ **Check local laws** - Some jurisdictions have restrictions on recording
- ⚠️ **GDPR compliance** - If you're in EU, ensure GDPR compliance for stored data
- ⚠️ **Copyright** - Don't redistribute recordings without permission

---

## 📚 Technology Stack

| Component | Technology |
|-----------|-----------|
| **Backend** | Node.js 20.x + Express.js |
| **Frontend** | HTML5 + CSS3 + Vanilla JavaScript |
| **Video Capture** | Streamlink + FFmpeg |
| **Video Playback** | HLS.js (HTTP Live Streaming) |
| **Containerization** | Docker + Docker Compose |
| **Scheduling** | Node.js async/await |
| **UI Framework** | Tailwind CSS |

---

## 📖 Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment guide
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guidelines
- [SECURITY.md](SECURITY.md) - Security policies
- [CHANGELOG.md](CHANGELOG.md) - Version history
- [DOCUMENTATION.md](DOCUMENTATION.md) - File structure reference

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:
- How to report bugs
- How to request features
- Development setup
- Coding standards
- Pull request process

---

## 📝 License

MIT License - See [LICENSE](LICENSE) for details

---

## ❓ Support

- 📖 Check [Troubleshooting](#-troubleshooting) section
- 🐛 [Report bugs](https://github.com/yourusername/twitch-recorder/issues)
- 💬 [Ask questions](https://github.com/yourusername/twitch-recorder/discussions)
- 🔒 [Report security issues](SECURITY.md)

---

## 🎯 Roadmap

Planned features:
- WebSocket real-time updates
- Multi-channel playlists
- Quality presets (480p, 720p, 1080p)
- Format conversion (MP4, WebM, AVI)
- Webhook notifications
- Swagger API documentation

---

**Made with ❤️ for Twitch streamers**

Happy streaming! 🎬✨
