// Typed payment boundary: receipts contain no payment or contact details.
import type { CartItem, CartService } from '../contracts/cart';
export interface PaymentDetails {
  name: string;
  email: string;
  cardNumber: string;
  expiry: string;
  cvc: string;
}
export interface Receipt { amountCents: number; currency: 'USD'; simulated: true }
export function validatePayment(details: PaymentDetails, now?: Date): void;
export function createPaymentFlow(service: Pick<CartService, 'getItems' | 'getTotalCents' | 'clearCart'>): {
  open(): { items: CartItem[]; totalCents: number };
  cancel(): void;
  pay(details: PaymentDetails): Promise<Receipt>;
};
