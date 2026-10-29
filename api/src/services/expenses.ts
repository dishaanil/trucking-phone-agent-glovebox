import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type {
  ConfirmResponse,
  CreateExpenseBody,
  DiscardResponse,
  ExpenseResponse,
  PatchExpenseBody,
} from '../ledger-schemas.js';
import { callerTruckId, forbiddenRecord, resolveTarget } from '../lib/access.js';
import type { Caller } from '../lib/caller.js';
import { recordEvent } from '../lib/events.js';
import type { WriteResult } from '../lib/idempotency.js';
import {
  confirmationPrompt,
  expenseFlags,
  FUTURE_TOLERANCE_MS,
  PRICE_PER_GALLON_CENTS,
  type ExpenseCategory,
} from '../lib/limits.js';
import { MAX_AMOUNT_CENTS, parseAmountCents, spokenAmount } from '../lib/money.js';
import { gallonsDecimal, gallonsMilliFromDb, MAX_GALLONS_MILLI, parseGallonsMilli } from '../lib/quantity.js';
import { categoryLabel, expenseReadback } from '../lib/readback.js';
import { toStateCode } from '../lib/states.js';

type PaymentMethod = ExpenseResponse['payment_method'];
type Status = ExpenseResponse['status'];

interface ExpenseRow {
  id: string;
  business_id: string;
  truck_id: string | null;
  person_id: string;
  load_id: string | null;
  category: ExpenseCategory;
  amount_cents: number;
  vendor: string | null;
  city: string | null;
  state: string | null;
  gallons: string | null;
  payment_method: PaymentMethod;
  reimbursable: boolean;
  occurred_at: Date;
  status: Status;
  receipt_status: string;
  call_id: string | null;
  load_number: string | null;
  load_driver_id: string | null;
  truck_unit: string | null;
  truck_assigned_person_id: string | null;
}

const EXPENSE_SELECT = `
  select e.id, e.business_id, e.truck_id, e.person_id, e.load_id, e.category, e.amount_cents, e.vendor,
         e.city, e.state, e.gallons::text as gallons, e.payment_method, e.reimbursable, e.occurred_at,
         e.status, e.receipt_status, e.call_id,
         l.load_number, l.driver_id as load_driver_id,
         t.unit_number as truck_unit, t.assigned_person_id as truck_assigned_person_id
    from expenses e
    left join loads l on l.id = e.load_id and l.sandbox_id = e.sandbox_id
    left join trucks t on t.id = e.truck_id and t.sandbox_id = e.sandbox_id
   where e.sandbox_id = $1 and e.id = $2`;
const EXPENSE_SELECT_FOR_UPDATE = `${EXPENSE_SELECT} for update of e`;

async function findExpense(db: Queryable, caller: Caller, id: string, forUpdate = false): Promise<ExpenseRow | null> {
  const { rows } = await db.query<ExpenseRow>(forUpdate ? EXPENSE_SELECT_FOR_UPDATE : EXPENSE_SELECT, [
    caller.sandboxId,
    id,
  ]);
  const row = rows[0];
  return row && row.business_id === caller.businessId ? row : null;
}

/** Owners edit anything; drivers edit what they logged or what is on their own load or truck. */
function canEdit(caller: Caller, e: ExpenseRow): boolean {
  if (caller.isOwner || e.person_id === caller.personId) return true;
  return e.load_id ? e.load_driver_id === caller.personId : e.truck_assigned_person_id === caller.personId;
}

// ---------- Input parsing (no database) ----------

function parseAmount(input: string): number {
  const cents = parseAmountCents(input);
  if (cents === null) throw new ApiError(400, 'invalid_amount', "I didn't catch a valid amount. How much was it?");
  if (cents > MAX_AMOUNT_CENTS) throw new ApiError(400, 'amount_too_large', "That amount is too large. How much was it?");
  return cents;
}

