// Synthetic sample data only. No real business, customer, or transaction is represented.
import { addDays } from '../domain/dates.js';

export const SALES_TEMPLATE = 'sale_id,sale_date,total_due,expected_account,expected_reference,customer_label,due_date,claimed_payment_status,notes\r\nS-001,2026-11-14,1000.00,GCASH,REF1001,CUST-A,,PAID,Example row - replace with your own\r\n';
export const RECEIPTS_TEMPLATE = 'receipt_id,received_at,amount,account_id,reference,sale_id,fee,net_amount,notes\r\nR-001,2026-11-14,1000.00,GCASH,REF1001,S-001,0.00,1000.00,Example row - replace with your own\r\n';

export const SAMPLE_ACCOUNTS = [
  { id: 'CASH', label: 'Cash drawer', type: 'CASH', active: true },
  { id: 'GCASH', label: 'E-wallet (sample)', type: 'EWALLET', active: true },
  { id: 'BANK', label: 'Bank account (sample)', type: 'BANK', active: true },
];

/** Sample CSVs for the two days ending on `day`. */
export function sampleCsv(day) {
  const d1 = addDays(day, -1); const due = addDays(day, 7);
  const sales = [
    'sale_id,sale_date,total_due,expected_account,expected_reference,customer_label,due_date,claimed_payment_status,notes',
    `S-0001,${d1},1000.00,GCASH,GC-70001,CUST-01,,PAID,Paid in full by e-wallet`,
    `S-0002,${d1},1500.00,,,CUST-02,${d1},PARTIAL,Paid in two parts`,
    `S-0003,${d1},800.00,BANK,BK-555,CUST-03,${due},UNPAID,Credit sale`,
    `S-0004,${day},450.00,CASH,,WALK-IN,,PAID,Cash sale`,
    `S-0005,${day},1200.00,GCASH,GC-70005,CUST-04,,PAID,"Marked paid, no receipt found"`,
    `S-0006,${day},1000.00,GCASH,GC-70006,CUST-05,,PAID,Customer overpaid`,
    `S-0007,${day},300.00,GCASH,GC-70007,CUST-06,,PAID,Two receipts share this reference`,
    `S-0008,${day},650.00,CASH,,WALK-IN,,PAID,Cash sale`,
  ].join('\r\n') + '\r\n';
  const receipts = [
    'receipt_id,received_at,amount,account_id,reference,sale_id,fee,net_amount,notes',
    `R-0001,${d1}T10:15:00+08:00,1000.00,GCASH,GC-70001,,0.00,1000.00,`,
    `R-0002,${d1},900.00,CASH,,S-0002,,,First part`,
    `R-0003,${day},600.00,CASH,,S-0002,,,Second part`,
    `R-0004,${day},450.00,CASH,,S-0004,,,`,
    `R-0005,${day}T14:02:00+08:00,1100.00,GCASH,GC-70006,S-0006,20.00,1080.00,Gross 1100 less 20 fee`,
    `R-0006,${day},300.00,GCASH,GC-70007,,,,`,
    `R-0007,${day},300.00,GCASH,GC-70007,,,,Possible duplicate`,
    `R-0008,${day},650.00,CASH,,S-0008,,,`,
    `R-0009,${day},250.00,BANK,BK-999,,,,No matching sale`,
  ].join('\r\n') + '\r\n';
  return { sales, receipts };
}
