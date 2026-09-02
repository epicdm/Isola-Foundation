# WS4 — NocoBase permission matrix for `isola-provisioner`

Status: **purpose-based draft, pending the read-only contract probe.**

Every collection and field name below is marked **`UNRESOLVED`**. The actual
NocoBase schema has **not** been inventoried, and this lane holds no NocoBase
credential. Nothing here may be treated as a schema reference until the probe
replaces the placeholders with real names and the owner approves the result.

> **Do not create the `isola-provisioner` role or user from this document.**
> It states what the identity must be able to *do*. It does not yet state
> *where*.

Authority: owner ruling 2026-08-11 — NocoBase is the authoritative control
plane; the Activepieces engine worker is the sole consumer of the scoped
credential, held in a protected App Connection in project
`HCNdJEYRAscCVKekNHmgM`.

---

## 1. Principles

1. **Purpose before permission.** Every grant traces to a provisioning step in
   `WS4-PROVISIONING-STATE-MACHINE.md`. A grant with no step is removed.
2. **No delete, anywhere.** Compensation retires; it never deletes. The role
   should not hold destroy on any collection, so a bug cannot destroy control-
   plane history.
3. **Row scope is tenant scope.** The identity operates on one tenant's records
   per run. Where NocoBase can express a row condition, it must.
4. **Field boundary is explicit.** Update grants name the fields they may write.
   Broad update on a control-plane record is how policy gets silently rewritten.
5. **Read is not free.** Read grants are listed per purpose; the identity should
   not be able to enumerate the whole control plane to fetch one record.
6. **No schema authority.** The identity must not create, alter or drop
   collections or fields. Schema change is a reviewed migration, never a
   runtime action.

## 2. Matrix

`C` create · `R` read · `U` update · `D` delete — **`D` is never granted.**

| Purpose (step) | Collection | C | R | U | D | Field boundary | Row scope |
|---|---|:-:|:-:|:-:|:-:|---|---|
| Resolve the tenant being provisioned | `UNRESOLVED:tenant` | – | ✓ | – | ✗ | identity + status fields only | the run's tenant |
| Create the control-plane tenant record (`nocobase_tenant`) | `UNRESOLVED:tenant` | ✓ | ✓ | ✓ | ✗ | `UNRESOLVED` — created-by-provisioning fields only; must NOT include entitlement, plan or billing fields | the run's tenant |
| Record entitlements as approved input | `UNRESOLVED:entitlement` | – | ✓ | – | ✗ | read only — the provisioner consumes entitlements, never grants them | the run's tenant |
| Record the AI company (`paperclip_company`) | `UNRESOLVED:ai_company` | ✓ | ✓ | ✓ | ✗ | external id, status, timestamps | the run's tenant |
| Record the AI employee (`paperclip_employee`) | `UNRESOLVED:ai_employee` | ✓ | ✓ | ✓ | ✗ | external id, template, **exposure (read-only after create)**, status | the run's tenant |
| Record the conversation workspace (`chatwoot_workspace`) | `UNRESOLVED:workspace` | ✓ | ✓ | ✓ | ✗ | account/inbox/team/bot ids, status | the run's tenant |
| Record the binding (`gateway_binding`) | `UNRESOLVED:binding` | ✓ | ✓ | ✓ | ✗ | **status only** on update — never exposure, routing or policy fields | the run's tenant |
| Write provisioning state and history | `UNRESOLVED:provisioning_run`, `UNRESOLVED:provisioning_step` | ✓ | ✓ | ✓ | ✗ | state, timestamps, attempts, external_ref, failure category | the run's tenant |
| Operator visibility (acceptance #27) | all of the above | – | ✓ | – | ✗ | — | **operator role, not the provisioner** |

## 3. Explicitly denied

| Denied | Why |
|---|---|
| Delete on any collection | Compensation retires, never deletes |
| Collection/field schema changes | Schema is a reviewed migration |
| User, role or permission collections | The provisioner must not be able to widen itself |
| API-key collections | Must not mint or read credentials |
| Entitlement/plan/billing **writes** | Commercial state is not a provisioning output |
| Exposure, routing or binding **policy** fields | Owned by the Registry/Gateway validation contract |
| Cross-tenant reads where a row condition is expressible | Tenant isolation |

## 4. Negative tests required before the role is used

Each must **fail** when attempted by `isola-provisioner`:

1. Delete any record in any collection in §2.
2. Read or write a user, role or permission record.
3. Read or write an API-key record.
4. Update an entitlement, plan or billing field.
5. Update a binding's exposure, routing or policy field.
6. Read a record belonging to a **different** tenant.
7. Create or alter a collection or field.
8. Update an AI employee's `exposure` after creation.

And each must **succeed**:

9. Read the run's own tenant.
10. Create and update its own provisioning run and step records.
11. Record an external id against the run's tenant.

Negative tests come first. A role is only least-privileged if the denials are
demonstrated, not assumed.

## 5. Resolution procedure

1. Owner completes the NocoBase security sequence and approves this matrix.
2. Read-only contract probe records the real collection and field names, plus a
   schema version/digest.
3. Every `UNRESOLVED:` placeholder is replaced with the real name in this file,
   and the diff is reviewed.
4. Owner creates the role and user, and negative tests 1–8 are run and recorded.
5. Only then is a finite-expiry API key minted, under `isola-provisioner`, and
   placed straight into the protected App Connection.

## 6. Known constraints

- **NocoBase API keys carry the creator identity and a role selected from roles
  assigned to that creator.** The selector is meaningful, but the key must still
  be created while signed in as `isola-provisioner` so ownership and role
  binding are both dedicated, auditable and independently revocable.
- At NocoBase **v2.0.48**, `storage/apps/main/jwt_secret.dat` takes precedence
  over `APP_KEY`. The owner has chosen a deliberate migration to a managed
  `APP_KEY`, expecting global token and API-key invalidation. **Mint the WS4 key
  after that migration**, or it will be invalidated by it.
- **Activepieces CE has no per-project roles**, so the machine identity is a
  platform ADMIN there. The compensating control is that every WS4 write asserts
  project `HCNdJEYRAscCVKekNHmgM` explicitly.