function parseGallons(input: string): number {
  const milli = parseGallonsMilli(input);
  if (milli === null || milli > MAX_GALLONS_MILLI) {
    throw new ApiError(400, 'invalid_gallons', "I didn't catch the gallons. How many was it?");
  }
  return milli;
}

function parseState(input: string): string {
  const code = toStateCode(input);
  if (!code) throw new ApiError(400, 'invalid_state', "I didn't catch the state. Which state was that in?");
  return code;
}

function parseOccurredAt(input: string | undefined, now: Date): Date {
  const at = input ? new Date(input) : now;
  if (at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new ApiError(400, 'occurred_in_future', "That time is in the future. When was it?");
  }
  return at;
}

function checkGallonsAllowed(category: ExpenseCategory, gallonsMilli: number | null): void {
  if (gallonsMilli !== null && !PRICE_PER_GALLON_CENTS[category]) {
    throw new ApiError(400, 'gallons_not_allowed', 'Gallons only go with fuel or DEF.');
  }
}

const defaultReimbursable = (category: ExpenseCategory, payment: PaymentMethod): boolean =>
  category === 'lumper' && payment === 'cash';

// ---------- Responses ----------

function toResponse(e: ExpenseRow, now: Date): ExpenseResponse {
  const gallonsMilli = e.gallons === null ? null : gallonsMilliFromDb(e.gallons);
  const reasons = expenseFlags({
    category: e.category,
    amountCents: e.amount_cents,
    gallonsMilli,
    occurredAt: e.occurred_at,
    now,
  });
  return {
    id: e.id,
    status: e.status,
    category: e.category,
    amount_cents: e.amount_cents,
    amount_display: spokenAmount(e.amount_cents),
    gallons: gallonsMilli === null ? null : gallonsDecimal(gallonsMilli),
    vendor: e.vendor,
    city: e.city,
    state: e.state,
    payment_method: e.payment_method,
    reimbursable: e.reimbursable,
    occurred_at: e.occurred_at.toISOString(),
    load_id: e.load_id,
    load_number: e.load_number,
    truck_id: e.truck_id,
    truck_unit: e.truck_unit,
    receipt_status: e.receipt_status,
    readback: expenseReadback({
      category: e.category,
      amountCents: e.amount_cents,
      gallonsMilli,
      vendor: e.vendor,
      city: e.city,
      state: e.state,
      paymentMethod: e.payment_method,
    }),
    needs_confirmation: reasons.length > 0,
    confirmation_reasons: reasons,
    confirmation_prompt: confirmationPrompt(reasons),
  };
}

async function reload(db: Queryable, caller: Caller, id: string): Promise<ExpenseRow> {
  const row = await findExpense(db, caller, id);
  if (!row) throw new Error(`expense ${id} vanished`);
  return row;
}

// ---------- Writes ----------

export async function createExpense(
  db: Queryable,
  caller: Caller,
  body: CreateExpenseBody,
): Promise<WriteResult<ExpenseResponse>> {
  const now = new Date();
  const amountCents = parseAmount(body.amount);
  const gallonsMilli = body.gallons === undefined ? null : parseGallons(body.gallons);
  checkGallonsAllowed(body.category, gallonsMilli);
  const state = body.state === undefined ? null : parseState(body.state);
  const occurredAt = parseOccurredAt(body.occurred_at, now);
  const payment = body.payment_method ?? 'unknown';

  const target = await resolveTarget(db, caller, body.load_id ?? null, body.truck_id, await callerTruckId(db, caller));

  const { rows } = await db.query<{ id: string }>(
    `insert into expenses (sandbox_id, business_id, truck_id, person_id, load_id, category, amount_cents,
                           vendor, city, state, gallons, payment_method, reimbursable, occurred_at, call_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id`,
    [
      caller.sandboxId, caller.businessId, target.truckId, caller.personId, target.loadId, body.category,
      amountCents, body.vendor ?? null, body.city ?? null, state,
      gallonsMilli === null ? null : gallonsDecimal(gallonsMilli), payment,
      body.reimbursable ?? defaultReimbursable(body.category, payment), occurredAt, body.call_id,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no id');
  const response = toResponse(await reload(db, caller, id), now);

  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    callId: body.call_id,
    actorPersonId: caller.personId,
    type: 'expense.created',
    payload: {
      id,
      category: response.category,
      amount_cents: response.amount_cents,
      load_number: response.load_number,
      truck_unit: response.truck_unit,
      status: response.status,
    },
  });
  return { statusCode: 201, body: response };
}

