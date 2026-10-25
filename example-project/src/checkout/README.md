# Checkout integration

The app uses native JavaScript modules. Checkout owns only the dialog and simulated payment, and receives the shared cart service from the app:

```js
import { cart as cartService } from '../cart/cart';
import { initializeCheckout, openCheckout } from './checkout/checkout.js';

const checkout = initializeCheckout(cartService);
document.querySelector('[data-checkout]').addEventListener('click', openCheckout);
// Call checkout.destroy() if the app unmounts this integration.
```

The cart must expose synchronous `getItems()`, `getTotalCents()`, and `clearCart()` methods. Items follow `{ product: { id, name, description, image, priceCents }, quantity }`. Checkout reads a temporary order snapshot for review, uses the service's integer USD total without adding tax or shipping, and requires another review if the cart changes before submission. It does not own or persist cart state.

Only card `4242 4242 4242 4242`, CVC `123`, and an unexpired `MM/YY` date are accepted. No payment request is made. Card fields remain in the dialog only while it is open and are erased on every close. A successful payment clears the cart once, displays the paid amount, and emits a bubbling `checkout:success` event containing only `{ amountCents, currency: 'USD', simulated: true }`. Cancellation and failed validation leave the cart intact.

The shopping app mounts this integration in `src/main.ts`: the catalog adds to the shared `cart` instance, the cart view subscribes to that same instance, and its checkout button calls `openCheckout()`. Run `npm start` to use the full app. The standalone `test/checkout-preview.html` remains a test fixture only.

Run `npm test` for payment behavior tests and DOM integration checks using the real cart and catalog modules. The preview includes an optional browser verification runner for form interaction and cleanup.
