"""Start the Training Selection app:   python run.py

Opens http://127.0.0.1:8000 in your browser. Press Ctrl+C in this window to stop.
Options:  python run.py --port 9000     use another port
          python run.py --no-browser    do not open the browser
"""
import argparse
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

if sys.version_info < (3, 10):
    sys.exit(f"Python 3.10 or newer is needed. You have {sys.version.split()[0]}. Get a newer one from python.org.")

NEEDED = {"flask": "flask", "rasterio": "rasterio", "numpy": "numpy", "PIL": "pillow",
          "jsonschema": "jsonschema", "sklearn": "scikit-learn", "joblib": "joblib"}
missing = []
for module, package in NEEDED.items():
    try:
        __import__(module)
    except ImportError:
        missing.append(package)
if missing:
    sys.exit("Some Python packages are not installed: " + ", ".join(missing) +
             "\n\nInstall them with:\n    " + f'"{sys.executable}" -m pip install -r backend/requirements.txt' +
             "\n\nthen run this again.")

sys.path.insert(0, str(ROOT / "backend"))
from app import create_app  # noqa: E402


def free_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    sys.exit(f"Ports {start}-{start + 19} are all in use. Try: python run.py --port 9100")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Training Selection web app")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}"
    print("\n  Training Selection is running.")
    print(f"  Open this address in your browser:  {url}")
    print("  Keep this window open while you use the app. Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    import logging
    logging.getLogger("werkzeug").setLevel(logging.ERROR)   # keep this window quiet; errors still show
    create_app().run(host="127.0.0.1", port=port, threaded=True, debug=False)
