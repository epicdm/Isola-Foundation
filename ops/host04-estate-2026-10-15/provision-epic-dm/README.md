# provision.epic.dm restored (2026-10-15)

Self-caused outage ~08:59Z-12:45Z: stopping the deepseek bff-v2 broke Acrobits provisioning and Custom Tab sign-in (nginx upstream 127.0.0.1:3005).
- prov-repoint.sh: deepseek nginx blocks repointed to host04 (backup + nginx -t gate).
- scripts/owner-run/zz-provision-epic-dm-host04.py: host04 routes (ACTION=create, fix adds the replacePathRegex middlewares; the panel internal path does not rewrite).
- zz-prov-h04.js, zz-tab-x.js: verification pinned to host04 (negatives, real-credential positives, bogus-code control). Port: ev-laneA-acrobits-provisioning-outage-from-deepseek-bff-stop-fixed-provision-epic-dm-on-host04-2026-10-15
