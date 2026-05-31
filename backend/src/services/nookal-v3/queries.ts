/**
 * GraphQL queries — field names verified via live introspection 2026-04-22.
 *
 * Nookal's Revenue Report UI filters by ENTRY service date (when the service
 * was delivered), not invoice creation date. So we fetch entries by date
 * range, then resolve each entry's parent invoice to get the locationID.
 *
 * Nookal silently caps `pageLength` at 200 — page until a result is < 200.
 */

export const PAGE_LENGTH = 200;

// Fetch entries by service-delivery date. No locationID arg available at
// this level — we filter afterwards via the invoice lookup.
export const ENTRIES_BY_DATE_QUERY = /* GraphQL */ `
  query EntriesByDate($dateFrom: String!, $dateTo: String!, $page: Int!, $pageLength: Int!) {
    invoiceEntry(
      dateFrom:   $dateFrom,
      dateTo:     $dateTo,
      page:       $page,
      pageLength: $pageLength
    ) {
      entryID
      invoiceID
      itemType
      name
      ItemCode
      qty
      subtotal
      tax
      total
      void
      date
      providerID
    }
  }
`;

// Lookup invoices by ID (batched) to get locationID per entry's parent.
// Nookal's `invoices` query defaults to `void: 0` (non-voided only) and there
// is no "both" switch — we have to make two calls with void=0 and void=1 and
// merge, because Nookal's Revenue Report UI *includes* voided invoices.
export const INVOICES_BY_ID_QUERY = /* GraphQL */ `
  query InvoicesByID($invoiceIDs: [Int], $void: Int, $page: Int!, $pageLength: Int!) {
    invoices(
      invoiceIDs: $invoiceIDs,
      void:       $void,
      page:       $page,
      pageLength: $pageLength
    ) {
      invoiceID
      locationID
      isThirdPartyInvoice
      practitionerID
      void
      dateCreated
    }
  }
`;

export interface V3InvoiceEntry {
  entryID:    number;
  invoiceID:  number;
  itemType:   string;    // e.g. "Consultation", "Stock"
  name:       string;
  ItemCode:   string | null;
  qty:        number;
  subtotal:   number;
  tax:        number;
  total:      number;
  void:       number;
  date:       string;
  providerID: number | null;  // nullable — admin/fee entries have no provider
}

export interface V3InvoiceStub {
  invoiceID:             number;
  locationID:            number;
  isThirdPartyInvoice:   number;
  practitionerID:        number | null;
  void:                  number;
  dateCreated:           string;    // "Fri Jan 31 2025 10:00:00 GMT+1000 ..."
}

export interface EntriesByDateResult {
  invoiceEntry: V3InvoiceEntry[];
}

export interface InvoicesByIDResult {
  invoices: V3InvoiceStub[];
}

// Payments by date range (date = payment receipt date).
// Nookal v3 pageLength silently capped at 200.
export const PAYMENTS_BY_DATE_QUERY = /* GraphQL */ `
  query PaymentsByDate($dateFrom: String!, $dateTo: String!, $page: Int!, $pageLength: Int!) {
    payments(
      dateFrom:   $dateFrom,
      dateTo:     $dateTo,
      page:       $page,
      pageLength: $pageLength
    ) {
      paymentID
      locationID
      method
      amount
      date
      active
      invoiceID
      clientID
    }
  }
`;

export interface V3Payment {
  paymentID:  number;
  locationID: number;
  method:     string | null;
  amount:     number;
  date:       string;
  active:     number;
  invoiceID:  number;
  clientID:   number;
}

export interface PaymentsByDateResult {
  payments: V3Payment[];
}

// Account credits (a.k.a. "Upfront Revenue") — matches Nookal's
// Reports → Account Credits screen.
export const CREDITS_BY_DATE_QUERY = /* GraphQL */ `
  query CreditsByDate($dateFrom: String!, $dateTo: String!, $page: Int!, $pageLength: Int!) {
    credits(
      dateFrom:   $dateFrom,
      dateTo:     $dateTo,
      page:       $page,
      pageLength: $pageLength
    ) {
      creditID
      locationID
      clientID
      method
      amount
      invoiceID
      date
      void
      fromAdjustment
    }
  }
`;

