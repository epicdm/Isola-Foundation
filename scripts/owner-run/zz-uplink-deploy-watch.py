"""zz-uplink-deploy-watch: deploy the owner-approved digest and WATCH from the first second; on ANY trigger (new task Failed/Rejected/Shutdown, restart = more than one new task row, 5xx/no answer on the workspace host or the public turn route) run the prepared rollback IMMEDIATELY.
Order: start the host04 observer (streams one line per ~1 s), wait for WATCH-START, run the image-only update+deploy script, keep reading the stream.  Exit 0 = STABLE-OK (35 s one task, no restart, update completed); 10 = rolled back; other = see log.
Never prints env values (the promote script shows env as NAME(len) only)."""
import subprocess, sys, os, time, threading
HERE = os.path.dirname(os.path.abspath(__file__))
PROMOTE = os.path.join(HERE, "zz-uplink-pilot-overlay-promote.py")
obs = subprocess.Popen(["ssh", "-o", "ConnectTimeout=15", "epicadmin@66.118.37.29", "bash /tmp/dep-watch2.sh 110"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
first = obs.stdout.readline().strip(); print(first, flush=True)
assert first.startswith("WATCH-START"), first
state = {"trigger": None, "stable": False, "lines": []}
def reader():
    for line in obs.stdout:
        line = line.rstrip(); print(line, flush=True); state["lines"].append(line)
        if line.startswith("TRIGGER"): state["trigger"] = line
        if line.startswith("STABLE-OK"): state["stable"] = True
threading.Thread(target=reader, daemon=True).start()
t0 = time.time()
dep = subprocess.run([sys.executable, PROMOTE], capture_output=True, text=True)
print("--- promote script (deploy) rc=%s at +%.1fs" % (dep.returncode, time.time() - t0), flush=True); print(dep.stdout[-1800:], flush=True)
deadline = time.time() + 120
while time.time() < deadline and not state["trigger"] and not state["stable"] and obs.poll() is None:
    time.sleep(0.3)
if dep.returncode != 0 or state["trigger"]:
    print("!!! ROLLBACK NOW:", state["trigger"] or "deploy script failed", flush=True)
    env = dict(os.environ, REVERSE="1")
    rb = subprocess.run([sys.executable, PROMOTE], capture_output=True, text=True, env=env)
    print("--- rollback rc=%s at +%.1fs" % (rb.returncode, time.time() - t0), flush=True); print(rb.stdout[-1500:], flush=True)
    sys.exit(10)
print("RESULT: stable=%s trigger=%s" % (state["stable"], state["trigger"]), flush=True)
sys.exit(0 if state["stable"] else 11)
