# Installing Qdrant for Memory Hub

Memory Hub uses **Qdrant**, a vector database, to store and search your memories. You need Qdrant running before starting Memory Hub.

## Option 1: Docker (Easiest)

If you have Docker installed, this is the quickest way:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

That's it. Qdrant is now running at `http://localhost:6333`.

To stop it later:

```bash
docker stop qdrant
```

To start it again:

```bash
docker start qdrant
```

### Installing Docker

- **macOS**: Download [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
- **Windows**: Download [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
- **Linux (Ubuntu/Debian)**: `sudo apt install docker.io && sudo systemctl start docker`

After installing, you may need to add yourself to the `docker` group (`sudo usermod -aG docker $USER`) and log out and back in.

## Option 2: Binary (No Docker)

Download the Qdrant binary for your system:

1. Go to [Qdrant releases](https://github.com/qdrant/qdrant/releases)
2. Download the latest `qdrant-x86_64-unknown-linux-gnu.tar.gz` (Linux) or `qdrant-x86_64-apple-darwin.tar.gz` (macOS)
3. Extract it: `tar -xzf qdrant-*.tar.gz`
4. Move the binary to your PATH: `sudo mv qdrant /usr/local/bin/`
5. Run it: `qdrant`

Qdrant starts on `http://localhost:6333` by default. Keep this terminal window open.

## Verify Qdrant Is Running

Open a browser or run:

```bash
curl http://localhost:6333/health
```

You should see: `{"ok":true}`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `docker: command not found` | Install Docker (see Option 1 above) |
| `Permission denied` when running Docker | Add user to `docker` group and re-login |
| Port 6333 already in use | Stop the other service, or change Qdrant's port (`docker run -p 6333:6333 qdrant/qdrant` handles this) |
| Qdrant starts but Memory Hub can't connect | Make sure Qdrant is on `http://localhost:6333` and accessible |
| `QLDrant` not found | Ensure it's in your PATH or use Docker instead |
