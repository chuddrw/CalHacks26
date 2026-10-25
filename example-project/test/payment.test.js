import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentFlow, validatePayment } from '../src/checkout/payment.js';

const valid = () => ({
  name: 'Alex Example', email: 'alex@example.com',
  cardNumber: '4242 4242 4242 4242', expiry: '12/99', cvc: '123',
});

function setup() {
  // Test double only: production checkout receives the actual shared cart service.
  let items = [{ product: { id: 'mug', name: 'Mug', priceCents: 1499 }, quantity: 2 }];
  let total = 2998;
  let clears = 0;
  const cart = {
    getItems: () => items,
    getTotalCents: () => total,
    clearCart: () => { items = []; total = 0; clears++; },
  };
  return {
    flow: createPaymentFlow(cart), cart,
    clears: () => clears,
    change: (nextItems, nextTotal) => { items = nextItems; total = nextTotal; },
  };
}

test('successful checkout displays the cart total exactly and clears once', async () => {
  const { flow, cart, clears } = setup();
  assert.equal(flow.open().totalCents, 2998);
  assert.deepEqual(await flow.pay(valid()), { amountCents: 2998, currency: 'USD', simulated: true });
  assert.deepEqual(cart.getItems(), []);
  assert.equal(clears(), 1);
  await assert.rejects(flow.pay(valid()), /Open checkout/);
});

test('validation rejects missing fields, invalid email, real cards and wrong CVC without clearing', async () => {
  for (const invalid of [
    { name: '' }, { email: '' }, { email: 'invalid' }, { cardNumber: '' },
    { cardNumber: '4111111111111111' }, { expiry: '' }, { expiry: '13/99' },
    { expiry: '12/20' }, { cvc: '' }, { cvc: '999' },
  ]) {
    const { flow, clears, cart } = setup();
    flow.open();
    await assert.rejects(flow.pay({ ...valid(), ...invalid }));
    assert.equal(clears(), 0);
    assert.equal(cart.getItems().length, 1);
    // A validation error does not close checkout; corrected details can be submitted.
    await flow.pay(valid());
    assert.equal(clears(), 1);
  }
});

test('expiry remains valid through the end of its month', () => {
  const now = new Date(2030, 5, 30, 23, 59);
  assert.doesNotThrow(() => validatePayment({ ...valid(), expiry: '06/30' }, now));
  assert.throws(() => validatePayment({ ...valid(), expiry: '05/30' }, now), /unexpired/);
});

test('cancellation preserves the cart and permits reopening', async () => {
  const { flow, cart, clears } = setup();
  flow.open();
  flow.cancel();
  assert.equal(clears(), 0);
  assert.equal(cart.getItems().length, 1);
  await assert.rejects(flow.pay(valid()), /Open checkout/);
  assert.equal(flow.open().totalCents, 2998);
});

test('cancellation during submission never clears the cart', async () => {
  const { flow, clears } = setup();
  flow.open();
  const pending = flow.pay(valid());
  flow.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.equal(clears(), 0);
});

test('empty carts cannot open checkout', () => {
  const { flow, change } = setup();
  change([], 0);
  assert.throws(() => flow.open(), /empty/);
});

test('duplicate submissions cannot clear twice', async () => {
  const { flow, clears } = setup();
  flow.open();
  const first = flow.pay(valid());
  await assert.rejects(flow.pay(valid()), /already in progress/);
  await first;
  assert.equal(clears(), 1);
});

test('changed cart requires another review before payment', async () => {
  const { flow, change, clears } = setup();
  flow.open();
  change([{ product: { id: 'mug', name: 'Mug', priceCents: 1499 }, quantity: 3 }], 4497);
  await assert.rejects(flow.pay(valid()), /cart changed/);
  assert.equal(clears(), 0);
  assert.equal(flow.open().totalCents, 4497);
  await flow.pay(valid());
  assert.equal(clears(), 1);
});

test('checkout trusts the shared total rather than recomputing it', async () => {
  const { flow, change } = setup();
  change([{ product: { id: 'sample', name: 'Sample', priceCents: 100 }, quantity: 1 }], 75);
  assert.equal(flow.open().totalCents, 75);
  assert.equal((await flow.pay(valid())).amountCents, 75);
});

test('invalid cart totals and service contracts are rejected', () => {
  assert.throws(() => createPaymentFlow({}), /getItems/);
  const { flow, change } = setup();
  change([{ product: { id: 'x', priceCents: 100 }, quantity: 1 }], NaN);
  assert.throws(() => flow.open(), /total is invalid/);
});