/** Values of the fields a correction can change, as the API names them. */
type Fields = Record<string, string | number | boolean | null>;

/**
 * Correct an expense in place. A confirmed expense goes back to pending, since the caller
 * must hear and confirm the new readback. Writes an event with the old and new values.
 */
export async function correctExpense(
  db: Queryable,
  caller: Caller,
  id: string,
  body: PatchExpenseBody,
): Promise<WriteResult<ExpenseResponse>> {
  const now = new Date();
  const existing = await findExpense(db, caller, id, true);
  if (!existing) throw new ApiError(404, 'expense_not_found', "I can't find that expense.");
  if (!canEdit(caller, existing)) throw forbiddenRecord();
  if (existing.status === 'discarded') {
    throw new ApiError(409, 'record_discarded', 'That one was already removed. Want me to log it again?');
  }

  const category = body.category ?? existing.category;
  const amountCents = body.amount === undefined ? existing.amount_cents : parseAmount(body.amount);
  let gallonsMilli: number | null;
  if (body.gallons === undefined) {
    // Gallons no longer apply when the category changes away from fuel or DEF.
    gallonsMilli =
      existing.gallons === null || !PRICE_PER_GALLON_CENTS[category] ? null : gallonsMilliFromDb(existing.gallons);
  } else {
    gallonsMilli = body.gallons === null ? null : parseGallons(body.gallons);
  }
  checkGallonsAllowed(category, gallonsMilli);
  const state = body.state === undefined ? existing.state : body.state === null ? null : parseState(body.state);
  const occurredAt = body.occurred_at === undefined ? existing.occurred_at : parseOccurredAt(body.occurred_at, now);
  const payment = body.payment_method ?? existing.payment_method;
  const reimbursable =
    body.reimbursable ??
    (category !== existing.category || payment !== existing.payment_method
      ? defaultReimbursable(category, payment)
      : existing.reimbursable);

  const loadId = body.load_id === undefined ? existing.load_id : body.load_id;
  // Keep the existing truck unless the load or truck changes.
  const target = await resolveTarget(db, caller, loadId, body.truck_id, existing.truck_id);

  const before: Fields = {
    category: existing.category,
    amount_cents: existing.amount_cents,
    vendor: existing.vendor,
    city: existing.city,
    state: existing.state,
    gallons: existing.gallons === null ? null : gallonsDecimal(gallonsMilliFromDb(existing.gallons)),
    payment_method: existing.payment_method,
    reimbursable: existing.reimbursable,
    occurred_at: existing.occurred_at.toISOString(),
    load_id: existing.load_id,
    truck_id: existing.truck_id,
  };
  const after: Fields = {
    category,
    amount_cents: amountCents,
    vendor: body.vendor === undefined ? existing.vendor : body.vendor,
    city: body.city === undefined ? existing.city : body.city,
    state,
    gallons: gallonsMilli === null ? null : gallonsDecimal(gallonsMilli),
    payment_method: payment,
    reimbursable,
    occurred_at: occurredAt.toISOString(),
    load_id: target.loadId,
    truck_id: target.truckId,
  };
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  if (changed.length === 0) return { statusCode: 200, body: toResponse(existing, now) };

  await db.query(
    `update expenses
        set category = $3, amount_cents = $4, vendor = $5, city = $6, state = $7, gallons = $8,
            payment_method = $9, reimbursable = $10, occurred_at = $11, load_id = $12, truck_id = $13,
            status = 'pending', updated_at = now()
      where sandbox_id = $1 and id = $2`,
    [
      caller.sandboxId, id, after.category, after.amount_cents, after.vendor, after.city, after.state,
      after.gallons, after.payment_method, after.reimbursable, occurredAt, after.load_id, after.truck_id,
    ],
  );
  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    callId: body.call_id,
    actorPersonId: caller.personId,
    type: 'expense.corrected',
    payload: {
      id,
      old: Object.fromEntries(changed.map((k) => [k, before[k]])),
      new: Object.fromEntries(changed.map((k) => [k, after[k]])),
      status_before: existing.status,
      status_after: 'pending',
    },
  });
  return { statusCode: 200, body: toResponse(await reload(db, caller, id), now) };
}

