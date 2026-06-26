/* global module */

function allocateWarehouseInventory(
  order = {},
  inventory = {},
  rules = {},
  now = new Date()
) {
  const sku = order.sku ?? inventory.sku ?? null;
  const requestedUnits = Math.max(0, order.quantity ?? 0);

  if (order.status !== 'paid') {
    return blocked(sku, 'order_not_paid');
  }
  if (requestedUnits <= 0) {
    return blocked(sku, 'empty_order');
  }

  const nowMs = new Date(now).getTime();
  if (
    inventory.lotExpiresAt &&
    new Date(inventory.lotExpiresAt).getTime() <= nowMs
  ) {
    return blocked(sku, 'inventory_expired');
  }

  const onHandUnits = Math.max(0, inventory.onHandUnits ?? 0);
  const reservedUnits = Math.max(0, inventory.reservedUnits ?? 0);
  const safetyStockUnits = Math.max(
    0,
    rules.safetyStockUnits ?? inventory.safetyStockUnits ?? 0
  );
  const expressBufferUnits =
    order.serviceLevel === 'express'
      ? Math.max(0, rules.expressBufferUnits ?? 0)
      : 0;
  const availableUnits = Math.max(
    0,
    onHandUnits - reservedUnits - safetyStockUnits - expressBufferUnits
  );

  if (availableUnits >= requestedUnits) {
    return allocated(
      sku,
      requestedUnits,
      0,
      inventory.warehouseId ?? null,
      shipAt(now, order.serviceLevel, rules)
    );
  }

  const shortfallUnits = requestedUnits - availableUnits;
  const incomingUnits = Math.max(0, inventory.incomingUnits ?? 0);
  if (
    order.allowBackorder === true &&
    incomingUnits >= shortfallUnits &&
    inventory.incomingRestockAt
  ) {
    return allocated(
      sku,
      availableUnits,
      shortfallUnits,
      inventory.warehouseId ?? null,
      new Date(inventory.incomingRestockAt).toISOString()
    );
  }

  return blocked(sku, 'insufficient_available_inventory', availableUnits);
}

function shipAt(now, serviceLevel, rules) {
  const nowDate = new Date(now);
  const cutoffHour = rules.cutoffHourLocal ?? 15;
  const shipDelayDays = nowDate.getUTCHours() >= cutoffHour ? 1 : 0;
  const transitDays = serviceLevel === 'express' ? 1 : 3;
  return new Date(
    nowDate.getTime() + (shipDelayDays + transitDays) * 86_400_000
  ).toISOString();
}

function allocated(
  sku,
  allocatedUnits,
  backorderedUnits,
  warehouseId,
  expectedShipAt
) {
  return {
    status: backorderedUnits > 0 ? 'partial_backorder' : 'allocated',
    reason: null,
    sku,
    allocatedUnits,
    backorderedUnits,
    warehouseId,
    expectedShipAt
  };
}

function blocked(sku, reason, availableUnits = 0) {
  return {
    status: 'blocked',
    reason,
    sku,
    allocatedUnits: 0,
    backorderedUnits: 0,
    availableUnits,
    warehouseId: null,
    expectedShipAt: null
  };
}

module.exports = { allocateWarehouseInventory };