export interface V3Credit {
  creditID:       number;
  locationID:     number;
  clientID:       number;
  method:         string | null;
  amount:         number;
  invoiceID:      number;
  date:           string;
  void:           number;
  fromAdjustment: number;
}

export interface CreditsByDateResult {
  credits: V3Credit[];
}

// ── Clients & Cases (used by patient-metrics.service) ─────────────

export const CLIENTS_BY_ID_QUERY = /* GraphQL */ `
  query ClientsByID($ids: [Int], $page: Int!, $pageLength: Int!) {
    clients(clientIDs: $ids, page: $page, pageLength: $pageLength) {
      clientID
      dateCreated
      registrationDate
    }
  }
`;

export interface V3ClientStub {
  clientID:         number;
  dateCreated:      string;
  registrationDate: string;
}

export interface ClientsByIDResult {
  clients: V3ClientStub[];
}

export const CASES_BY_ID_QUERY = /* GraphQL */ `
  query CasesByID($caseIDs: [Int], $page: Int!, $pageLength: Int!) {
    cases(caseIDs: $caseIDs, page: $page, pageLength: $pageLength) {
      caseID
      clientID
      dateAdded
      primaryProviderID
    }
  }
`;

export interface V3CaseStub {
  caseID:            number;
  clientID:          number;
  dateAdded:         string;
  primaryProviderID: number | null;
}

export interface CasesByIDResult {
  cases: V3CaseStub[];
}

// ── Appointments (source for New Client / New Case metrics) ──────

export const APPOINTMENTS_BY_DATE_QUERY = /* GraphQL */ `
  query AppointmentsByDate(
    $locationIDs: [Int], $dateFrom: String!, $dateTo: String!,
    $page: Int!, $pageLength: Int!
  ) {
    appointments(
      locationIDs: $locationIDs,
      dateFrom:    $dateFrom,
      dateTo:      $dateTo,
      page:        $page,
      pageLength:  $pageLength
    ) {
      apptID
      clientID
      providerID
      caseID
      appointmentDate
      isNewClient
      isNewCase
      arrived
      status
      dna
    }
  }
`;

export interface V3Appointment {
  apptID:          number;
  clientID:        number;
  providerID:      number | null;
  caseID:          number | null;
  appointmentDate: string;
  isNewClient:     number;   // 0 / 1
  isNewCase:       number;
  arrived:         number;
  status:          string | null;
  dna:             number | null;   // 1 = appointment was marked DNA at some point
}

export interface AppointmentsByDateResult {
  appointments: V3Appointment[];
}

// ── Ageing Debts (outstanding invoice balances) ───────────────
// Fetches invoices by creation-date range with the server-computed
// Balance field (Total − payments − adjustments + refunds).
// isThirdPartyInvoice: 1 = billed to insurer/third-party, 0 = patient direct.
export const INVOICES_BY_DATE_BALANCE_QUERY = /* GraphQL */ `
  query InvoicesByDateBalance(
    $dateFrom:    String!,
    $dateTo:      String!,
    $locationIDs: [Int],
    $void:        Int,
    $page:        Int!,
    $pageLength:  Int!
  ) {
    invoices(
      dateFrom:    $dateFrom,
      dateTo:      $dateTo,
      locationIDs: $locationIDs,
      void:        $void,
      page:        $page,
      pageLength:  $pageLength
    ) {
      invoiceID
      invoiceNumber
      clientID
      locationID
      Balance
      Total
      TotalPayments
      dateCreated
      void
      isThirdPartyInvoice
    }
  }
`;

export interface V3InvoiceBalance {
  invoiceID:            number;
  invoiceNumber:        string | null;  // null/empty = draft (not yet finalised)
  clientID:             number;         // 0 = orphaned invoice (client deleted); exclude from ageing
  locationID:           number;
  Balance:              number;   // server-computed outstanding amount
  Total:                number;   // invoice face value (0 = incomplete DNA-fee entry)
  TotalPayments:        number;   // sum of all payments applied to this invoice
  dateCreated:          string;   // "Wed Jan 03 2024 10:00:00 GMT+1000 ..."
  void:                 number;
  isThirdPartyInvoice:  number;   // 1 = insurer/third-party, 0 = patient direct
}

export interface InvoicesByDateBalanceResult {
  invoices: V3InvoiceBalance[];
}
