'use strict';

const carton = require('../public/shared/carton');
const codeKey = value => String(value ?? '').trim().toLocaleLowerCase('vi');
const locationKey = value => String(value ?? '').replace(/\s+/gu, '').toLocaleUpperCase('vi');

function makeAllocationSnapshot(row, plannedQty) {
  const spec = carton.parseSpec(row.notes);
  if (!spec || !Number.isSafeInteger(spec.quantity)) return null;
  const stText = carton.pickText(spec, plannedQty);
  if (!stText) return null;
  // pickText has the same carton syntax as notes, including its final excess.
  const printed = carton.parseSpec(stText);
  if (!printed || printed.quantity !== plannedQty) return null;
  return {
    schemaVersion: 1, codeKey: codeKey(row.code), locationKey: locationKey(row.location),
    positionVersion: row.version, notes: row.notes, terms: spec.terms, loose: spec.loose,
    plannedQty, stText, stCartons: carton.cartonsFor(spec, plannedQty),
    pickTerms: printed.terms.map(({perCarton, cartons}) => ({perCarton, cartons})), excess: printed.loose
  };
}

function allocationMatches(snapshot, row) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !row ||
      snapshot.codeKey !== codeKey(row.code) || snapshot.locationKey !== locationKey(row.location) ||
      !Number.isSafeInteger(snapshot.plannedQty) || snapshot.plannedQty <= 0) return false;
  const spec = carton.parseSpec(row.notes);
  if (!spec || !Number.isSafeInteger(spec.quantity) || spec.quantity < snapshot.plannedQty ||
      !Array.isArray(snapshot.pickTerms) || !snapshot.pickTerms.length ||
      !Number.isSafeInteger(snapshot.excess) || snapshot.excess < 0) return false;
  let printedTotal = 0;
  for (const pick of snapshot.pickTerms) {
    if (!Number.isSafeInteger(pick.cartons) || pick.cartons <= 0 ||
        !Number.isSafeInteger(pick.perCarton) || pick.perCarton <= 0) return false;
    const available = spec.terms.find(term => term.perCarton === pick.perCarton);
    if (!available || available.cartons < pick.cartons) return false;
    printedTotal += pick.cartons * pick.perCarton;
  }
  return Number.isSafeInteger(printedTotal) && printedTotal - snapshot.excess === snapshot.plannedQty;
}

function deductAllocation(snapshot, row, { allowNegative = false } = {}) {
  if (!row) return null;
  const spec = carton.parseSigned(row.notes);
  if (!spec || !Number.isSafeInteger(spec.quantity)) return null;
  if (!allocationMatches(snapshot, row)) {
    if (!allowNegative || !snapshot || !allocationMatches(snapshot, {...row, notes: snapshot.notes}) ||
        spec.quantity >= snapshot.plannedQty ||
        !Number.isSafeInteger(spec.quantity - snapshot.plannedQty)) return null;
    if (spec.quantity > 0 && !spec.terms.every(term =>
      snapshot.terms?.some(original => original.perCarton === term.perCarton))) return null;
    return carton.subtractNotes(row.notes, snapshot.plannedQty, snapshot.pickTerms[0].perCarton);
  }
  // Follow the original whole-carton plan even if a different combination has
  // since become preferable. Partial picks retain the existing loose notation.
  if (spec.loose === 0 && snapshot.excess === 0) {
    const terms = spec.terms.map(term => ({...term,
      cartons: term.cartons - (snapshot.pickTerms.find(p => p.perCarton === term.perCarton)?.cartons || 0)
    }));
    const text = carton.formatSpec({terms, loose: 0});
    return {text, spec: carton.parseSpec(text), taken: snapshot.stCartons};
  }
  // Do not re-optimize a partial plan against newly added carton sizes: the
  // warehouse still follows the original printed carton(s) and their excess.
  const text = carton.formatSpec({terms: spec.terms, loose: spec.loose + snapshot.plannedQty});
  return {text, spec: carton.parseSpec(text), taken: snapshot.stCartons};
}

module.exports = {makeAllocationSnapshot, allocationMatches, deductAllocation};
