import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type { Caller } from './caller.js';

// Drivers work on their own truck and loads; owners on anything in their business.

export interface LoadRef {
  id: string;
  load_number: string;
  truck_id: string;
  driver_id: string;
  trailer_type: string;
}

export interface TruckRef {
  id: string;
  unit_number: string;
  assigned_person_id: string | null;
}

export const forbiddenLoad = (): ApiError =>
  new ApiError(403, 'forbidden', "That load isn't on your truck, so it's one for the owner.");
export const forbiddenTruck = (): ApiError =>
  new ApiError(403, 'forbidden', "That's not your truck, so it's one for the owner.");
export const forbiddenRecord = (): ApiError =>
  new ApiError(403, 'forbidden', "That one isn't yours to change. It's one for the owner.");

export async function findLoad(db: Queryable, caller: Caller, loadId: string): Promise<LoadRef> {
  const { rows } = await db.query<LoadRef>(
    `select l.id, l.load_number, l.truck_id, l.driver_id, t.trailer_type
       from loads l join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
      where l.sandbox_id = $1 and l.business_id = $2 and l.id = $3`,
    [caller.sandboxId, caller.businessId, loadId],
  );
  const load = rows[0];
  if (!load) throw new ApiError(404, 'load_not_found', "I can't find that load.");
  return load;
}

export async function findTruck(db: Queryable, caller: Caller, truckId: string): Promise<TruckRef> {
  const { rows } = await db.query<TruckRef>(
    `select id, unit_number, assigned_person_id from trucks
      where sandbox_id = $1 and business_id = $2 and id = $3`,
    [caller.sandboxId, caller.businessId, truckId],
  );
  const truck = rows[0];
  if (!truck) throw new ApiError(404, 'truck_not_found', "I can't find that truck.");
  return truck;
}

/** The caller's own truck, if one is assigned to them. */
export async function callerTruckId(db: Queryable, caller: Caller): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from trucks where sandbox_id = $1 and assigned_person_id = $2 order by unit_number limit 1`,
    [caller.sandboxId, caller.personId],
  );
  return rows[0]?.id ?? null;
}

export function canUseLoad(caller: Caller, load: { driver_id: string }): boolean {
  return caller.isOwner || load.driver_id === caller.personId;
}

export function canUseTruck(caller: Caller, truck: { assigned_person_id: string | null }): boolean {
  return caller.isOwner || truck.assigned_person_id === caller.personId;
}

/**
 * Where a record belongs. With a load, the truck is the load's truck and any other `truck_id`
 * is a 400. Without one, an explicit truck, else `fallbackTruckId`, else business overhead.
 * `truckId` undefined means "not given"; null means "no truck".
 */
export async function resolveTarget(
  db: Queryable,
  caller: Caller,
  loadId: string | null,
  truckId: string | null | undefined,
  fallbackTruckId: string | null,
): Promise<{ loadId: string | null; truckId: string | null }> {
  if (loadId) {
    const load = await findLoad(db, caller, loadId);
    if (!canUseLoad(caller, load)) throw forbiddenLoad();
    if (truckId && truckId !== load.truck_id) {
      throw new ApiError(400, 'truck_load_mismatch', 'That load is on a different truck. Which one was it?');
    }
    return { loadId: load.id, truckId: load.truck_id };
  }
  const chosen = truckId === undefined ? fallbackTruckId : truckId;
  if (chosen) {
    const truck = await findTruck(db, caller, chosen);
    if (!canUseTruck(caller, truck)) throw forbiddenTruck();
    return { loadId: null, truckId: truck.id };
  }
  if (!caller.isOwner) throw forbiddenTruck();
  return { loadId: null, truckId: null };
}
