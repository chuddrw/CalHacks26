// @vitest-environment happy-dom
// Exercise the real catalog, cart service/view, and payment form as one app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCart } from '../cart/cart';
import { mountCart } from '../cart/cartView';
import { mountCatalog } from '../catalog/catalog';
import { initializeCheckout, openCheckout, type CheckoutController } from './checkout.js';
import type { CartService } from '../contracts/cart';
import type { Product } from '../contracts/product';

const product: Product = { id: 'mug', name: 'Mug', description: 'Stoneware', image: '/mug.svg', priceCents: 1499 };
let cart: CartService;
let checkout: CheckoutController;
let unmount: () => void;
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fill(overrides: Partial<Record<string, string>> = {}) {
  const values = { name: 'Alex Example', email: 'alex@example.com', cardNumber: '4242 4242 4242 4242', expiry: '12/99', cvc: '123', ...overrides };
  for (const [name, value] of Object.entries(values)) $<HTMLInputElement>(`input[name="${name}"]`).value = value ?? '';
}
function submit() {
  $('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
function addAndOpen() {
  $('[data-product-id="mug"]').click();
  $('[data-cart-checkout]').click();
}

beforeEach(() => {
  document.body.innerHTML = '<main><div id="catalog"></div><div id="cart"></div></main>';
  cart = createCart();
  checkout = initializeCheckout(cart);
  unmount = mountCart($('#cart'), cart, { openCheckout });
  mountCatalog($('#catalog'), [product], p => cart.addItem(p));
});
afterEach(() => {
  unmount();
  checkout.destroy();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('shared shopping app checkout', () => {
  it('adds catalog items to one cart, pays the exact total, and rerenders the empty cart', async () => {
    const cleared = vi.spyOn(cart, 'clearCart');
    const receipt = vi.fn();
    document.body.addEventListener('checkout:success', receipt, { once: true });
    $('[data-product-id="mug"]').click();
    $('[data-product-id="mug"]').click();
    expect(cart.getItems()[0].quantity).toBe(2);
    expect($('#cart').textContent).toContain('$29.98');
    $('[data-cart-checkout]').click();
    expect($<HTMLDialogElement>('dialog').open).toBe(true);
    expect($('.checkout-total strong').textContent).toBe('$29.98');
    fill();
    submit();
    submit();
    expect($<HTMLButtonElement>('.checkout-submit').disabled).toBe(true);
    await tick();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(cart.getItems()).toEqual([]);
    expect($('#cart').textContent).toContain('Your cart is empty.');
    expect($<HTMLButtonElement>('[data-cart-checkout]').disabled).toBe(true);
    expect($('.checkout-status').textContent).toContain('Paid $29.98');
    expect($<HTMLDialogElement>('dialog').open).toBe(false);
    expect(receipt.mock.calls[0][0].detail).toEqual({ amountCents: 2998, currency: 'USD', simulated: true });
    expect([...document.querySelectorAll('input')].every(input => input.value === '')).toBe(true);
  });

  it.each([{ expiry: '12/20' }, { cardNumber: '4111111111111111' }, { email: 'invalid' }, { cvc: '999' }, { name: '' }])('preserves cart after invalid details: %j', async invalid => {
    addAndOpen();
    fill(invalid);
    submit();
    await tick();
    expect(cart.getTotalCents()).toBe(1499);
    expect($<HTMLDialogElement>('dialog').open).toBe(true);
    fill();
    submit();
    await tick();
    expect(cart.getItems()).toEqual([]);
  });

  it('clears payment fields on cancel and reopens with the preserved cart', async () => {
    addAndOpen();
    fill();
    $('.checkout-close').click();
    await tick();
    expect(cart.getTotalCents()).toBe(1499);
    expect([...document.querySelectorAll('input')].every(input => input.value === '')).toBe(true);
    expect(openCheckout()).toBe(true);
    expect($('.checkout-total strong').textContent).toBe('$14.99');
  });

  it('blocks checkout with an empty cart, even when invoked directly', () => {
    expect($<HTMLButtonElement>('[data-cart-checkout]').disabled).toBe(true);
    expect(openCheckout()).toBe(false);
    expect($<HTMLDialogElement>('dialog').open).toBe(false);
    expect($('.checkout-status').textContent).toContain('empty');
  });

  it('formats the exact amount even at the safe integer cents boundary', async () => {
    cart.addItem({ ...product, priceCents: Number.MAX_SAFE_INTEGER });
    openCheckout();
    expect($('.checkout-total strong').textContent).toBe('$90,071,992,547,409.91');
    fill();
    submit();
    await tick();
    expect($('.checkout-status').textContent).toContain('Paid $90,071,992,547,409.91');
  });

  it('preserves a changed cart and requires review before payment', async () => {
    addAndOpen();
    cart.addItem(product);
    fill();
    submit();
    await tick();
    expect(cart.getTotalCents()).toBe(2998);
    expect($('.checkout-error').textContent).toContain('cart changed');
    $('.checkout-close').click();
    await tick();
    openCheckout();
    expect($('.checkout-total strong').textContent).toBe('$29.98');
  });

  it('does not send or persist card details', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const logging = vi.spyOn(console, 'log');
    addAndOpen();
    fill();
    submit();
    await tick();
    expect(cart.getItems()).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(logging).not.toHaveBeenCalled();
  });
});
