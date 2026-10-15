"""zz-host04-restic-credentials (Lane A, 2026-10-15; owner: deepseek and host03 are retiring, everything on host04).
Moves the EXISTING off-site backup credentials (Wasabi S3 + restic password, used by deepseek's restic jobs) to host04, value-blind:
  host04 : /etc/restic-host04.env (0400 root: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, WASABI_REGION, BUCKET_NAME, RESTIC_PASSWORD_FILE=/etc/restic-host04.pw) and /etc/restic-host04.pw (0400 root)
  laptop : C:\\Users\\girau\\epic-secrets\\restic-host04.env and .pw  (OUTSIDE any repository; deepseek's copy will not survive its retirement and a backup nobody can decrypt is not a backup)
Nothing is printed except lengths. BYTES end to end (no CRLF)."""
import subprocess, os, re, sys
def sh(host, cmd, inp=None):
    r = subprocess.run(["ssh", host, cmd], input=inp, capture_output=True); return r.stdout, r.stderr.decode(errors="replace")[:200], r.returncode
env_b, err, rc = sh("deepseek", "sudo cat /etc/restic-backup.env"); assert rc == 0, err
env = env_b.decode().replace("\r\n", "\n")
want = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "WASABI_REGION", "BUCKET_NAME"]
vals = {}
for line in env.splitlines():
    m = re.match(r"^(?:export\s+)?([A-Z_0-9]+)=(.*)$", line.strip())
    if m and m.group(1) in want: vals[m.group(1)] = m.group(2).strip().strip('"').strip("'")
assert all(k in vals and vals[k] for k in want), ("missing keys", [k for k in want if k not in vals])
pwpath = re.search(r"^(?:export\s+)?RESTIC_PASSWORD_FILE=(.*)$", env, re.M).group(1).strip().strip('"').strip("'")
pw_b, err, rc = sh("deepseek", "sudo cat " + pwpath); assert rc == 0 and len(pw_b.strip()) >= 8, ("password file unreadable", err)
pw = pw_b.strip()
body = "".join(f"{k}={vals[k]}\n" for k in want) + "RESTIC_PASSWORD_FILE=/etc/restic-host04.pw\n"
print("keys:", {k: len(vals[k]) for k in want}, "| password bytes:", len(pw), "| env bytes:", len(body))
o, e, rc = sh("epicadmin@host04", "sudo install -m 0400 -o root -g root /dev/stdin /etc/restic-host04.env && echo env-installed", body.encode()); print(o.decode().strip(), e, rc)
o, e, rc = sh("epicadmin@host04", "sudo install -m 0400 -o root -g root /dev/stdin /etc/restic-host04.pw && echo pw-installed", pw + b"\n"); print(o.decode().strip(), e, rc)
d = r"C:\Users\girau\epic-secrets"; os.makedirs(d, exist_ok=True)
open(os.path.join(d, "restic-host04.env"), "wb").write(body.encode()); open(os.path.join(d, "restic-host04.pw"), "wb").write(pw + b"\n")
print("laptop copy written to", d, "(files:", sorted(os.listdir(d)), ")")
