#!/usr/bin/env python3
"""
Long-running Whisper transcription server.

Communicates via stdio JSON lines:
  - Emits {"ready": true} after model loads
  - Reads  {"id": "...", "file": "/path.ogg"} from stdin
  - Writes {"id": "...", "text": "..."} to stdout
  - Errors: {"id": "...", "error": "..."} to stdout
"""

import json
import os
import sys
import warnings

# Suppress FP16/FP32 warnings on CPU
warnings.filterwarnings("ignore", message="FP16 is not supported on CPU")

import whisper


def main():
    model_name = os.environ.get("WHISPER_MODEL", "medium")

    # Log to stderr so it doesn't interfere with JSON protocol on stdout
    print(f"Loading Whisper model '{model_name}'...", file=sys.stderr, flush=True)
    model = whisper.load_model(model_name)
    print(f"Model '{model_name}' loaded.", file=sys.stderr, flush=True)

    # Signal readiness on stdout
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            file_path = req.get("file")

            if not file_path:
                print(json.dumps({"id": req_id, "error": "missing 'file' field"}), flush=True)
                continue

            if not os.path.isfile(file_path):
                print(json.dumps({"id": req_id, "error": f"file not found: {file_path}"}), flush=True)
                continue

            result = model.transcribe(file_path)
            text = result.get("text", "").strip()
            print(json.dumps({"id": req_id, "text": text}), flush=True)

        except json.JSONDecodeError as e:
            print(json.dumps({"id": req_id, "error": f"invalid JSON: {e}"}), flush=True)
        except Exception as e:
            print(json.dumps({"id": req_id, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
