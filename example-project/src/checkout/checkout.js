import { createPaymentFlow } from './payment.js';

const money = cents => {
  // Format integer cents without a floating-point conversion losing a cent.
  const amount = BigInt(cents);
  return `$${(amount / 100n).toLocaleString('en-US')}.${String(amount % 100n).padStart(2, '0')}`;
};

let activeCheckout;

// Mount once at app startup with the real shared cart service:
// initializeCheckout(cartService);
// checkoutButton.addEventListener('click', openCheckout);
export function initializeCheckout(cartService, { root = document.body } = {}) {
  if (activeCheckout) throw new Error('Checkout is already initialized.');
  const flow = createPaymentFlow(cartService);
  const doc = root.ownerDocument;
  const host = doc.createElement('div');
  host.className = 'shop-checkout';
  host.innerHTML = `
    <link rel="stylesheet" href="${new URL('./checkout.css', import.meta.url).href}">
    <p class="checkout-status" role="status" aria-live="polite" tabindex="-1"></p>
    <dialog aria-labelledby="checkout-title" aria-describedby="checkout-notice">
      <form autocomplete="off">
        <div class="checkout-heading">
          <div><p class="checkout-eyebrow">SIMPLE SHOP / CHECKOUT</p><h2 id="checkout-title">One last step.</h2></div>
          <button type="button" class="checkout-close" aria-label="Close checkout">Close</button>
        </div>
        <p id="checkout-notice" class="checkout-notice">Simulated payment. No money will be charged. Use only the test details below.</p>
        <section aria-labelledby="checkout-summary-title">
          <h3 id="checkout-summary-title">Your order</h3>
          <ul class="checkout-items"></ul>
          <p class="checkout-total"><span>Amount to pay</span><strong></strong></p>
          <p class="checkout-caption">USD · No shipping or tax added.</p>
        </section>
        <fieldset>
          <legend>Test payment details</legend>
          <label>Name on card<input name="name" required maxlength="80" autocomplete="off" placeholder="Alex Example"></label>
          <label>Email<input name="email" type="email" required maxlength="254" autocomplete="off" placeholder="alex@example.com"></label>
          <label>Test card number<input name="cardNumber" required inputmode="numeric" maxlength="19" autocomplete="off" placeholder="4242 4242 4242 4242" aria-describedby="checkout-card-hint"></label>
          <span id="checkout-card-hint" class="checkout-caption">Use 4242 4242 4242 4242.</span>
          <div class="checkout-fields">
            <label>Expiry (MM/YY)<input name="expiry" required inputmode="numeric" maxlength="5" pattern="(0[1-9]|1[0-2])/[0-9]{2}" autocomplete="off" placeholder="12/30"></label>
            <label>Test CVC<input name="cvc" required type="password" inputmode="numeric" maxlength="3" pattern="123" autocomplete="off" placeholder="123" aria-describedby="checkout-cvc-hint"></label>
          </div>
          <span id="checkout-cvc-hint" class="checkout-caption">Use CVC 123 and an unexpired date.</span>
        </fieldset>
        <p class="checkout-error" role="alert" tabindex="-1"></p>
        <button class="checkout-submit" type="submit"></button>
      </form>
    </dialog>`;
  root.append(host);
  const $ = selector => host.querySelector(selector);
  const dialog = $('dialog');
  const form = $('form');
  const submit = $('.checkout-submit');
  const error = $('.checkout-error');
  const status = $('.checkout-status');
  const fields = $('fieldset');
  let opener;
  let submitting = false;
  let payLabel = '';

  function reset() {
    flow.cancel();
    form.reset();
    // Also erase values set by autofill or other form integrations.
    for (const input of form.querySelectorAll('input')) input.value = '';
    error.textContent = '';
  }
  function close() {
    reset();
    dialog.close();
  }
  $('.checkout-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => {
    reset();
    if (opener?.isConnected && !opener.disabled) opener.focus();
    else status.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    if (!dialog.open) return;
    if (!form.reportValidity()) return;
    submitting = true;
    error.textContent = '';
    const details = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    submit.textContent = 'Completing demo payment…';
    form.setAttribute('aria-busy', 'true');
    fields.disabled = true;
    try {
      const receipt = await flow.pay(details);
      status.textContent = `Demo payment successful. Paid ${money(receipt.amountCents)}. No money was charged.`;
      close();
      host.dispatchEvent(new CustomEvent('checkout:success', { bubbles: true, detail: receipt }));
    } catch (failure) {
      if (dialog.open) {
        error.textContent = failure instanceof Error ? failure.message : 'Payment could not be completed.';
        error.focus();
      }
    } finally {
      // Do not retain any form details in closures after this attempt.
      for (const key of Object.keys(details)) delete details[key];
      submitting = false;
      submit.disabled = false;
      submit.textContent = payLabel;
      fields.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
  const api = {
    openCheckout() {
      if (dialog.open || submitting) return false;
      status.textContent = '';
      try {
        const summary = flow.open();
        opener = doc.activeElement;
        form.reset();
        error.textContent = '';
        const rows = summary.items.map(({ product, quantity }) => {
          const row = doc.createElement('li');
          const name = doc.createElement('span');
          const price = doc.createElement('strong');
          // Cart values are text, never HTML.
          name.textContent = `${product.name} × ${quantity}`;
          // Show the unit price; the cart service owns all total calculations.
          price.textContent = `${money(product.priceCents)} each`;
          row.append(name, price);
          return row;
        });
        $('.checkout-items').replaceChildren(...rows);
        $('.checkout-total strong').textContent = money(summary.totalCents);
        payLabel = `Pay ${money(summary.totalCents)} — demo`;
        submit.textContent = payLabel;
        dialog.showModal();
        $('[name="name"]').focus();
        return true;
      } catch (failure) {
        flow.cancel();
        status.textContent = failure instanceof Error ? failure.message : 'Checkout is unavailable.';
        return false;
      }
    },
    destroy() {
      close();
      host.remove();
      if (activeCheckout === api) activeCheckout = undefined;
    },
  };
  activeCheckout = api;
  return api;
}

export function openCheckout() {
  if (!activeCheckout) throw new Error('Call initializeCheckout(cartService) before openCheckout().');
  return activeCheckout.openCheckout();
}