export async function confirmExpenses(
  db: Queryable,
  caller: Caller,
  ids: string[],
  callId: string,
): Promise<WriteResult<ConfirmResponse>> {
  const results: ConfirmResponse['results'] = [];
  for (const id of [...new Set(ids)]) {
    const e = await findExpense(db, caller, id, true);
    if (!e) {
      results.push({ id, result: 'not_found' });
    } else if (!canEdit(caller, e)) {
      results.push({ id, result: 'forbidden' });
    } else if (e.status !== 'pending') {
      // Confirming anything that is not pending is a no-op.
      results.push({ id, result: e.status === 'confirmed' ? 'already_confirmed' : 'discarded' });
    } else {
      await db.query(
        `update expenses set status = 'confirmed', updated_at = now() where sandbox_id = $1 and id = $2`,
        [caller.sandboxId, id],
      );
      await recordEvent(db, {
        sandboxId: caller.sandboxId,
        callId,
        actorPersonId: caller.personId,
        type: 'expense.confirmed',
        payload: { id, category: e.category, amount_cents: e.amount_cents, load_number: e.load_number },
      });
      results.push({ id, result: 'confirmed' });
    }
  }
  return {
    statusCode: 200,
    body: { results, confirmed_count: results.filter((r) => r.result === 'confirmed').length },
  };
}

/**
 * Void an expense. Pending: anyone who can edit it. Confirmed: the person who logged it during
 * the same call, or an owner at any time. Always writes an audit event.
 */
export async function discardExpense(
  db: Queryable,
  caller: Caller,
  id: string,
  body: { reason?: string | undefined; call_id: string },
): Promise<WriteResult<DiscardResponse>> {
  const e = await findExpense(db, caller, id, true);
  if (!e) throw new ApiError(404, 'expense_not_found', "I can't find that expense.");
  if (!canEdit(caller, e)) throw forbiddenRecord();

  const message = `Okay, I removed the ${categoryLabel(e.category).toLowerCase()}, ${spokenAmount(e.amount_cents)}.`;
  if (e.status === 'discarded') {
    return { statusCode: 200, body: { id, status: 'discarded', previous_status: 'discarded', message } };
  }
  if (e.status === 'confirmed' && !caller.isOwner && !(e.person_id === caller.personId && e.call_id === body.call_id)) {
    throw new ApiError(403, 'confirmed_record', "That one's already on the books, so the owner will need to remove it.");
  }

  await db.query(`update expenses set status = 'discarded', updated_at = now() where sandbox_id = $1 and id = $2`, [
    caller.sandboxId,
    id,
  ]);
  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    callId: body.call_id,
    actorPersonId: caller.personId,
    type: 'expense.discarded',
    payload: {
      id,
      previous_status: e.status,
      reason: body.reason ?? null,
      category: e.category,
      amount_cents: e.amount_cents,
      logged_by: e.person_id,
      logged_in_call: e.call_id,
    },
  });
  return { statusCode: 200, body: { id, status: 'discarded', previous_status: e.status, message } };
}
