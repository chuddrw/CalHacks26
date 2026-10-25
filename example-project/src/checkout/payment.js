// Payment owns no cart state. The cart service remains the source of prices.
/**
 * @typedef {{product: {id: string|number, name: string, description: string,
 * image: string, priceCents: number}, quantity: number}} CartItem
 * @typedef {{getItems(): CartItem[], getTotalCents(): number, clearCart(): void}} CartService
 */
export function validatePayment(details, now = new Date()) {
  if (!String(details.name ?? '').trim()) throw new Error('Enter the name on the card.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(details.email ?? '').trim())) {
    throw new Error('Enter a valid email address.');
  }
  if (String(details.cardNumber ?? '').replace(/\s/g, '') !== '4242424242424242') {
    throw new Error('Use test card 4242 4242 4242 4242.');
  }
  const expiry = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(String(details.expiry ?? '').trim());
  if (!expiry) throw new Error('Enter expiry as MM/YY.');
  const month = Number(expiry[1]);
  const year = 2000 + Number(expiry[2]);
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
    throw new Error('Enter an unexpired date.');
  }
  if (details.cvc !== '123') throw new Error('Use test CVC 123.');
}

/** @param {CartService} cartService */
export function createPaymentFlow(cartService) {
  for (const method of ['getItems', 'getTotalCents', 'clearCart']) {
    if (typeof cartService?.[method] !== 'function') {
      throw new TypeError(`Cart service must expose ${method}().`);
    }
  }
  let opened = false;
  let busy = false;
  let session = 0;
  let summary;

  function readCart() {
    const items = cartService.getItems();
    const totalCents = cartService.getTotalCents();
    if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty.');
    if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
      throw new Error('The cart total is invalid.');
    }
    return {
      items: items.map(({ product, quantity }) => {
        if (!product || !Number.isSafeInteger(quantity) || quantity < 1
          || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0
          || !Number.isSafeInteger(product.priceCents * quantity)) {
          throw new Error('A cart item is invalid.');
        }
        return { product: { ...product }, quantity };
      }),
      totalCents,
    };
  }

  return {
    open() {
      if (busy) throw new Error('Payment is already in progress.');
      summary = readCart();
      opened = true;
      session++;
      return summary;
    },
    cancel() {
      opened = false;
      summary = undefined;
      session++;
    },
    async pay(details) {
      if (busy) throw new Error('Payment is already in progress.');
      if (!opened) throw new Error('Open checkout before paying.');
      busy = true;
      const attempt = session;
      try {
        validatePayment(details);
        // Validation is synchronous; payment never needs card or contact details afterward.
        details = undefined;
        // No network request: the yield permits cancellation and locks out double clicks.
        await Promise.resolve();
        if (!opened || session !== attempt) throw new Error('Payment was cancelled.');
        const current = readCart();
        if (JSON.stringify(current) !== JSON.stringify(summary)) {
          throw new Error('Your cart changed. Close and reopen checkout to review it.');
        }
        const receipt = { amountCents: current.totalCents, currency: 'USD', simulated: true };
        cartService.clearCart();
        opened = false;
        summary = undefined;
        return receipt;
      } finally {
        details = undefined;
        busy = false;
      }
    },
  };
}
