#!/usr/bin/env python3
"""Deploy this app to a BisectHosting Node.js server through the panel API.

Usage:
  BISECT_API_KEY=... python3 scripts/deploy-bisect.py [server_id]

server_id can be the panel's short id (e.g. 063fba2d) or the numeric id
(e.g. 21052659). Run `npm ci --omit=dev` first so node_modules is present.

How it works: BisectHosting's file-write endpoint only takes JSON
({"file", "content"}) with text content under ~1 MB, and the node's direct
upload port is often unreachable. So the script packs the text files into
small uncompressed .tar chunks, writes each one as text, and has the panel
unpack it. Binary files (Leaflet's PNGs) are skipped; the app doesn't need them.
"""
import io, json, os, sys, tarfile, time, urllib.error, urllib.request

PANEL = "https://games.bisecthosting.com/api/client"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {".git", "test", "scripts", "data"}  # data/ holds saved results on the server
MAX_JSON = 800_000
KEY = os.environ.get("BISECT_API_KEY") or sys.exit("Set BISECT_API_KEY")


def api(method, path, body=None):
    for attempt in range(6):
        req = urllib.request.Request(PANEL + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {KEY}", "Accept": "application/json",
                     "Content-Type": "application/json",
                     "User-Agent": "job-app-finder-deploy/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                time.sleep(15 * (attempt + 1)); continue
            raise SystemExit(f"{method} {path} -> {e.code}: {e.read()[:300]!r}")


def find_server(wanted):
    for s in api("GET", "")["data"]:
        a = s["attributes"]
        if wanted in (a["identifier"], str(a.get("internal_id")), a["uuid"]):
            return a["identifier"], a["name"]
    sys.exit(f"No server matching {wanted}")


def text_files():
    out = []
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for f in files:
            p = os.path.join(d, f)
            try:
                open(p, "rb").read().decode("utf-8")
            except UnicodeDecodeError:
                continue  # binary; can't go through the text-only write endpoint
            out.append(os.path.relpath(p, ROOT))
    return sorted(out)


def pack(names):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for n in names:
            ti = t.gettarinfo(os.path.join(ROOT, n), arcname=n)
            ti.uid = ti.gid = 0; ti.uname = ti.gname = ""
            with open(os.path.join(ROOT, n), "rb") as fh:
                t.addfile(ti, fh)
        # The panel trims trailing whitespace/NULs, so end on a throwaway file.
        end = tarfile.TarInfo(".upload_end"); end.size = 1
        t.addfile(end, io.BytesIO(b"x"))
    return buf.getvalue().decode("utf-8")


def chunks(names):
    cur = []
    for n in names:
        if cur and len(json.dumps(pack(cur + [n]))) > MAX_JSON:
            yield cur; cur = []
        cur.append(n)
    if cur:
        yield cur


def main():
    if not os.path.isdir(os.path.join(ROOT, "node_modules")):
        sys.exit("Run `npm ci --omit=dev` first")
    sid, name = find_server(sys.argv[1] if len(sys.argv) > 1 else "21052659")
    base = f"/servers/{sid}"
    print(f"Deploying to {name} ({sid})")
    for i, group in enumerate(chunks(text_files())):
        fn = f"deploy{i:02d}.tar"
        api("POST", f"{base}/files/write", {"file": "/" + fn, "content": pack(group)})
        api("POST", f"{base}/files/decompress", {"root": "/", "file": fn})
        api("POST", f"{base}/files/delete", {"root": "/", "files": [fn]})
        print(f"  chunk {i}: {len(group)} files")
    api("POST", f"{base}/files/delete", {"root": "/", "files": [".upload_end"]})
    api("PUT", f"{base}/startup/variable", {"key": "MAIN_FILE", "value": "server.js"})
    # "restart" hangs here: the panel never sees its "started" message, so kill then start.
    api("POST", f"{base}/power", {"signal": "kill"})
    time.sleep(5)
    api("POST", f"{base}/power", {"signal": "start"})
    ip = next((a["attributes"] for a in api("GET", f"{base}/network/allocations")["data"]
               if a["attributes"]["is_default"]), None)
    print("Restarted." + (f" Open http://{ip['ip']}:{ip['port']}" if ip else ""))


if __name__ == "__main__":
    main()
