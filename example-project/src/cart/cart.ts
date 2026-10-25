/**
 * src/cart/cart.ts
 *
 * WHAT IT'S FOR
 *   The single shared cart state. The catalog calls addItem, removal calls updateItems, checkout
 *   reads getItems/getTotalCents and calls clearCart. Views re-render through subscribe.
 *   Prices are integer USD cents.
 *
 * OWNER: agent a (cart).
 */
import type { Product } from "../contracts/product";
import type { CartItem, CartListener, CartService } from "../contracts/cart";

export function createCart(): CartService {
  let items: CartItem[] = [];
  const listeners = new Set<CartListener>();

  const copy = (list: readonly CartItem[]): CartItem[] =>
    list.map((item) => ({ product: { ...item.product }, quantity: item.quantity }));

  function commit(next: CartItem[]): void {
    items = next.filter((item) => Number.isInteger(item.quantity) && item.quantity >= 1);
    const snapshot = copy(items);
    for (const listener of listeners) listener(snapshot);
  }

  return {
    addItem(product: Product): void {
      if (!Number.isInteger(product.priceCents) || product.priceCents < 0) {
        throw new Error(`priceCents must be a non-negative integer, got ${product.priceCents}`);
      }
      const existing = items.find((item) => item.product.id === product.id);
      commit(
        existing
          ? items.map((item) =>
              item === existing ? { ...item, quantity: item.quantity + 1 } : item,
            )
          : [...items, { product: { ...product }, quantity: 1 }],
      );
    },
    getItems: () => copy(items),
    getTotalCents: () =>
      items.reduce((sum, item) => sum + item.product.priceCents * item.quantity, 0),
    clearCart: () => commit([]),
    updateItems(update) {
      commit(update(copy(items)));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The one cart the whole site shares. */
export const cart: CartService = createCart();

export const addItem = (product: Product): void => cart.addItem(product);
export const getItems = (): CartItem[] => cart.getItems();
export const getTotalCents = (): number => cart.getTotalCents();
export const clearCart = (): void => cart.clearCart();
export const updateItems = (update: (items: CartItem[]) => CartItem[]): void =>
  cart.updateItems(update);
export const subscribe = (listener: CartListener): (() => void) => cart.subscribe(listener);
