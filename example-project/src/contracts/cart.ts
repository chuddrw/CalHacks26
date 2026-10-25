/**
 * src/contracts/cart.ts
 *
 * WHAT IT'S FOR
 *   The cart contract shared by the catalog (adds items), removal (removes items) and checkout
 *   (reads items and the total, clears the cart after payment). There is one cart state, owned by
 *   src/cart/cart.ts. Every other feature changes it through this interface only.
 *   All money is integer USD cents.
 *
 * OWNER: agent a (cart). Product comes from b's src/contracts/product.ts.
 */
import type { Product } from "./product";

export interface CartItem {
  product: Product;
  /** Whole units, always >= 1 while the item is in the cart. */
  quantity: number;
}

export type CartListener = (items: readonly CartItem[]) => void;

export interface CartService {
  /** Adds one unit. Adding a product already in the cart increases its quantity. */
  addItem(product: Product): void;
  /** A copy of the cart items, in the order they were first added. */
  getItems(): CartItem[];
  /** Sum of priceCents * quantity over all items, in integer USD cents. */
  getTotalCents(): number;
  /** Empties the cart. */
  clearCart(): void;
  /**
   * The shared update mechanism (for removal and similar features): receives a copy of the
   * items and returns the new list. Items with quantity < 1 are dropped. Listeners are notified.
   */
  updateItems(update: (items: CartItem[]) => CartItem[]): void;
  /** Called after every change with the new items. Returns an unsubscribe function. */
  subscribe(listener: CartListener): () => void;
}
