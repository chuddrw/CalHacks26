// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCart } from '../cart/cart';
import { mountCart } from '../cart/cartView';
import type { Product } from '../contracts/product';
import { mountCartRemoval, removeItem } from './removal';

const mug: Product = { id: 'mug', name: 'Mug', description: '', image: '', priceCents: 1299 };
const bag: Product = { id: 'bag', name: 'Bag', description: '', image: '', priceCents: 2000 };
afterEach(() => document.body.replaceChildren());

function setup() {
  const cart = createCart();
  const root = document.createElement('div');
  document.body.append(root);
  const removal = mountCartRemoval(root, cart);
  const checkout = vi.fn();
  const unmount = mountCart(root, cart, { openCheckout: checkout, afterRender: removal.afterRender });
  return { cart, root, removal, unmount, checkout };
}

describe('cart removal', () => {
  it('removes all units of a product and updates the shared total', () => {
    const { cart, root } = setup();
    cart.addItem(mug);
    cart.addItem(mug);
    cart.addItem(bag);
    root.querySelector<HTMLButtonElement>('[data-cart-remove="mug"]')!.click();
    expect(cart.getItems()).toEqual([{ product: bag, quantity: 1 }]);
    expect(cart.getTotalCents()).toBe(2000);
    expect(root.querySelector('[data-cart-total]')!.textContent).toBe('$20.00');
    expect(root.querySelector('[data-cart-row][data-product-id="mug"]')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-cart-remove="bag"]'));
  });

  it('removing the final product shows the empty state and disables checkout', () => {
    const { cart, root, checkout } = setup();
    cart.addItem(mug);
    root.querySelector<HTMLButtonElement>('[data-cart-remove]')!.click();
    expect(cart.getTotalCents()).toBe(0);
    expect(cart.getItems()).toEqual([]);
    expect(root.querySelector('[data-cart-empty]')!.textContent).toBe('Your cart is empty.');
    const button = root.querySelector<HTMLButtonElement>('[data-cart-checkout]')!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(checkout).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(root.querySelector('[data-cart-empty]'));
  });

  it('unknown product IDs leave the cart intact without notifying subscribers', () => {
    const cart = createCart();
    cart.addItem(mug);
    const listener = vi.fn();
    cart.subscribe(listener);
    expect(() => removeItem('unknown', cart)).not.toThrow();
    expect(cart.getItems()).toEqual([{ product: mug, quantity: 1 }]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('restores buttons after later additions and uses safe accessible product labels', () => {
    const { cart, root } = setup();
    const special = { ...mug, id: 'x"[]', name: '<img src=x onerror=alert(1)>' };
    cart.addItem(special);
    cart.addItem(bag);
    const buttons = root.querySelectorAll<HTMLButtonElement>('[data-cart-remove]');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-label')).toBe(`Remove ${special.name} from cart`);
    expect(root.querySelector('img')).toBeNull();
    buttons[0].click();
    expect(cart.getItems()).toEqual([{ product: bag, quantity: 1 }]);
    cart.addItem(mug);
    expect(root.querySelectorAll('[data-cart-remove]')).toHaveLength(2);
  });

  it('unmounting the removal handler stops removal', () => {
    const { cart, root, removal, unmount } = setup();
    cart.addItem(mug);
    removal.destroy();
    root.querySelector<HTMLButtonElement>('[data-cart-remove]')!.click();
    expect(cart.getItems()).toHaveLength(1);
    unmount();
  });
});
