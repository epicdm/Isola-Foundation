# Engines — Usage Note

These are the proven engine clients extracted from the live BFF (magnus, fiserv, whatsapp, chatwoot, odoo).
Import and call them as-is — do not rewrite or reimplement their internals.
Each client takes a config object; wire that config from Replit Secrets at call time.

