export type Freshness = 'fresh' | 'stale' | 'unavailable';

export interface Customer360Document {
  id: number;
  reference: string;
  kind: 'quotation' | 'order' | 'invoice';
  state: string | null;
  paymentState?: string | null;
  total: number | null;
  residual?: number | null;
  date: string | null;
}

export interface Customer360Loop {
  id: number;
  title: string;
  kind: 'opportunity' | 'task';
  state: string | null;
  due: string | null;
  value?: number | null;
}

export interface Customer360Snapshot {
  verifiedAt: string;
  freshness: Freshness;
  conversation: {
    displayId: number;
    currentRequest: string | null;
  };
  customer: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    city: string | null;
  };
  balanceDue: number | null;
  documents: Customer360Document[];
  openLoops: Customer360Loop[];
}

export type Customer360Response =
  | { state: 'ready'; snapshot: Customer360Snapshot }
  | { state: 'not-linked'; message: string }
  | { state: 'not-found'; message: string }
  | { state: 'unavailable'; message: string };
