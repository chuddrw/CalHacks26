// TypeScript integration for the existing native JavaScript checkout module.
import type { CartService } from '../contracts/cart';

export interface CheckoutController {
  openCheckout(): boolean;
  destroy(): void;
}
export function initializeCheckout(
  service: Pick<CartService, 'getItems' | 'getTotalCents' | 'clearCart'>,
  options?: { root?: HTMLElement },
): CheckoutController;
export function openCheckout(): boolean;
