/**
 * Provenance envelope for the Tenant Zero workspace.
 *
 * Chunk 1 acceptance requires that every panel state where its data came from,
 * how fresh it is, and — critically — that nothing unconfigured is rendered as
 * if it were real. This module is the single place those semantics are defined.
 *
 * Rule: a panel is `live` only when a real record was read from an authoritative
 * store. Absence of data is `empty` (we looked, there is nothing). A capability
 * that has no backing data model yet is `not_configured`. A store we could not
 * reach is `unavailable`. Never `live` with invented content.
 */

/** Authoritative system a fact came from. Mirrors the Isola engine authority map. */
export type SourceSystem =
  | 'isola.foundation' // Foundation/Spine Postgres — identity, tenants, agents, bindings
  | 'isola.mirror' // Local conversation mirror, synced from Chatwoot webhooks
  | 'chatwoot' // Chatwoot Application API (live read)
  | 'clawith' // Clawith customer-agent runtime
  | 'odoo' // Business system of record
  | 'magnus' // Voice / rating / CDR authority
  | 'meta' // WhatsApp Cloud API asset state
  | 'isola.config'; // Deployment configuration (env-level flags)

export type Availability =
  /** Real records were read from the authoritative store. */
  | 'live'
  /** The store was queried successfully and holds no rows for this tenant. */
  | 'empty'
  /** No backing data model/configuration exists yet — this is a known product gap. */
  | 'not_configured'
  /** The authoritative store could not be reached or is not wired on this deployment. */
  | 'unavailable';

export interface Provenance {
  source: SourceSystem;
  /** ISO timestamp of the read that produced this payload. */
  verifiedAt: string;
  /**
   * Timestamp of the newest underlying record, when the data has its own clock
   * (e.g. last message). Null when the concept does not apply.
   */
  dataAsOf: string | null;
  availability: Availability;
  /**
   * Owner-readable explanation shown verbatim in the UI when availability is not
   * `live`. Must state what is missing and what would make it real — never a
   * generic "no data".
   */
  note: string | null;
}

export interface Panel<T> {
  data: T;
  provenance: Provenance;
}

const now = () => new Date().toISOString();

export function live<T>(source: SourceSystem, data: T, dataAsOf: Date | string | null = null): Panel<T> {
  return {
    data,
    provenance: {
      source,
      verifiedAt: now(),
      dataAsOf: dataAsOf ? new Date(dataAsOf).toISOString() : null,
      availability: 'live',
      note: null,
    },
  };
}

export function empty<T>(source: SourceSystem, data: T, note: string): Panel<T> {
  return {
    data,
    provenance: { source, verifiedAt: now(), dataAsOf: null, availability: 'empty', note },
  };
}

export function notConfigured<T>(source: SourceSystem, data: T, note: string): Panel<T> {
  return {
    data,
    provenance: { source, verifiedAt: now(), dataAsOf: null, availability: 'not_configured', note },
  };
}

export function unavailable<T>(source: SourceSystem, data: T, note: string): Panel<T> {
  return {
    data,
    provenance: { source, verifiedAt: now(), dataAsOf: null, availability: 'unavailable', note },
  };
}

/** Human label for a source, for UI attribution. Never exposes infrastructure detail. */
export const SOURCE_LABELS: Record<SourceSystem, string> = {
  'isola.foundation': 'Isola',
  'isola.mirror': 'Isola conversation record',
  chatwoot: 'Conversation platform',
  clawith: 'Assistant runtime',
  odoo: 'Business records',
  magnus: 'Voice platform',
  meta: 'WhatsApp',
  'isola.config': 'Workspace configuration',
};
