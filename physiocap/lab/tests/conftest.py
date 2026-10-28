import os
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
os.environ["PHYSIOCAP_NO_SYNC"] = "1"
